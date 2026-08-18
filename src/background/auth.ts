import { STORAGE_KEYS } from "../shared/constants";

// The extension never embeds the Firebase JS SDK. A consultant authenticates
// once via the Consultant web app, which hands the extension a short-lived
// Firebase ID token; the background worker exchanges that for a Backend-minted
// extension-session token (POST /extension/auth) and stores only that token.

export async function getSessionToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.extensionSessionToken);
  return result[STORAGE_KEYS.extensionSessionToken] ?? null;
}

export async function setSessionToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.extensionSessionToken]: token });
}

export async function clearSessionToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.extensionSessionToken);
}
