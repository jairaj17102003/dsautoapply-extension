/**
 * AskJobs Apply with Autofill — background service worker.
 *
 * Owns three things content scripts never touch directly:
 *  - the extension's personal access token (PAT)
 *  - the job/resume handoff from askjobs.ai (externally_connectable)
 *  - all API calls to the AskJobs backend (centralized here so the raw PAT
 *    never has to be passed into a content script's page-adjacent context)
 */

// TODO: point at the production Backend URL once deployed.
const API_BASE = "http://localhost:4000";

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
    // Allows Firebase Storage (prod STORAGE_DRIVER=firebase) and our own API
    // host (local dev's STORAGE_DRIVER=local serves resume files from the
    // Backend's own /uploads/... static route instead).
    const allowedHostnames = [new URL(API_BASE).hostname, "firebasestorage.googleapis.com"];
    if (!allowedHostnames.includes(parsed.hostname)) {
      return { ok: false, status: 0, error: "URL host not allowed" };
    }

    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, status: response.status, error: `Fetch failed with status ${response.status}` };
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
async function getPendingHandoffs() {
  const { pendingHandoffs } = await chrome.storage.session.get("pendingHandoffs");
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

  // Falls back to the oldest still-unclaimed handoff regardless of hostname.
  // Confirmed real: a "careers.company.com" link is often just a landing
  // page that redirects to the actual ATS platform on a completely
  // different domain (e.g. Timken's careers.timken.com bounces to
  // career8.successfactors.com) — the tab that actually finishes loading
  // frequently has a different hostname than the one recorded when Apply
  // was clicked (job.url, pre-redirect). Since Apply opens exactly one new
  // tab per click, "the oldest thing nobody's claimed yet" is a safe
  // fallback rather than a guess.
  if (!entry) {
    entry = queue.find((h) => h.claimedByTabId == null);
  }

  if (entry && tabId != null) entry.claimedByTabId = tabId;

  await chrome.storage.session.set({ pendingHandoffs: queue });
  return entry || null;
}

// Handoff from the Consultant app when a consultant clicks "Apply".
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ASKJOBS_APPLY_HANDOFF") return;

  (async () => {
    const { candidateId, jobId, resumeVersionId, hostname, companyName, jobTitle } = message;

    const queue = await getPendingHandoffs();
    queue.push({ candidateId, jobId, resumeVersionId, hostname, companyName, jobTitle, receivedAt: Date.now() });
    await chrome.storage.session.set({ pendingHandoffs: queue });

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
          hostname: message.hostname,
          receivedAt: Date.now(),
          claimedByTabId: message.tabId,
        });
        await chrome.storage.session.set({ pendingHandoffs: queue });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: "Unknown message type" });
    }
  })();

  return true; // keep the message channel open for the async response
});
