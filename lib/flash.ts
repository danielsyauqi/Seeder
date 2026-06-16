import type { ToastVariant } from "@/lib/toast";

// One-shot flash messages surfaced after a server-action redirect. The action
// appends ?flash=<key> to its redirect target; the client <FlashToaster/>
// (mounted in the app layout) reads it on navigation, shows the toast, and
// strips the param. This gives success feedback for the form-action flows that
// redirect instead of doing a client fetch.
//
// NOTE: the daily planner uses its own short keys (created/updated/removed/
// assigned) read locally on the /daily pages — those are intentionally NOT in
// this map so the two readers never double-toast the same param.
export const FLASH_MESSAGES: Record<
  string,
  { message: string; variant: ToastVariant }
> = {
  "project-created": { message: "Project created", variant: "success" },
  "project-updated": { message: "Project updated", variant: "success" },
  "project-archived": { message: "Project archived", variant: "success" },
  "project-restored": { message: "Project restored", variant: "success" },
  "project-duplicated": { message: "Project duplicated", variant: "success" },
  "project-deleted": { message: "Project deleted", variant: "success" },
  "slug-updated": { message: "Project key updated", variant: "success" },
  "share-enabled": { message: "Client board published", variant: "success" },
  "share-disabled": { message: "Client board made private", variant: "success" },
  "share-rotated": { message: "Client link rotated", variant: "success" },
  "share-visibility": { message: "Client view updated", variant: "success" },
  "note-saved": { message: "Note saved", variant: "success" },
  "status-published": { message: "Client update published", variant: "success" },
  "status-removed": { message: "Client update deleted", variant: "success" },
  "request-converted": { message: "Converted to task", variant: "success" },
};

export type FlashKey = keyof typeof FLASH_MESSAGES;
