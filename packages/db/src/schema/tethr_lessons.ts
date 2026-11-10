import { pgTable, uuid, text, timestamp, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// What tethr learned (phase 26.5): one record for lessons from the team, from
// results and from the world (the learner, 26.6). Each has where it's applied,
// the goal it should move, when to look again, and what happened.

export interface LessonSource {
  url: string;
  title: string;
}

export interface LessonScores {
  fit: number | null;
  evidence: number | null;
  usable: number | null;
  novel: number | null;
  /** 0-100 from the four, or null when Jev didn't score it. */
  composite: number | null;
}

export interface LessonApplied {
  /** memory | skill | rule | experiment */
  as: string;
  /** What it became: the memory text, the skill name, the rule text, the task id. */
  ref: string;
  at: string;
}

export const tethrLessons = pgTable(
  "tethr_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /** A growth-map area id, or "general". */
    area: text("area").notNull(),
    lesson: text("lesson").notNull(),
    why: text("why").notNull().default(""),
    howToApply: text("how_to_apply").notNull().default(""),
    /** principle | procedure | rule | experiment: what it would become when applied. */
    applyAs: text("apply_as").notNull().default("principle"),
    sources: jsonb("sources").$type<LessonSource[]>().notNull().default([]),
    /** data | case_study | expert | vendor | team | results */
    evidence: text("evidence").notNull().default("team"),
    scores: jsonb("scores").$type<LessonScores | null>(),
    /** candidate | proposed | applied | kept | retired | rejected */
    status: text("status").notNull().default("candidate"),
    applied: jsonb("applied").$type<LessonApplied | null>(),
    goalId: uuid("goal_id"),
    metricId: uuid("metric_id"),
    reviewAt: timestamp("review_at", { withTimezone: true }),
    /** What happened when it was reviewed, or why it was turned down. */
    outcome: text("outcome"),
    proposedBy: text("proposed_by").notNull(),
    /** The main-chat card offering it. */
    cardRunId: uuid("card_run_id"),
    composite: doublePrecision("composite"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("tethr_lessons_company_status_idx").on(table.companyId, table.status, table.createdAt),
  }),
);
