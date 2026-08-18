# Extension

Chrome extension (Manifest V3) that runs in the consultant's browser. When a consultant dispatches an `Application` from the Consultant portal's Queue, the extension navigates the career portal, autofills using the Backend-composed fill payload, attaches the correct `ResumeVersion` file, and shows a review/submit overlay (human-in-the-loop by default, per the product's "reviewed and submitted" requirement).

## Status

Phase 0 scaffold: Vite + CRXJS + React + TypeScript build, MV3 manifest, hello-world popup showing connection status, options page for API base URL override, background service worker with a stubbed auth-status message handler. Autofill engine and ATS adapters land in Phase 5.

## Stack

Vite, `@crxjs/vite-plugin` (MV3 HMR), React, TypeScript, Chrome Extension APIs (`chrome.storage`, `chrome.runtime`, `chrome.scripting`).

## Getting started

```bash
npm install
npm run dev      # or `npm run build` then load dist/ as an unpacked extension
```

Load unpacked: `chrome://extensions` -> Developer mode -> Load unpacked -> select `dist/` (after `npm run build`) or the Vite dev output when using `npm run dev` with the CRXJS dev server.

## Planned structure

```
src/
  background/   serviceWorker.ts, auth.ts (extension-session token), apiClient.ts
  content/
    contentScriptEntry.ts
    autofill/    fieldDetector.ts, fillEngine.ts, resumeAttacher.ts        (Phase 5)
      atsAdapters/  workday.ts, greenhouse.ts, lever.ts, generic.ts       (Phase 5+)
    overlay/     StatusOverlay.tsx (review/submit/skip UI)                (Phase 5)
  popup/         Popup.tsx, main.tsx, index.html
  options/       OptionsPage.tsx, main.tsx, index.html
  shared/        types.ts, messaging.ts, constants.ts
manifest.config.ts   MV3 manifest (via @crxjs/vite-plugin defineManifest)
```

## Auth model

The extension never embeds the Firebase JS SDK in the background/content-script context. A consultant authenticates once via the Consultant web app; the extension exchanges a Firebase ID token for a Backend-minted, narrowly-scoped extension-session token (`POST /extension/auth`, Phase 5), stored in `chrome.storage.local` and revocable independently of the web session.

## Build order

Phase 0 (this scaffold) -> Phase 5: `extension/auth`, `GET /queue`, fill-payload fetch, generic label-matching autofill, resume attach, review overlay, event reporting (`POST /applications/:id/events`). ATS-specific adapters (Workday, Greenhouse, Lever) added incrementally after validating against real career portals.

Replace the placeholder files in `public/icons/` with real branded icons before shipping.
