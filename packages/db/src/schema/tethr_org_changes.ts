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

// The org change log (Tinkr, phase 12): every applied modification to an
// agent — rename, mission/budget/subagent/status/schedule change — recorded
// with before/after snapshots so it can be reverted GitHub-style (a revert
// stages the inverse change through the same human approval gate; history is
// append-only, never rewritten).

export const tethrOrgChanges = pgTable(
  "tethr_org_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** The gated tethr_outputs row whose approval applied this change. */
    outputId: uuid("output_id"),
    op: text("op").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    /** The target's tag at the time of the change (pre-rename). */
    targetTag: text("target_tag").notNull(),
    /** Field values before the change — the revert source. */
    before: jsonb("before").$type<Record<string, unknown>>().notNull().default({}),
    /** Field values after the change. */
    after: jsonb("after").$type<Record<string, unknown>>().notNull().default({}),
    /** One-line human summary, e.g. `rename: Radar → Scout`. */
    summary: text("summary").notNull(),
    status: text("status").notNull().default("applied"),
    /** Set when this change IS a revert of an earlier one. */
    revertOfChangeId: uuid("revert_of_change_id"),
    /** Set on the original when a later change reverted it. */
    revertedByChangeId: uuid("reverted_by_change_id"),
    appliedBy: text("applied_by").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyAppliedIdx: index("tethr_org_changes_company_applied_idx").on(
      table.companyId,
      table.appliedAt,
    ),
    companyTargetIdx: index("tethr_org_changes_company_target_idx").on(
      table.companyId,
      table.targetAgentId,
    ),
  }),
);
