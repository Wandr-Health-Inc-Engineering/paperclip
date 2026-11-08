import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Ideas tethr offered on its own (phase 21): from a Slack conversation it heard,
// a goal falling behind, or a quiet stretch. Only the idea and its outcome are
// kept, never the conversation it came from. The outcome feeds the pace engine
// (useful / answered → more ideas; not now / ignored → fewer).

export const tethrIdeas = pgTable(
  "tethr_ideas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** slack | goals | quiet */
    source: text("source").notNull(),
    /** Where it came from, for the card ("#growth", "New customers"). */
    origin: text("origin").notNull().default(""),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Slack conversation it answered into (channel + thread), if any. */
    slackChannel: text("slack_channel"),
    slackThreadTs: text("slack_thread_ts"),
    /** The Ideas-chat turn that wrote it, and the main-chat card showing it. */
    routeRunId: uuid("route_run_id"),
    cardRunId: uuid("card_run_id"),
    /** new | useful | not_now | answered | ignored */
    status: text("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("tethr_ideas_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
