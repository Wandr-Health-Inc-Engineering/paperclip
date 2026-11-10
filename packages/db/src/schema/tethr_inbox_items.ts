import { pgTable, uuid, text, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Files sent to tethr to file or route (phase 26.3): from the Drive's 00 Inbox
// folder, "File this" on a chat upload, or a Slack file. Only the file's name,
// where it is and what tethr suggested are kept, never what's in it.

export interface InboxSuggestion {
  type: string;
  destination: string;
  alternatives: string[];
  notify: string;
  urgency: string;
  confidence: number;
  /** Decision ids per kind (tethr_decisions). */
  decisions: Record<string, string>;
}

export const tethrInboxItems = pgTable(
  "tethr_inbox_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** drive | chat | slack */
    source: text("source").notNull(),
    name: text("name").notNull(),
    /** Where the file is now, relative to 00 Tethr. */
    relPath: text("rel_path").notNull(),
    size: doublePrecision("size").notNull().default(0),
    /** new | needs_person | suggested | filed | left | failed */
    status: text("status").notNull().default("new"),
    suggestion: jsonb("suggestion").$type<InboxSuggestion | null>(),
    /** Why it needs a person (the check on the Mac), or why it failed. */
    note: text("note"),
    filedTo: text("filed_to"),
    filedBy: text("filed_by"),
    /** Where it was before it was filed, so "Put it back" works. */
    filedFrom: text("filed_from"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    /** The main-chat card showing it. */
    cardRunId: uuid("card_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("tethr_inbox_items_company_status_idx").on(table.companyId, table.status, table.createdAt),
  }),
);
