// chrome.runtime message contracts shared between background, content script, and popup.

export type ExtensionMessage =
  | { type: "GET_AUTH_STATUS" }
  | { type: "AUTH_STATUS_RESULT"; authenticated: boolean }
  | { type: "DISPATCH_APPLICATION"; applicationId: string }
  | { type: "APPLICATION_EVENT"; applicationId: string; event: string; details?: unknown };
