import { useEffect, useState } from "react";
import type { ExtensionMessage } from "../shared/messaging";

export function Popup() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const message: ExtensionMessage = { type: "GET_AUTH_STATUS" };
    chrome.runtime.sendMessage(message, (response: ExtensionMessage) => {
      if (response?.type === "AUTH_STATUS_RESULT") setAuthenticated(response.authenticated);
    });
  }, []);

  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>AskJobs Extension</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        {authenticated === null && "Checking connection..."}
        {authenticated === false && "Not connected. Log in from the Consultant portal to link this extension."}
        {authenticated === true && "Connected. Application queue view lands in Phase 5."}
      </p>
    </div>
  );
}
