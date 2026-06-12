import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { tethrSubagents } from "./tethr_subagents.js";
import { tethrRouteRuns } from "./tethr_route_runs.js";
import { tethrDriveNodes } from "./tethr_drive.js";

export const tethrOutputs = pgTable(
  "tethr_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    subagentId: uuid("subagent_id").references(() => tethrSubagents.id, {
      onDelete: "set null",
    }),
    routeRunId: uuid("route_run_id").references(() => tethrRouteRuns.id, {
      onDelete: "set null",
    }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("document"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    sensitivity: text("sensitivity").notNull().default("internal"),
    status: text("status").notNull().default("draft"),
    approvalId: uuid("approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    driveNodeId: uuid("drive_node_id").references(() => tethrDriveNodes.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("tethr_outputs_company_status_idx").on(
      table.companyId,
      table.status,
    ),
    companyCreatedIdx: index("tethr_outputs_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    approvalIdx: index("tethr_outputs_approval_idx").on(table.approvalId),
  }),
);
