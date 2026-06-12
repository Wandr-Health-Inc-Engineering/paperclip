import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { tethrSubagents } from "./tethr_subagents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export interface TethrRouteHop {
  layer: "helm" | "agent" | "subagent";
  actorTag: string;
  decision: string;
  reason: string;
  at: string;
}

export const tethrRouteRuns = pgTable(
  "tethr_route_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    requestText: text("request_text").notNull(),
    requestedByUserId: text("requested_by_user_id"),
    invocationSource: text("invocation_source").notNull().default("console"),
    status: text("status").notNull().default("routing"),
    hops: jsonb("hops").$type<TethrRouteHop[]>().notNull().default([]),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    subagentId: uuid("subagent_id").references(() => tethrSubagents.id, {
      onDelete: "set null",
    }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    resultText: text("result_text"),
    error: text("error"),
    llmProvider: text("llm_provider"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("tethr_route_runs_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyStatusIdx: index("tethr_route_runs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
  }),
);
