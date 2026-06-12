import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export interface TethrSubagentNotHereEntry {
  phrase: string;
  to: string;
}

export const tethrSubagents = pgTable(
  "tethr_subagents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    tag: text("tag").notNull(),
    name: text("name").notNull(),
    job: text("job").notNull(),
    routeWhen: jsonb("route_when").$type<string[]>().notNull().default([]),
    notHere: jsonb("not_here")
      .$type<TethrSubagentNotHereEntry[]>()
      .notNull()
      .default([]),
    reads: jsonb("reads").$type<string[]>().notNull().default([]),
    steps: jsonb("steps").$type<string[]>().notNull().default([]),
    output: text("output"),
    guardrails: jsonb("guardrails").$type<string[]>().notNull().default([]),
    doneWhen: text("done_when"),
    escalation: text("escalation"),
    sensitivity: text("sensitivity").notNull().default("internal"),
    status: text("status").notNull().default("ready"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentKeyIdx: uniqueIndex("tethr_subagents_agent_key_idx").on(
      table.agentId,
      table.key,
    ),
    companyTagIdx: uniqueIndex("tethr_subagents_company_tag_idx").on(
      table.companyId,
      table.tag,
    ),
    companyAgentIdx: index("tethr_subagents_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
  }),
);
