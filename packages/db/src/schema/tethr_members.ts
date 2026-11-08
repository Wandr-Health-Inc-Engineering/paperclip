import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// The people on a tethr team (phase 21). tethr is built to be sold, so the
// company's onboarding records its admin (and, later, invited members) with a
// position: tethr helps each person through that position's focus (a CTO's
// tech fixes for clients, a growth lead's customers). `user_id` links a login
// once tethr is hosted with real accounts; until then a member is a profile.

export const tethrMembers = pgTable(
  "tethr_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    /** A preset key (founder, coo, cto, growth, sales, product) or "other". */
    position: text("position").notNull().default("other"),
    /** The position's title as shown (e.g. "COO", or the free text for other). */
    title: text("title").notNull().default(""),
    /** admin | member */
    role: text("role").notNull().default("member"),
    /** active | invited */
    status: text("status").notNull().default("active"),
    /** The login this member uses, once tethr has real accounts. */
    userId: text("user_id"),
    /** Their Slack member id (U…): names them in conversations tethr hears, and DMs. */
    slackUserId: text("slack_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("tethr_members_company_idx").on(table.companyId),
  }),
);
