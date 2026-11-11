import { companyStore } from "../company-store.js";

// What the Inbox keeps besides its items (phase 26.3), per company, in the
// instance-dir tethr-inbox.json: a profile of each folder (what gets filed
// there, from what people actually file), the filing rules (proposed and
// active), recent corrections that rules are proposed from, and the files in
// the Drive's 00 Inbox folder being watched until they stop changing.

export interface FolderProfile {
  /** A line a person wrote about the folder, if any. */
  description?: string;
  /** The names of the last files filed there (newest last). */
  samples: string[];
}

export interface FilingRule {
  id: string;
  /** In plain words: "Invoices go to 05 Finance / Invoices". */
  text: string;
  type: string;
  destination: string;
  status: "proposed" | "active" | "rejected";
  at: string;
}

export interface InboxState {
  folders?: Record<string, FolderProfile>;
  rules?: FilingRule[];
  /** A person filed somewhere other than Jev's pick: the file's type and where it went. */
  corrections?: Array<{ type: string; destination: string; at: string }>;
  /** Files in 00 Inbox seen but not taken yet (still changing): name → size, mtime, first seen. */
  watching?: Record<string, { size: number; mtimeMs: number; since: number }>;
}

export const inboxStore = companyStore<InboxState>("TETHR_INBOX_FILE", "tethr-inbox.json");

export const SAMPLES_KEPT = 8;

export function activeRules(companyId: string): FilingRule[] {
  return (inboxStore.get(companyId).rules ?? []).filter((r) => r.status === "active");
}
