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

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  const fillBtn = document.getElementById("fill-btn");
  const enableBtn = document.getElementById("enable-site-btn");
  const enableHint = document.getElementById("enable-hint");
  const optionsBtn = document.getElementById("options-btn");

  const { token } = await chrome.runtime.sendMessage({ type: "GET_TOKEN" });
  const connected = !!token;
  optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pattern = tab?.url ? originPatternFor(tab.url) : null;

  function wireFillButton() {
    fillBtn.classList.remove("hidden");
    enableBtn.classList.add("hidden");
    enableHint.classList.add("hidden");
    fillBtn.disabled = !tab?.id || !connected;
    fillBtn.addEventListener(
      "click",
      () => {
        chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_FILL" });
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
