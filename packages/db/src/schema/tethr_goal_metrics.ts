import { pgTable, uuid, text, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

// Numbers for Paperclip's goals (Tethr phase 20). Core goals are a tree of
// titles with a status; Tethr adds what makes a goal measurable: a metric with
// a baseline, a target by a date, the latest value and a short history. The
// `method` says exactly how the number is measured (recorded during the goals
// interview), so every scorecard measures the same way.

export interface TethrMetricPoint {
  at: string;
  value: number;
  note?: string;
}

/** A target tethr moved on its own to keep the goal realistic (phase 21). */
export interface TethrMetricAdjustment {
  at: string;
  from: number;
  to: number;
  /** In plain words, e.g. "the trend points to about 150 by Mar 31". */
  why: string;
}

export const tethrGoalMetrics = pgTable(
  "tethr_goal_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** count | usd | percent | number */
    unit: text("unit").notNull().default("count"),
    /** up = higher is better; down = lower is better (e.g. cost per customer). */
    direction: text("direction").notNull().default("up"),
    /** stripe | posthog | google_ads | manual | other */
    source: text("source").notNull().default("manual"),
    /** How it's measured, in plain words (window, filters, which report). */
    method: text("method").notNull().default(""),
    baseline: doublePrecision("baseline"),
    baselineAt: timestamp("baseline_at", { withTimezone: true }),
    target: doublePrecision("target"),
    targetDate: timestamp("target_date", { withTimezone: true }),
    current: doublePrecision("current"),
    currentAt: timestamp("current_at", { withTimezone: true }),
    history: jsonb("history").$type<TethrMetricPoint[]>().notNull().default([]),
    /** Targets tethr adjusted on its own, newest last (phase 21). */
    adjustments: jsonb("adjustments").$type<TethrMetricAdjustment[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyGoalIdx: index("tethr_goal_metrics_company_goal_idx").on(table.companyId, table.goalId),
  }),
);
