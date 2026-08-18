// Mirrors Backend's docs/openapi.yaml. Hand-kept in sync (the 5 repos are
// intentionally independent, no shared package).

export interface QueuedApplication {
  applicationId: string;
  candidateName: string;
  jobTitle: string;
  company: string;
  applyUrl: string;
  status: "queued" | "dispatched" | "in_progress" | "needs_review" | "submitted" | "confirmed" | "failed";
}

// GET /applications/:id/fill-payload response shape (Phase 5)
export interface FillPayload {
  applicationId: string;
  candidate: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    address?: string;
    linkedin?: string;
    github?: string;
    portfolioUrl?: string;
  };
  eeo: Record<string, string | boolean | undefined>;
  education: unknown[];
  experience: unknown[];
  resumeDownloadUrl: string;
  job: { title: string; company: string; applyUrl: string };
}
