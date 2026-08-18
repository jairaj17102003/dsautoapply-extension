chrome.runtime.onInstalled.addListener(() => {
  console.log("[AskJobs Extension] installed");
});

// Phase 5: handle DISPATCH_APPLICATION messages from the popup — fetch the
// fill payload, open/focus the apply tab, and message the content script to
// run the autofill engine.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_AUTH_STATUS") {
    chrome.storage.local.get("askjobs.extensionSessionToken").then((result) => {
      sendResponse({ type: "AUTH_STATUS_RESULT", authenticated: Boolean(result["askjobs.extensionSessionToken"]) });
    });
    return true; // keep the message channel open for the async response
  }
  return false;
});
