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
import { tethrDivisions } from "./tethr_divisions.js";

export interface TethrRoutingEntry {
  when: string[];
  to: string;
  description?: string;
}

export const tethrAgentProfiles = pgTable(
  "tethr_agent_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    divisionId: uuid("division_id").references(() => tethrDivisions.id, {
      onDelete: "set null",
    }),
    tag: text("tag").notNull(),
    codename: text("codename").notNull(),
    mission: text("mission"),
    approvalGate: text("approval_gate").notNull().default("none"),
    heartbeatCron: text("heartbeat_cron"),
    heartbeatNote: text("heartbeat_note"),
    portPriority: integer("port_priority"),
    routingTable: jsonb("routing_table")
      .$type<TethrRoutingEntry[]>()
      .notNull()
      .default([]),
    standingRules: jsonb("standing_rules")
      .$type<string[]>()
      .notNull()
      .default([]),
    specDriveNodeId: uuid("spec_drive_node_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    agentIdx: uniqueIndex("tethr_agent_profiles_agent_idx").on(table.agentId),
    companyTagIdx: uniqueIndex("tethr_agent_profiles_company_tag_idx").on(
      table.companyId,
      table.tag,
    ),
    companyDivisionIdx: index("tethr_agent_profiles_company_division_idx").on(
      table.companyId,
      table.divisionId,
    ),
  }),
);
