// Sites outside the built-in allowlist (manifest.json's static
// host_permissions/content_scripts) aren't declined outright — the
// candidate's job data spans 200+ distinct ATS/career-site domains
// (confirmed via a MongoDB query over real job postings), most of them
// one-off custom company career pages with no shared platform. Baking all
// of those into the manifest is both unmaintainable (new ones show up
// constantly) and would trigger a much scarier "reads and changes your
// data on 180+ sites" install warning. Instead, manifest.json declares
// `optional_host_permissions: ["<all_urls>"]`, and THIS popup is the only
// place that can actually request a specific origin from it — Chrome
// requires permissions.request() to run in direct response to a real user
// gesture in a foreground extension surface (a background service worker
// can't do this reliably), which a popup button click satisfies.
function originPatternFor(url) {
  try {
    return `${new URL(url).origin}/*`;
  } catch {
    return null;
  }
}

// Re-injects content-script.js (safe no-op if it's already alive — see its
// own window.__askjobsAutofillInjected guard) then sends it a message.
// Shared by both "Fill this application" and the manual candidate picker —
// either one needs the script actually present in the tab, which a prior
// page reload or step navigation may have wiped out.
async function reinjectThenMessage(tabId, message) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  } catch (error) {
    console.warn("[AskJobs] re-injection failed (page may not allow it):", error);
  }
  chrome.tabs.sendMessage(tabId, message);
}

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  const fillBtn = document.getElementById("fill-btn");
  const enableBtn = document.getElementById("enable-site-btn");
  const enableHint = document.getElementById("enable-hint");
  const optionsBtn = document.getElementById("options-btn");
  const manualSection = document.getElementById("manual-candidate-section");
  const candidateSelect = document.getElementById("candidate-select");
  const resumeVersionSelect = document.getElementById("resume-version-select");
  const manualCandidateBtn = document.getElementById("manual-candidate-btn");
  // Keyed by ResumeVersion._id — looked up on submit for its jobId, since
  // <option value> can only carry one string.
  let resumeVersionsById = {};

  const { token } = await chrome.runtime.sendMessage({ type: "GET_TOKEN" });
  const connected = !!token;
  optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = tab?.url ? originPatternFor(tab.url) : null;

  // Covers a job opened without ever going through the Consultant app's
  // Apply button (clicked through LinkedIn/Indeed/the company's own listing
  // directly) — there's no handoff queued for a tab like that at all, so
  // the content script has no candidate to build context from on its own.
  // Since the extension token already identifies a specific consultant,
  // this lets them pick which of their own candidates to fill for instead.
  // Falls back to the candidate's master resume (no job-specific
  // ResumeVersion exists for this path) via the same logic
  // getResumeFileUrl() already has for that case.
  async function setUpManualCandidatePicker() {
    if (!connected) return;
    manualSection.classList.remove("hidden");

    // 100 is the backend's own hard cap (getPageParams) — a consultant with
    // more candidates than that would need search/pagination here too, not
    // attempted yet since 100 comfortably covers real usage so far.
    const result = await chrome.runtime.sendMessage({ type: "API_FETCH", path: "/api/v1/candidates?limit=100" });
    if (!result?.ok) {
      candidateSelect.innerHTML = '<option value="">Couldn\'t load candidates</option>';
      return;
    }
    const candidates = result.data?.items || [];
    if (candidates.length === 0) {
      candidateSelect.innerHTML = '<option value="">No candidates found</option>';
      return;
    }
    candidateSelect.innerHTML =
      '<option value="">Select a candidate…</option>' +
      candidates
        .map((c) => `<option value="${c._id}">${c.firstName} ${c.lastName} (${c.email})</option>`)
        .join("");
  }

  // Confirmed real gap: the picker used to only ever send candidateId, with
  // no way to say WHICH resume this fill should use — getResumeFileUrl()
  // then had no resumeVersionId to look up and silently fell back to the
  // candidate's master resume, even when a real job-optimized version
  // already existed (just never reachable from here). Common case this
  // fixes: a job.url that's actually a LinkedIn listing — Apply opens
  // LinkedIn first, and only LinkedIn's OWN "Apply" button leads to the
  // real ATS page, so the automatic handoff's tab/hostname tracking never
  // catches up and the consultant reaches for this picker instead.
  //
  // Listed by resume VERSION, not by Application — a candidate can be
  // re-optimized against the same job more than once (v1, v2, ...) without
  // ever re-dispatching, and each version.fileName already encodes exactly
  // what a consultant would want to search for: "FirstName-LastName-
  // Company-vN.docx" (see optimization.worker.js). Typing while this
  // <select> is focused jumps to the first matching option text, so this
  // doubles as the "type the resume name" search the fileName convention
  // was designed to support.
  async function loadResumeVersionsFor(candidateId) {
    resumeVersionSelect.classList.remove("hidden");
    resumeVersionSelect.innerHTML = '<option value="">Loading resumes…</option>';
    const result = await chrome.runtime.sendMessage({
      type: "API_FETCH",
      path: `/api/v1/candidates/${candidateId}/resume-versions`,
    });
    if (!result?.ok) {
      resumeVersionSelect.innerHTML = '<option value="">Use master resume (couldn\'t load resume versions)</option>';
      resumeVersionsById = {};
      return;
    }
    const versions = result.data || [];
    resumeVersionsById = Object.fromEntries(versions.map((v) => [v._id, v]));
    resumeVersionSelect.innerHTML =
      '<option value="">Use master resume (no specific version)</option>' +
      versions.map((v) => `<option value="${v._id}">${v.fileName}</option>`).join("");
  }

  candidateSelect.addEventListener("change", () => {
    manualCandidateBtn.disabled = !candidateSelect.value || !tab?.id;
    if (candidateSelect.value) {
      loadResumeVersionsFor(candidateSelect.value);
    } else {
      resumeVersionSelect.classList.add("hidden");
      resumeVersionsById = {};
    }
  });

  manualCandidateBtn.addEventListener(
    "click",
    async () => {
      const candidateId = candidateSelect.value;
      const selectedVersion = resumeVersionsById[resumeVersionSelect.value];
      const jobId = selectedVersion?.jobId;
      const resumeVersionId = selectedVersion?._id;
      // Persisted (not just messaged to the current script instance) so a
      // reload of this same tab — routine on a multi-step application form —
      // finds this same candidate automatically next time, via the normal
      // handoff path init() already checks, instead of requiring the picker
      // to be redone from scratch after every reload.
      const hostname = tab?.url ? new URL(tab.url).hostname : null;
      if (hostname) {
        await chrome.runtime.sendMessage({
          type: "SET_MANUAL_CANDIDATE_HANDOFF",
          candidateId,
          jobId,
          resumeVersionId,
          hostname,
          tabId: tab.id,
        });
      }
      await reinjectThenMessage(tab.id, { type: "FILL_FOR_CANDIDATE", candidateId, jobId, resumeVersionId });
      window.close();
    },
    { once: true },
  );

  function wireFillButton() {
    fillBtn.classList.remove("hidden");
    enableBtn.classList.add("hidden");
    enableHint.classList.add("hidden");
    fillBtn.disabled = !tab?.id || !connected;
    setUpManualCandidatePicker();
    fillBtn.addEventListener(
      "click",
      async () => {
        // Confirmed real gap: on a site that was only ever manually enabled
        // (not in the built-in content_scripts list), a page reload or the
        // ATS navigating to a new step wipes out the previously-injected
        // script entirely — sendMessage would then go nowhere silently, with
        // no error shown, making "Fill this application" look like it does
        // nothing. reinjectThenMessage re-injects first (safe no-op if
        // already alive) so the message always has something to reach.
        await reinjectThenMessage(tab.id, { type: "TRIGGER_FILL" });
        window.close();
      },
      { once: true }
    );
  }

  if (!tab?.id || !pattern) {
    statusEl.textContent = "Open a job application page first";
    statusEl.className = "status disconnected";
    return;
  }

  if (!connected) {
    statusEl.textContent = "Not connected — add your token in Settings";
    statusEl.className = "status disconnected";
  }

  const alreadyPermitted = await chrome.permissions.contains({ origins: [pattern] });

  if (alreadyPermitted) {
    if (connected) {
      statusEl.textContent = "Connected";
      statusEl.className = "status connected";
    }
    wireFillButton();
    return;
  }

  // Not one of the built-in sites and no permission granted yet for this
  // one — offer to request it, scoped to this exact origin only (never a
  // broader grant than the one site the candidate is actually applying on).
  statusEl.textContent = "This site isn't set up yet";
  statusEl.className = "status disconnected";
  enableBtn.classList.remove("hidden");
  enableHint.classList.remove("hidden");
  enableBtn.disabled = !connected;

  enableBtn.addEventListener("click", async () => {
    enableBtn.disabled = true;
    enableBtn.textContent = "Requesting…";

    const granted = await chrome.permissions.request({ origins: [pattern] });
    if (!granted) {
      enableBtn.textContent = "Enable on this site";
      enableBtn.disabled = false;
      statusEl.textContent = "Permission was declined";
      statusEl.className = "status disconnected";
      return;
    }

    try {
      // The page was already loaded before permission existed, so the
      // declarative content_scripts entry never ran on it — inject it
      // directly into the already-open tab now that we're allowed to.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-script.js"],
      });
    } catch (error) {
      statusEl.textContent = "Couldn't start Autofill on this page — try reloading it";
      statusEl.className = "status disconnected";
      enableBtn.textContent = "Enable on this site";
      enableBtn.disabled = false;
      console.error("[AskJobs] injection after permission grant failed:", error);
      return;
    }

    statusEl.textContent = "Connected to AskJobs";
    statusEl.className = "status connected";
    wireFillButton();
  });
});
