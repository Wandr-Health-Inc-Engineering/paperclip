import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, boolean, integer, index, customType } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Every note tethr ever saved (2026-11-10, Mark: "I don't want a cap like this.
// The system needs to truly be working for months and keep learning"). This
// table is the record and has no ceiling; the always-loaded set (Hermes's
// MEMORY.md / USER.md, or the built-in files) is a curated part of it
// (in_core). Notes outside it are found by Postgres full-text search and pulled
// into a turn when they match. Nothing here is deleted by curation: a note
// moves out of the always-loaded set, or is retired, and stays searchable.

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const tethrMemoryNotes = pgTable(
  "tethr_memory_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** company | people: which always-loaded store it belongs to. */
    target: text("target").notNull().default("company"),
    text: text("text").notNull(),
    /** A growth-map area id, when it belongs to one. */
    area: text("area"),
    /** Who saved it: "@tethr", an agent's tag, a person's name, "Memory page". */
    savedBy: text("saved_by").notNull(),
    threadId: text("thread_id"),
    runId: text("run_id"),
    /** A person asked to keep it in every turn. */
    pinned: boolean("pinned").notNull().default(false),
    /** In the always-loaded set right now. */
    inCore: boolean("in_core").notNull().default(false),
    /** active | retired (kept and searchable, no longer current). */
    status: text("status").notNull().default("active"),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', "text")`),
  },
  (table) => ({
    companyCoreIdx: index("tethr_memory_notes_company_core_idx").on(table.companyId, table.inCore),
    searchIdx: index("tethr_memory_notes_search_idx").using("gin", table.search),
  }),
);
