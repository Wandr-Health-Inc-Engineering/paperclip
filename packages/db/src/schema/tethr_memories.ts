import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const tethrMemories = pgTable(
  "tethr_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull().default("fact"),
    content: text("content").notNull(),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("tethr_memories_company_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    companyCreatedIdx: index("tethr_memories_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
