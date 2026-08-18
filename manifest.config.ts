import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "AskJobs Consultant Extension",
  description: "Autofills and submits job applications on career portals from the AskJobs consultant queue.",
  version: pkg.version,
  icons: {
    16: "public/icons/icon16.png",
    48: "public/icons/icon48.png",
    128: "public/icons/icon128.png",
  },
  action: {
    default_popup: "src/popup/index.html",
  },
  options_page: "src/options/index.html",
  background: {
    service_worker: "src/background/serviceWorker.ts",
    type: "module",
  },
  content_scripts: [
    {
      // Broad match for Phase 5 MVP; narrowed to specific ATS domains as
      // adapters (workday, greenhouse, lever, ...) are added.
      matches: ["<all_urls>"],
      js: ["src/content/contentScriptEntry.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "activeTab", "scripting"],
  host_permissions: ["http://localhost:4000/*"],
});
