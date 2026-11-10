import { pgTable, uuid, text, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Every decision tethr asked Jev for (phase 26.2): the kind, a short label, the
// options, Jev's pick and runner-up, its confidence and cost, and what happened
// next (accepted, corrected to what, done automatically, undone). The content
// that was judged is never stored. The record calibrates each kind's
// confidence bar and decides when a kind may run on its own.

export const tethrDecisions = pgTable(
  "tethr_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** decide/kinds.ts key, e.g. "inbox.destination". */
    kind: text("kind").notNull(),
    /** What was decided about, in a few words (a file name, an agent's report headline). */
    label: text("label").notNull(),
    /** The option labels offered. */
    options: jsonb("options").$type<string[]>().notNull().default([]),
    pick: text("pick").notNull(),
    runnerUp: text("runner_up"),
    confidence: doublePrecision("confidence").notNull(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    /** The kind's mode when it was asked: suggest | auto. */
    mode: text("mode").notNull(),
    /** pending | accepted | corrected | automatic | undone | dropped */
    outcome: text("outcome").notNull().default("pending"),
    correctedTo: text("corrected_to"),
    /** What it's about (an inbox item, a lesson), for finding it again. */
    subjectId: text("subject_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyKindIdx: index("tethr_decisions_company_kind_idx").on(table.companyId, table.kind, table.createdAt),
    subjectIdx: index("tethr_decisions_subject_idx").on(table.subjectId),
  }),
);
