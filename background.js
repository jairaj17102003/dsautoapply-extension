/**
 * AskJobs Apply with Autofill — background service worker.
 *
 * Owns three things content scripts never touch directly:
 *  - the extension's personal access token (PAT)
 *  - the job/resume handoff from askjobs.ai (externally_connectable)
 *  - all API calls to the AskJobs backend (centralized here so the raw PAT
 *    never has to be passed into a content script's page-adjacent context)
 */

// Production Backend, live on the dsautoapply GCP VM behind Nginx/TLS
// (confirmed reachable: https://api.dsautoapply.ai/api/v1/health -> 200).
const API_BASE = "https://api.dsautoapply.ai";

let siteSupportList = null;




async function getSupportedHosts() {
  if (siteSupportList) return siteSupportList;
  const res = await fetch(chrome.runtime.getURL("site-support.json"));
  siteSupportList = await res.json();
  return siteSupportList;
}

function isHostnameSupported(hostname, supportedHosts) {
  if (!hostname) return false;
  return supportedHosts.some(
    (entry) => hostname === entry || hostname.endsWith(`.${entry}`)
  );
}

async function getToken() {
  const { askjobs_pat: token } = await chrome.storage.local.get("askjobs_pat");
  return token || null;
}

async function apiFetch(path, options = {}) {
  const token = await getToken();
  if (!token) {
    return { ok: false, status: 401, error: "Not connected — no extension token saved." };
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

// Same auth as apiFetch, but for a binary response (e.g. GET
// /resume-versions/:id/pdf) instead of JSON — apiFetch's response.json()
// would fail on a PDF body. Returns a data URL like fetchFileAsDataUrl,
// just against our own authenticated API instead of a pre-signed storage
// URL.
async function apiFetchFile(path) {
  const token = await getToken();
  if (!token) {
    return { ok: false, status: 401, error: "Not connected — no extension token saved." };
  }
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = (await response.text()).slice(0, 2000);
      } catch {
        // Body already consumed or unreadable — status/statusText alone still returned below.
      }
      return {
        ok: false,
        status: response.status,
        error: `Fetch failed with status ${response.status} (${response.statusText}): ${bodyText || "<no body>"}`,
      };
    }
    const blob = await response.blob();
    return { ok: true, status: response.status, dataUrl: await blobToDataUrl(blob) };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

async function recordUnsupportedSite(hostname) {
  await apiFetch("/api/v1/extension/telemetry/unsupported-site", {
    method: "POST",
    body: JSON.stringify({ hostname }),
  });
}

// Converts a Blob to a data URL without FileReader (not guaranteed in every
// service worker context) — just arrayBuffer + manual base64 encoding.
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || "application/octet-stream"};base64,${base64}`;
}

// Fetches an arbitrary file (e.g. a resume PDF from Firebase Storage) as a
// data URL. Must happen here, not in the content script: a content script's
// fetch() runs in the page's own origin and is bound by that page's CORS
// policy (Firebase Storage doesn't allow arbitrary third-party ATS origins
// to fetch it directly). The background service worker is a privileged
// extension context where declared host_permissions bypass CORS entirely —
// that's why firebasestorage.googleapis.com is in the manifest's
// host_permissions.
async function fetchFileAsDataUrl(url) {
  try {
    // Defensive allowlist: this proxies whatever URL a message hands it
    // through a privileged, CORS-bypassing fetch. Nothing attacker-controlled
    // reaches this today (the only caller passes a fixed, server-issued
    // resumeFileUrl), but restricting it to the one origin it's actually for
    // means it can never become an open fetch-proxy if that changes later.
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, status: 0, error: "Invalid URL" };
    }
    // Confirmed real (BrassRing resume-attach failure, "URL host not
    // allowed"): Backend/src/config/storage.js's getSignedDownloadUrl uses
    // the Firebase Admin SDK's bucket().getSignedUrl(), which returns a
    // real Google Cloud Storage signed URL on storage.googleapis.com — a
    // completely different domain from firebasestorage.googleapis.com (the
    // CLIENT SDK's public download-URL format, e.g.
    // firebasestorage.googleapis.com/v0/b/{bucket}/o/{path}?alt=media).
    // Every resume download URL this Backend actually issues uses the
    // former, which wasn't in this allowlist at all — resume auto-attach
    // was rejected before it ever reached the actual fetch. Also allows
    // our own API host — the Backend's now-removed STORAGE_DRIVER=local
    // dev fallback used to serve resume files from its own /uploads/...
    // static route this way; kept in case something else on this host
    // ever needs a plain fetch, though nothing currently does.
    const allowedHostnames = [new URL(API_BASE).hostname, "storage.googleapis.com", "firebasestorage.googleapis.com"];
    if (!allowedHostnames.includes(parsed.hostname)) {
      return { ok: false, status: 0, error: "URL host not allowed" };
    }

    const response = await fetch(url);
    if (!response.ok) {
      // A GCS signed-URL failure (expired/invalid signature, wrong bucket,
      // etc.) comes back with a specific error body (XML, usually a
      // <Code>...</Code> like SignatureDoesNotMatch or InvalidArgument) —
      // the bare status alone isn't enough to tell those apart. Bounded to
      // a few KB since this is only ever an error page, never the real
      // file.
      let bodyText = "";
      try {
        bodyText = (await response.text()).slice(0, 2000);
      } catch {
        // Body already consumed or unreadable — status/statusText alone still returned below.
      }
      return {
        ok: false,
        status: response.status,
        error: `Fetch failed with status ${response.status} (${response.statusText}): ${bodyText || "<no body>"}`,
      };
    }
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    return { ok: true, dataUrl };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

// How long an UNCLAIMED handoff stays valid before we give up on it (e.g.
// the tab it was meant for never loaded, or loaded and errored out).
const HANDOFF_TTL_MS = 5 * 60 * 1000;

// Handoffs are a QUEUE, not a single slot — a single shared value meant any
// tab's content script could grab whichever handoff was sitting there
// first, regardless of whether it was actually meant for that tab (e.g.
// applying to two different companies back-to-back, the second tab to load
// would steal the first one's handoff, leaving the first with nothing).
// Each entry is claimed by hostname match instead of "whatever's there."
// Confirmed real (this whole extension's own dev/test cycle): chrome.
// storage.session is documented to clear on every extension reload/update,
// not just on browser/profile restart — during active development that
// means every single "reload extension to pick up a fix" wipes whatever
// was already claimed for the currently-open tab, forcing a full redo of
// the Consultant app's Apply flow just to get a fresh handoff. .local
// persists across reloads (only cleared on uninstall), which is what this
// was always meant to survive — a real end user isn't reloading the
// extension mid-application, so this doesn't change their experience.
async function getPendingHandoffs() {
  const { pendingHandoffs } = await chrome.storage.local.get("pendingHandoffs");
  const now = Date.now();
  // Confirmed real gap: this used to expire EVERY entry after HANDOFF_TTL_MS
  // regardless of claimed status, so a multi-step application taking longer
  // than 5 minutes could lose its own already-in-use handoff on a routine
  // reload partway through, with no way to get it back short of starting
  // over from the Consultant app. Once a tab has actually claimed an entry,
  // it's meant to last that tab's whole session — only still-UNCLAIMED
  // entries (e.g. a tab that never loaded at all) age out.
  return (pendingHandoffs || []).filter((h) => h.claimedByTabId != null || now - h.receivedAt < HANDOFF_TTL_MS);
}

// Bound to the claiming TAB, not consumed on first read — a reload of the
// same tab (Workday's multi-step form and manual refreshes both do this
// routinely) gets the SAME handoff again instead of coming up empty, which
// previously made resume upload look broken on anything but the very first
// load. A DIFFERENT tab (even matching hostname — e.g. two different jobs
// open on the same ATS subdomain) still can't steal an already-claimed
// entry, since it only looks at unclaimed ones.
async function claimPendingHandoff(hostname, tabId) {
  const queue = await getPendingHandoffs();

  let entry = tabId != null ? queue.find((h) => h.claimedByTabId === tabId) : null;

  if (!entry) {
    entry = queue.find((h) => h.hostname === hostname && h.claimedByTabId == null);
  }

  // Falls back to the newest still-unclaimed handoff regardless of hostname.
  // Confirmed real: a "careers.company.com" link is often just a landing
  // page that redirects to the actual ATS platform on a completely
  // different domain (e.g. Timken's careers.timken.com bounces to
  // career8.successfactors.com — or a job.url that's actually a LinkedIn
  // listing, which redirects to the real ATS only after a second, manual
  // "Apply" click on LinkedIn itself) — the tab that actually finishes
  // loading frequently has a different hostname than the one recorded when
  // Apply was clicked (job.url, pre-redirect).
  //
  // NEWEST, not oldest: this used to take queue.find() (the FIRST unclaimed
  // entry in push-order, i.e. the OLDEST) on the assumption that Apply
  // opens exactly one new tab per click, so anything unclaimed must be that
  // one tab's own handoff. That assumption breaks the moment a PREVIOUS
  // attempt's handoff never got claimed at all (the tab was closed before
  // its content script ever ran, or loaded before the extension was
  // reloaded with a fix) — it then sits unclaimed for up to HANDOFF_TTL_MS,
  // and a later, unrelated tab's fallback lookup would silently steal that
  // stale entry instead of the fresh one just pushed for THIS click,
  // reusing an old candidate/resume version with no way to tell.  The most
  // recently pushed unclaimed entry is always the better guess.
  //
  // Confirmed real, serious (Mattel/SmartRecruiters application): this
  // fallback had no recency limit at all — a manual-picker handoff meant
  // for one specific tab (Ford's application, in this case) that never got
  // claimed by that tab for whatever reason (closed early, a mismatched
  // tabId after a reload) sat "unclaimed" in the queue for the rest of its
  // whole HANDOFF_TTL_MS window, and a COMPLETELY UNRELATED tab opened
  // minutes later (Mattel, on a totally different hostname, with its own
  // hostname match correctly finding nothing) silently grabbed it instead
  // — wrong candidate context (jobTitle/companyName) fed straight into the
  // AI answering prompt, producing a Ford-battery-storage cover letter and
  // a wrongly-"Yes" "former Mattel employee" answer on Mattel's own form.
  // The genuine redirect case this fallback exists for (a landing page
  // bouncing to the real ATS) always resolves within a few seconds of the
  // Apply click — an entry old enough to need this fallback at all after
  // that window is far more likely a stale leftover from a different,
  // unrelated tab than it is a slow redirect still in flight.
  const RECENT_FALLBACK_WINDOW_MS = 30 * 1000;
  if (!entry) {
    const now = Date.now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].claimedByTabId == null && now - queue[i].receivedAt < RECENT_FALLBACK_WINDOW_MS) {
        entry = queue[i];
        break;
      }
    }
  }

  if (entry && tabId != null) entry.claimedByTabId = tabId;

  await chrome.storage.local.set({ pendingHandoffs: queue });
  return entry || null;
}

// Remembered so the popup's manual candidate picker (setUpManualCandidatePicker
// in popup.js) can default to whichever candidate was actually applied for
// most recently, instead of a bare "Select a candidate..." every time — the
// common real case this serves is a LinkedIn-sourced job.url, where Apply
// opens LinkedIn first and the automatic handoff's tab/hostname tracking
// never reaches the real career site, so the consultant reaches for this
// picker on every single one of that candidate's applications in a row.
// Updated from both ways a handoff is ever created (below, and
// SET_MANUAL_CANDIDATE_HANDOFF) so it reflects reality regardless of which
// path last ran.
async function setLastUsedCandidate(candidateId) {
  if (!candidateId) return;
  await chrome.storage.local.set({ lastUsedCandidateId: candidateId });
}

// Handoff from the Consultant app when a consultant clicks "Apply".
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ASKJOBS_APPLY_HANDOFF") return;

  (async () => {
    const { candidateId, jobId, resumeVersionId, hostname, companyName, jobTitle } = message;

    const queue = await getPendingHandoffs();
    queue.push({ candidateId, jobId, resumeVersionId, hostname, companyName, jobTitle, receivedAt: Date.now() });
    await chrome.storage.local.set({ pendingHandoffs: queue });
    await setLastUsedCandidate(candidateId);

    // Learn about ATS platforms we don't support yet without ever needing
    // broad host_permissions or running a content script on that domain.
    const supportedHosts = await getSupportedHosts();
    if (hostname && !isHostnameSupported(hostname, supportedHosts)) {
      await recordUnsupportedSite(hostname);
    }

    sendResponse({ received: true });
  })();

  return true; // keep the message channel open for the async response
});

// Internal messages from the content script / popup / options page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_TOKEN": {
        sendResponse({ token: await getToken() });
        break;
      }
      case "SET_TOKEN": {
        await chrome.storage.local.set({ askjobs_pat: message.token });
        sendResponse({ ok: true });
        break;
      }
      case "CLEAR_TOKEN": {
        await chrome.storage.local.remove("askjobs_pat");
        sendResponse({ ok: true });
        break;
      }
      case "GET_PENDING_HANDOFF": {
        // Claimed by hostname match, not "whichever is first in the queue" —
        // a tab only ever consumes a handoff meant for its own company's
        // application, never one meant for a different tab entirely. Bound
        // to sender.tab.id so a reload of this same tab gets it again too.
        const pendingHandoff = await claimPendingHandoff(message.hostname, sender.tab?.id ?? null);
        sendResponse({ pendingHandoff });
        break;
      }
      case "API_FETCH": {
        sendResponse(await apiFetch(message.path, message.options));
        break;
      }
      case "API_FETCH_FILE": {
        sendResponse(await apiFetchFile(message.path));
        break;
      }
      case "FETCH_FILE_AS_DATA_URL": {
        sendResponse(await fetchFileAsDataUrl(message.url));
        break;
      }
      case "IS_SITE_SUPPORTED": {
        const supportedHosts = await getSupportedHosts();
        let supported = isHostnameSupported(message.hostname, supportedHosts);
        // Confirmed real bug: the popup's "Enable on this site" flow grants a
        // runtime host permission and injects this very script via
        // chrome.scripting.executeScript, but init()'s own support check only
        // ever consulted the bundled, static site-support.json list — so a
        // manually-enabled site (by definition NOT in that list) still got
        // immediately rejected here regardless, making "Enable on this site"
        // a dead end for autofill itself (it only ever fed the
        // recordUnsupportedSite telemetry below). A site the user has
        // explicitly been granted runtime permission for is just as
        // legitimate as one in the static list.
        if (!supported && message.origin) {
          try {
            supported = await chrome.permissions.contains({ origins: [`${message.origin}/*`] });
          } catch {
            // Malformed origin — stay unsupported rather than throw.
          }
        }
        sendResponse({ supported });
        break;
      }
      case "SET_MANUAL_CANDIDATE_HANDOFF": {
        // From the popup's candidate picker — covers a job opened without
        // ever going through the Consultant app's Apply button (no handoff
        // was ever queued for this tab at all). Pre-claimed for this exact
        // tab (the popup already knows which tab it's acting on, via
        // chrome.tabs.query — no hostname-matching needed like the real
        // handoff flow), and persisted the same way, so a reload of this
        // same tab finds it automatically via the normal GET_PENDING_HANDOFF
        // path — the consultant shouldn't have to reselect a candidate every
        // time a multi-step application form reloads or re-navigates.
        const queue = await getPendingHandoffs();
        queue.push({
          candidateId: message.candidateId,
          // Optional — set when the popup's picker also resolved a specific
          // in-progress Application for this candidate (see popup.js).
          // Without these, getResumeFileUrl() has no job-specific
          // resumeVersionId to look up and silently falls back to the
          // candidate's master resume — confirmed real, and the actual
          // reason skills/resume content looked wrong on a job that DID
          // have a real optimized resume: the manual picker never carried
          // this through before, even when the consultant had already
          // clicked Apply for this exact job in the Consultant app first.
          jobId: message.jobId,
          resumeVersionId: message.resumeVersionId,
          hostname: message.hostname,
          receivedAt: Date.now(),
          claimedByTabId: message.tabId,
        });
        await chrome.storage.local.set({ pendingHandoffs: queue });
        await setLastUsedCandidate(message.candidateId);
        sendResponse({ ok: true });
        break;
      }
      case "GET_LAST_USED_CANDIDATE": {
        const { lastUsedCandidateId } = await chrome.storage.local.get("lastUsedCandidateId");
        sendResponse({ lastUsedCandidateId: lastUsedCandidateId || null });
        break;
      }
      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();

  return true; // keep the message channel open for the async response
});
