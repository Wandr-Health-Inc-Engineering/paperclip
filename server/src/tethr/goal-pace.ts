import { eq } from "drizzle-orm";
import type { Db, TethrMetricAdjustment, TethrMetricPoint } from "@paperclipai/db";
import { tethrGoalMetrics } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { logFailure } from "./best-effort.js";
import { formatMetricValue, roundForUnit } from "./metric-format.js";
import { DAY } from "./time.js";

// Goals that stay realistic on their own (phase 21, Mark's call: "done in the
// background autonomously to speed up or slow down", within a growth pace set
// during onboarding). After each measurement tethr fits the recent trend,
// projects it to the target date, adds the pace's uplift, and — when the
// target is well off that AND the last two measurements agree it's behind (or
// ahead) — moves the target halfway there. Small steps, rarely, never below
// where the metric started. The date never moves. Pure math first; the DB step
// (adjustAfterMeasurement) records the change, logs it and rings the bell.

export type GrowthPace = "steady" | "balanced" | "ambitious";
export const GROWTH_PACES: GrowthPace[] = ["steady", "balanced", "ambitious"];
export const PACE_UPLIFT: Record<GrowthPace, number> = { steady: 0.05, balanced: 0.15, ambitious: 0.3 };
export const PACE_LABEL: Record<GrowthPace, string> = { steady: "Steady", balanced: "Balanced", ambitious: "Ambitious" };

export const ADJUST = {
  /** Measurements needed before tethr touches a target. */
  minPoints: 3,
  /** The trend uses the latest this many measurements. */
  trendPoints: 8,
  /** Only when the target is more than this far from realistic (share of the target). */
  offBy: 0.15,
  /** Move this share of the way to realistic. */
  damping: 0.5,
  /** At most this share of the target per change. */
  maxStep: 0.25,
  cooldownDays: 14,
  /** Leave the last week before the target date alone. */
  minDaysLeft: 7,
  /** Adjustments kept per metric. */
  keep: 20,
};


export interface PaceMetric {
  name?: string;
  unit: string;
  direction: string;
  baseline: number | null;
  baselineAt: Date | null;
  target: number | null;
  targetDate: Date | null;
  history: TethrMetricPoint[];
  adjustments: TethrMetricAdjustment[];
}

const sorted = (points: TethrMetricPoint[]) => [...points].sort((a, b) => a.at.localeCompare(b.at));

/** Least-squares line through the latest points: value per day, and the line's value at a time. */
export function trend(points: TethrMetricPoint[], n: number = ADJUST.trendPoints): { perDay: number; at: (ms: number) => number } | null {
  const pts = sorted(points).slice(-n);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => Date.parse(p.at) / DAY);
  const ys = pts.map((p) => p.value);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { perDay: slope, at: (ms) => my + slope * (ms / DAY - mx) };
}

/** Where the straight line from the start to the target says the metric should be at a time. */
export function expectedAt(m: PaceMetric, ms: number): number | null {
  if (m.baseline === null || !m.baselineAt || m.target === null || !m.targetDate) return null;
  const start = m.baselineAt.getTime();
  const end = m.targetDate.getTime();
  if (!(end > start)) return null;
  const frac = Math.max(0, Math.min(1, (ms - start) / (end - start)));
  return m.baseline + (m.target - m.baseline) * frac;
}

/** The trend projected to the target date, plus the pace's uplift. Never aims
 * below where the metric started or stands now (above, when lower is better). */
export function realisticTarget(m: PaceMetric, pace: GrowthPace): { value: number; projected: number } | null {
  const line = trend(m.history);
  if (!line || !m.targetDate) return null;
  const projected = line.at(m.targetDate.getTime());
  const up = m.direction !== "down";
  const latest = sorted(m.history).at(-1)?.value ?? projected;
  const start = m.baseline ?? latest;
  const floor = up ? Math.max(projected, start, latest) : Math.min(projected, start, latest);
  const u = PACE_UPLIFT[pace];
  return { value: up ? floor * (1 + u) : floor * (1 - u), projected };
}

const shortDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface Adjustment {
  to: number;
  kind: "eased" | "raised";
  why: string;
}

/** Should the target move now, and to what? Null when it should stay. */
export function proposeAdjustment(m: PaceMetric, pace: GrowthPace, now: number = Date.now()): Adjustment | null {
  if (!isAdjustable(m, now)) return null;
  const trendSide = agreedSideOfPace(m);
  if (trendSide === null) return null;
  const real = realisticTarget(m, pace);
  if (!real || m.target === null || !m.targetDate) return null;
  if (Math.abs(real.value - m.target) / Math.max(Math.abs(m.target), 1e-9) <= ADJUST.offBy) return null;

  const easing = isEasier(m, real.value);
  // Behind: only ever ease. Ahead: only ever raise.
  if ((trendSide === "ahead") === easing) return null;
  const to = boundedTarget(m, m.target + (real.value - m.target) * ADJUST.damping);
  if (to === m.target) return null;

  return {
    to,
    kind: easing ? "eased" : "raised",
    why: `the trend points to about ${formatMetricValue(real.projected, m.unit)} by ${shortDate(m.targetDate)}, and the last two measurements were ${trendSide === "ahead" ? "ahead of" : "behind"} pace`,
  };
}

/** Enough to judge, not too close to the date, and not changed recently. */
function isAdjustable(m: PaceMetric, now: number): boolean {
  if (m.target === null || !m.targetDate || m.baseline === null || !m.baselineAt) return false;
  if (m.history.length < ADJUST.minPoints) return false;
  if (m.targetDate.getTime() - now < ADJUST.minDaysLeft * DAY) return false;
  const last = m.adjustments.at(-1);
  return !last || now - Date.parse(last.at) >= ADJUST.cooldownDays * DAY;
}

/** "ahead" or "behind" when the last two measurements agree about the start-to-target line; null otherwise. */
function agreedSideOfPace(m: PaceMetric): "ahead" | "behind" | null {
  const [a, b] = sorted(m.history).slice(-2).map((p) => sideOfPace(m, p));
  return a !== null && a === b ? a : null;
}

function sideOfPace(m: PaceMetric, point: TethrMetricPoint): "ahead" | "behind" | null {
  const expected = expectedAt(m, Date.parse(point.at));
  if (expected === null || point.value === expected) return null;
  const higherIsBetter = m.direction !== "down";
  return (point.value > expected) === higherIsBetter ? "ahead" : "behind";
}

/** Would this value make the target easier to reach? */
function isEasier(m: PaceMetric, value: number): boolean {
  return m.direction !== "down" ? value < m.target! : value > m.target!;
}

/** Keep a new target within one step of the old one, never past where the
 * metric started or stands now, inside its unit's range, and rounded. */
function boundedTarget(m: PaceMetric, proposed: number): number {
  const current = m.target!;
  const step = Math.abs(current) * ADJUST.maxStep;
  let to = Math.max(current - step, Math.min(current + step, proposed));
  const latest = sorted(m.history).at(-1)!.value;
  to = m.direction !== "down" ? Math.max(to, m.baseline!, latest) : Math.min(to, m.baseline!, latest);
  if (m.unit === "percent") to = Math.max(0, Math.min(100, to));
  else if (m.unit !== "number") to = Math.max(0, to);
  return roundForUnit(to, m.unit);
}

type MetricRow = typeof tethrGoalMetrics.$inferSelect;

/** After a measurement: move the target if it has stopped being realistic.
 * Returns the updated row, or null when nothing changed. Best-effort. */
export async function adjustAfterMeasurement(db: Db, companyId: string, row: MetricRow, now: Date = new Date()): Promise<MetricRow | null> {
  const { getSetup } = await import("./setup.js");
  const setup = getSetup(companyId);
  if (!setup.autoAdjust) return null;
  const change = proposeAdjustment({ ...row, adjustments: row.adjustments ?? [] }, setup.growthPace, now.getTime());
  if (!change || row.target === null) return null;
  const entry: TethrMetricAdjustment = { at: now.toISOString(), from: row.target, to: change.to, why: change.why };
  const [updated] = await db
    .update(tethrGoalMetrics)
    .set({ target: change.to, adjustments: [...(row.adjustments ?? []), entry].slice(-ADJUST.keep), updatedAt: now })
    .where(eq(tethrGoalMetrics.id, row.id))
    .returning();
  const title = `tethr ${change.kind} "${row.name}" to ${formatMetricValue(change.to, row.unit)} (was ${formatMetricValue(row.target, row.unit)})`;
  await logActivity(db, {
    companyId,
    actorType: "agent",
    actorId: "@tethr",
    action: "tethr_goal_target_adjusted",
    entityType: "company",
    entityId: companyId,
    details: { metricId: row.id, metric: row.name, from: row.target, to: change.to, why: change.why, pace: setup.growthPace },
  }).catch(logFailure("target adjustment activity log", { metricId: row.id }));
  const { notificationService } = await import("./notify.js");
  await notificationService(db)
    .send({ companyId, kind: "goal", title, body: `Because ${change.why}. Growth pace: ${PACE_LABEL[setup.growthPace]}.`, href: "/growth", agentTag: "@tethr" })
    .catch(logFailure("target adjustment bell", { metricId: row.id }));
  return updated ?? null;
}

/** Record a measurement, then review the metric's target: it may move (see
 * proposeAdjustment). What the chat's record_metric and the REST route use. */
export async function recordMeasurementAndReviewTarget(
  db: Db,
  companyId: string,
  metricId: string,
  input: { value: unknown; at?: unknown; note?: unknown },
): Promise<MetricRow> {
  const { goalsService } = await import("./goals.js");
  const recorded = await goalsService(db).recordMeasurement(companyId, metricId, input);
  const adjusted = await adjustAfterMeasurement(db, companyId, recorded).catch((err) => {
    logFailure("target review", { metricId })(err);
    return null;
  });
  return adjusted ?? recorded;
}
