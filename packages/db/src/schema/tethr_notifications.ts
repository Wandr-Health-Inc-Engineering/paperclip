import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const tethrNotifications = pgTable(
  "tethr_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("system"),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    agentTag: text("agent_tag"),
    channel: text("channel").notNull().default("in_app"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyReadIdx: index("tethr_notifications_company_read_idx").on(
      table.companyId,
      table.readAt,
    ),
    companyCreatedIdx: index("tethr_notifications_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
