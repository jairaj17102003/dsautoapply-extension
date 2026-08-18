import { useEffect, useState } from "react";
import { STORAGE_KEYS } from "../shared/constants";

export function OptionsPage() {
  const [apiBaseUrl, setApiBaseUrl] = useState("");

  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEYS.apiBaseUrlOverride).then((result) => {
      setApiBaseUrl(result[STORAGE_KEYS.apiBaseUrlOverride] ?? "");
    });
  }, []);

  const save = () => {
    chrome.storage.local.set({ [STORAGE_KEYS.apiBaseUrlOverride]: apiBaseUrl });
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 480 }}>
      <h1 style={{ fontSize: 18 }}>AskJobs Extension Settings</h1>
      <label style={{ display: "block", fontSize: 13, marginBottom: 8 }}>
        API base URL override (defaults to http://localhost:4000/api/v1)
        <input
          style={{ display: "block", width: "100%", marginTop: 4 }}
          value={apiBaseUrl}
          onChange={(e) => setApiBaseUrl(e.target.value)}
          placeholder="https://api.askjobs-consultant.example.com/api/v1"
        />
      </label>
      <button onClick={save}>Save</button>
    </div>
  );
}
