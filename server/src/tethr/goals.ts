import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, tethrGoalMetrics, type TethrMetricPoint } from "@paperclipai/db";
import { getDefaultCompanyGoal, goalService } from "../services/goals.js";

// Goals with numbers (phase 20). Core goals hold the tree (the company goal =
// the mission, one team goal per area); tethr_goal_metrics adds a measurable
// metric per goal: baseline, target by a date, the latest value, a history,
// and the exact method used to measure it. The chat reads them every turn
// (goalsContextText → the workspace CLAUDE.md) and keeps them up to date
// through its tools (save_goal / save_metric / record_metric).

export const METRIC_UNITS = ["count", "usd", "percent", "number"] as const;
export const METRIC_SOURCES = ["stripe", "posthog", "google_ads", "manual", "other"] as const;
export const HISTORY_CAP = 104;

export type MetricUnit = (typeof METRIC_UNITS)[number];
export type MetricSource = (typeof METRIC_SOURCES)[number];
export type GoalRow = typeof goals.$inferSelect;
export type MetricRow = typeof tethrGoalMetrics.$inferSelect;

export interface GoalWithMetrics extends GoalRow {
  metrics: MetricRow[];
}

export interface GoalsView {
  /** The mission (the root company-level goal), if set. */
  company: GoalRow | null;
  /** Everything under it (area goals), oldest first, each with its metrics. */
  goals: GoalWithMetrics[];
}

export class GoalInputError extends Error {}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new GoalInputError("Numbers must be plain numbers (no units or commas).");
  return n;
};
const date = (v: unknown): Date | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  // A bare date means that day: noon UTC shows as the same date in every US zone.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? new Date(`${String(v).trim()}T12:00:00Z`) : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new GoalInputError(`"${String(v)}" isn't a date (use YYYY-MM-DD).`);
  return d;
};

export function goalsService(db: Db) {
  const core = goalService(db);

  async function ownGoal(companyId: string, id: string): Promise<GoalRow> {
    const row = await core.getById(id);
    if (!row || row.companyId !== companyId) throw new GoalInputError("That goal doesn't exist in this company.");
    return row;
  }

  async function ownMetric(companyId: string, id: string): Promise<MetricRow> {
    const [row] = await db.select().from(tethrGoalMetrics).where(and(eq(tethrGoalMetrics.id, id), eq(tethrGoalMetrics.companyId, companyId)));
    if (!row) throw new GoalInputError("That metric doesn't exist in this company.");
    return row;
  }

  return {
    async list(companyId: string): Promise<GoalsView> {
      const all = await db.select().from(goals).where(eq(goals.companyId, companyId)).orderBy(asc(goals.createdAt));
      const company = await getDefaultCompanyGoal(db, companyId);
      const rest = all.filter((g) => g.id !== company?.id && g.status !== "cancelled");
      const metrics = rest.length
        ? await db
            .select()
            .from(tethrGoalMetrics)
            .where(and(eq(tethrGoalMetrics.companyId, companyId), inArray(tethrGoalMetrics.goalId, rest.map((g) => g.id))))
            .orderBy(asc(tethrGoalMetrics.createdAt))
        : [];
      return { company, goals: rest.map((g) => ({ ...g, metrics: metrics.filter((m) => m.goalId === g.id) })) };
    },

    /** Create or update a goal. level "company" = the mission (there is only one). */
    async saveGoal(
      companyId: string,
      input: { id?: unknown; title?: unknown; description?: unknown; level?: unknown; status?: unknown },
    ): Promise<GoalRow> {
      const title = text(input.title, 200);
      const description = input.description === undefined ? undefined : text(input.description, 4000) || null;
      const status = input.status === undefined ? undefined : String(input.status);
      if (status !== undefined && !["planned", "active", "achieved", "cancelled"].includes(status)) {
        throw new GoalInputError("status must be planned, active, achieved or cancelled.");
      }
      if (typeof input.id === "string" && input.id) {
        await ownGoal(companyId, input.id);
        const patch: Partial<typeof goals.$inferInsert> = {};
        if (title) patch.title = title;
        if (description !== undefined) patch.description = description;
        if (status) patch.status = status;
        return (await core.update(input.id, patch))!;
      }
      if (!title) throw new GoalInputError("A goal needs a title.");
      const level = input.level === "company" ? "company" : "team";
      const mission = await getDefaultCompanyGoal(db, companyId);
      if (level === "company") {
        if (mission) return (await core.update(mission.id, { title, description: description ?? mission.description, status: status ?? "active" }))!;
        return core.create(companyId, { title, description: description ?? null, level: "company", status: status ?? "active", parentId: null });
      }
      return core.create(companyId, {
        title,
        description: description ?? null,
        level: "team",
        status: status ?? "active",
        parentId: mission?.id ?? null,
      });
    },

    /** Create or update a metric on a goal. */
    async saveMetric(companyId: string, input: Record<string, unknown>): Promise<MetricRow> {
      const unit = input.unit === undefined ? undefined : String(input.unit);
      if (unit !== undefined && !METRIC_UNITS.includes(unit as MetricUnit)) throw new GoalInputError(`unit must be one of ${METRIC_UNITS.join(", ")}.`);
      const source = input.source === undefined ? undefined : String(input.source);
      if (source !== undefined && !METRIC_SOURCES.includes(source as MetricSource)) {
        throw new GoalInputError(`source must be one of ${METRIC_SOURCES.join(", ")}.`);
      }
      const direction = input.direction === undefined ? undefined : input.direction === "down" ? "down" : "up";
      const fields = {
        ...(input.name !== undefined ? { name: text(input.name, 120) } : {}),
        ...(unit ? { unit } : {}),
        ...(source ? { source } : {}),
        ...(direction ? { direction } : {}),
        ...(input.method !== undefined ? { method: text(input.method, 2000) } : {}),
        ...(num(input.baseline) !== undefined ? { baseline: num(input.baseline) } : {}),
        ...(date(input.baseline_at ?? input.baselineAt) !== undefined ? { baselineAt: date(input.baseline_at ?? input.baselineAt) } : {}),
        ...(num(input.target) !== undefined ? { target: num(input.target) } : {}),
        ...(date(input.target_date ?? input.targetDate) !== undefined ? { targetDate: date(input.target_date ?? input.targetDate) } : {}),
      };
      if (typeof input.id === "string" && input.id) {
        await ownMetric(companyId, input.id);
        if ("name" in fields && !fields.name) throw new GoalInputError("A metric needs a name.");
        const [row] = await db
          .update(tethrGoalMetrics)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(tethrGoalMetrics.id, input.id))
          .returning();
        return row;
      }
      const goalId = typeof input.goal_id === "string" ? input.goal_id : typeof input.goalId === "string" ? input.goalId : "";
      if (!goalId) throw new GoalInputError("Say which goal the metric belongs to (goal_id).");
      await ownGoal(companyId, goalId);
      if (!fields.name) throw new GoalInputError("A metric needs a name.");
      const [row] = await db
        .insert(tethrGoalMetrics)
        .values({
          companyId,
          goalId,
          ...fields,
          name: fields.name,
          ...(fields.baseline !== undefined && fields.baseline !== null && !fields.baselineAt ? { baselineAt: new Date() } : {}),
        })
        .returning();
      return row;
    },

    /** A new measurement: becomes the current value and joins the history. */
    async recordMeasurement(companyId: string, metricId: string, input: { value: unknown; at?: unknown; note?: unknown }): Promise<MetricRow> {
      const metric = await ownMetric(companyId, metricId);
      const value = num(input.value);
      if (value === null || value === undefined) throw new GoalInputError("Give the measured value.");
      const at = date(input.at) ?? new Date();
      const note = text(input.note, 300);
      const point: TethrMetricPoint = { at: at.toISOString(), value, ...(note ? { note } : {}) };
      const history = [...(metric.history ?? []), point].sort((a, b) => a.at.localeCompare(b.at)).slice(-HISTORY_CAP);
      const latest = history[history.length - 1];
      const [row] = await db
        .update(tethrGoalMetrics)
        .set({
          history,
          current: latest.value,
          currentAt: new Date(latest.at),
          ...(metric.baseline === null ? { baseline: value, baselineAt: at } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tethrGoalMetrics.id, metricId))
        .returning();
      return row;
    },

    async deleteMetric(companyId: string, metricId: string): Promise<void> {
      await ownMetric(companyId, metricId);
      await db.delete(tethrGoalMetrics).where(eq(tethrGoalMetrics.id, metricId));
    },
  };
}

function fmt(value: number | null, unit: string): string {
  if (value === null || value === undefined) return "?";
  if (unit === "usd") return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (unit === "percent") return `${Number(value.toFixed(2))}%`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** The goals block written into the chat's CLAUDE.md every turn. */
export function goalsContextText(view: GoalsView): string {
  if (!view.company && !view.goals.length) {
    return "- No goals are set yet. If Mark asks for plans or priorities, suggest finishing tethr's setup (the goals interview) first.";
  }
  const lines: string[] = [];
  if (view.company) lines.push(`Mission: ${view.company.title}${view.company.description ? ` (${view.company.description.split("\n")[0].slice(0, 200)})` : ""}`);
  for (const g of view.goals) {
    lines.push(`- ${g.title} [goal ${g.id}${g.status !== "active" ? `, ${g.status}` : ""}]`);
    if (!g.metrics.length) lines.push("  - no metric yet");
    for (const m of g.metrics) {
      const by = day(m.targetDate);
      lines.push(
        `  - ${m.name} [metric ${m.id}]: ${fmt(m.current, m.unit)} now${m.currentAt ? ` (${day(m.currentAt)})` : ""}, baseline ${fmt(m.baseline, m.unit)}, target ${fmt(m.target, m.unit)}${by ? ` by ${by}` : ""}${m.direction === "down" ? " (lower is better)" : ""}. Measure: ${m.method || "not written down yet"} [${m.source}]`,
      );
    }
  }
  return lines.join("\n");
}
