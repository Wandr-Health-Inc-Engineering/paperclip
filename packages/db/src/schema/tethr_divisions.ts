import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const tethrDivisions = pgTable(
  "tethr_divisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    headAgentId: uuid("head_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("tethr_divisions_company_key_idx").on(
      table.companyId,
      table.key,
    ),
    companyStatusIdx: index("tethr_divisions_company_status_idx").on(
      table.companyId,
      table.status,
    ),
  }),
);
