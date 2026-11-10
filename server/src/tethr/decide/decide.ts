import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrDecisions } from "@paperclipai/db";
import { companyStore } from "../company-store.js";
import { jevAsk, jevConfigured, jevCostUsd, JevError, type JevAnswer, type JevQuestion } from "../jev.js";
import { DAY } from "../time.js";
import {
  AUTO_MIN_ACCURACY,
  AUTO_MIN_DECISIONS,
  CALIBRATION_TARGET,
  CALIBRATION_WINDOW,
  DECISION_KINDS,
  decisionKind,
  DEFAULT_MONTHLY_CAP_USD,
  DEMOTION_DAYS,
  type DecisionMode,
} from "./kinds.js";

// The decision service (phase 26.2): the one place tethr asks Jev, and the
// record of every answer and what happened next. A kind is Off, Suggest (Jev's
// pick is offered to a person) or Automatic (tethr acts when Jev is above the
// kind's confidence bar). The bar calibrates itself from the record; a kind
// earns Automatic from its record, and loses it after two corrections in a week.

export interface DecisionSettings {
  modes?: Record<string, DecisionMode>;
  monthlyCapUsd?: number;
  /** When a kind was put back to Suggest on its own, and why. */
  demoted?: Array<{ kind: string; at: string }>;
}

export const decisionStore = companyStore<DecisionSettings>("TETHR_DECISIONS_FILE", "tethr-decisions.json");

export function decisionMode(companyId: string, key: string): DecisionMode {
  const kind = decisionKind(key);
  if (!kind) return "off";
  const mode = decisionStore.get(companyId).modes?.[key] ?? kind.defaultMode;
  return mode === "auto" && kind.neverAuto ? "suggest" : mode;
}

export function monthlyCapUsd(companyId: string): number {
  const cap = decisionStore.get(companyId).monthlyCapUsd;
  return typeof cap === "number" && cap >= 0 ? cap : DEFAULT_MONTHLY_CAP_USD;
}

export interface ChoiceOption {
  /** A short id Jev answers with ("f3"). */
  key: string;
  /** What the record and the person see ("05 Finance / Invoices"). */
  label: string;
  /** When it applies, for Jev. */
  description: string | null;
}

export interface ChoiceAsk {
  kind: string;
  instructions: string;
  options: ChoiceOption[];
}

export interface DecisionResult {
  kind: string;
  decisionId: string;
  pick: ChoiceOption;
  runnerUp: ChoiceOption | null;
  /** The options in Jev's order, best first. */
  ranked: ChoiceOption[];
  confidence: number;
  /** At or above the kind's confidence bar. */
  confident: boolean;
  mode: DecisionMode;
}

export type DecideResponse =
  | { ok: true; results: Record<string, DecisionResult>; costUsd: number }
  | { ok: false; reason: "off" | "not_configured" | "over_cap" | "jev_error"; detail: string };

export interface DecideDeps {
  ask?: typeof jevAsk;
  now?: Date;
}

const questionId = (kind: string) => kind.replace(/[^a-z0-9]+/gi, "_");

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function spentThisMonth(db: Db, companyId: string, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${tethrDecisions.costUsd}), 0)` })
    .from(tethrDecisions)
    .where(and(eq(tethrDecisions.companyId, companyId), gte(tethrDecisions.createdAt, monthStart(now))));
  return Number(row?.total ?? 0);
}

/** Why tethr can't ask Jev now (Off, not set up, over the monthly cap), or null. */
async function blocked(db: Db, companyId: string, kinds: string[], now: Date): Promise<Extract<DecideResponse, { ok: false }> | null> {
  if (!kinds.length) return { ok: false, reason: "off", detail: "Jev decisions are off for this." };
  if (!jevConfigured()) return { ok: false, reason: "not_configured", detail: "Jev isn't set up (no TypeSafe key)." };
  const cap = monthlyCapUsd(companyId);
  if ((await spentThisMonth(db, companyId, now)) >= cap) {
    return { ok: false, reason: "over_cap", detail: `Jev has used this month's $${cap.toFixed(2)} cap.` };
  }
  return null;
}

function rankedKeys(answer: JevAnswer | undefined): { order: string[]; confidence: number } | null {
  if (!answer || answer.type !== "choice") return null;
  // Jev's choice first, then the rest by probability.
  const rest = Object.entries(answer.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter((k) => k !== answer.choice);
  return { order: [answer.choice, ...rest], confidence: Number.isFinite(answer.confidence) ? answer.confidence : (answer.probabilities?.[answer.choice] ?? 0) };
}

/**
 * Ask Jev one or more choice questions about one item, in a single request, and
 * record each answer. `state` is what Jev judges: it must already have passed
 * the check on the Mac (screen.ts). Kinds that are Off are left out.
 */
export async function decideWithJev(
  db: Db,
  companyId: string,
  input: { label: string; subjectId?: string; state: unknown; asks: ChoiceAsk[] },
  deps: DecideDeps = {},
): Promise<DecideResponse> {
  const now = deps.now ?? new Date();
  const asks = input.asks.filter((a) => decisionMode(companyId, a.kind) !== "off" && a.options.length >= 2);
  const stop = await blocked(db, companyId, asks.map((a) => a.kind), now);
  if (stop) return stop;
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    asks.map((a) => [questionId(a.kind), { type: "choice", instructions: a.instructions, criteria: Object.fromEntries(a.options.map((o) => [o.key, o.description])) }]),
  );
  let response;
  try {
    response = await (deps.ask ?? jevAsk)(input.state, questions, { retries: 2 });
  } catch (err) {
    return { ok: false, reason: "jev_error", detail: err instanceof JevError ? err.message : String(err) };
  }
  const cost = response.costUsd ?? jevCostUsd(response.usage.input_tokens);
  const results: Record<string, DecisionResult> = {};
  for (const ask of asks) {
    const ranked = rankedKeys(response.answers[questionId(ask.kind)]);
    const byKey = new Map(ask.options.map((o) => [o.key, o]));
    const order = (ranked?.order ?? []).map((k) => byKey.get(k)).filter((o): o is ChoiceOption => !!o);
    if (!ranked || !order.length) continue;
    const bar = await confidenceBar(db, companyId, ask.kind);
    const [row] = await db
      .insert(tethrDecisions)
      .values({
        companyId,
        kind: ask.kind,
        label: input.label.slice(0, 200),
        options: ask.options.map((o) => o.label),
        pick: order[0].label,
        runnerUp: order[1]?.label ?? null,
        confidence: ranked.confidence,
        costUsd: cost / asks.length,
        mode: "suggest",
        subjectId: input.subjectId ?? null,
        createdAt: now,
      })
      .returning({ id: tethrDecisions.id });
    results[ask.kind] = {
      kind: ask.kind,
      decisionId: row.id,
      pick: order[0],
      runnerUp: order[1] ?? null,
      ranked: order,
      confidence: ranked.confidence,
      confident: ranked.confidence >= bar,
      mode: decisionMode(companyId, ask.kind),
    };
  }
  return { ok: true, results, costUsd: cost };
}

/**
 * Score one item on 0-1 scales (Jev's score questions), recorded as one decision
 * of `kind` whose pick is the composite. Used for lessons (26.6).
 */
export async function scoreWithJev(
  db: Db,
  companyId: string,
  input: { kind: string; label: string; subjectId?: string; state: unknown; scales: Record<string, { instructions: string; levels: string[] }> },
  deps: DecideDeps = {},
): Promise<{ ok: true; scores: Record<string, number | null>; decisionId: string; costUsd: number } | Extract<DecideResponse, { ok: false }>> {
  const now = deps.now ?? new Date();
  const stop = await blocked(db, companyId, decisionMode(companyId, input.kind) === "off" ? [] : [input.kind], now);
  if (stop) return stop;
  const questions: Record<string, JevQuestion> = Object.fromEntries(
    Object.entries(input.scales).map(([name, s]) => [name, { type: "score", instructions: s.instructions, criteria: s.levels }]),
  );
  let response;
  try {
    response = await (deps.ask ?? jevAsk)(input.state, questions, { retries: 2 });
  } catch (err) {
    return { ok: false, reason: "jev_error", detail: err instanceof JevError ? err.message : String(err) };
  }
  const scores: Record<string, number | null> = {};
  let sure = 1;
  for (const [name, scale] of Object.entries(input.scales)) {
    const a = response.answers[name];
    if (a?.type === "score" && Number.isFinite(a.score)) {
      scores[name] = scale.levels.length > 1 ? Math.max(0, Math.min(1, a.score / (scale.levels.length - 1))) : null;
      sure = Math.min(sure, Number.isFinite(a.confidence) ? a.confidence : 0);
    } else scores[name] = null;
  }
  const cost = response.costUsd ?? jevCostUsd(response.usage.input_tokens);
  const values = Object.values(scores).filter((v): v is number => v !== null);
  const composite = values.length ? Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 100) : 0;
  const [row] = await db
    .insert(tethrDecisions)
    .values({
      companyId,
      kind: input.kind,
      label: input.label.slice(0, 200),
      options: Object.keys(input.scales),
      pick: String(composite),
      runnerUp: null,
      confidence: sure,
      costUsd: cost,
      mode: "suggest",
      subjectId: input.subjectId ?? null,
      createdAt: now,
    })
    .returning({ id: tethrDecisions.id });
  return { ok: true, scores, decisionId: row.id, costUsd: cost };
}

export type DecisionOutcome = "accepted" | "corrected" | "automatic" | "undone" | "dropped";

/** What happened to a decision. A correction or an undo of one tethr acted on alone can demote its kind. */
export async function resolveDecision(
  db: Db,
  companyId: string,
  decisionId: string,
  outcome: DecisionOutcome,
  opts: { correctedTo?: string; now?: Date; onDemoted?: (kind: string) => Promise<void> | void } = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .update(tethrDecisions)
    .set({
      outcome,
      ...(outcome === "automatic" ? { mode: "auto" } : {}),
      correctedTo: outcome === "corrected" ? (opts.correctedTo ?? null) : null,
      resolvedAt: now,
    })
    .where(and(eq(tethrDecisions.id, decisionId), eq(tethrDecisions.companyId, companyId)))
    .returning();
  if (!row || row.mode !== "auto" || (outcome !== "corrected" && outcome !== "undone")) return;
  const since = new Date(now.getTime() - DEMOTION_DAYS * DAY);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tethrDecisions)
    .where(
      and(
        eq(tethrDecisions.companyId, companyId),
        eq(tethrDecisions.kind, row.kind),
        eq(tethrDecisions.mode, "auto"),
        inArray(tethrDecisions.outcome, ["corrected", "undone"]),
        gte(tethrDecisions.resolvedAt, since),
      ),
    );
  if (Number(n) >= 2 && decisionMode(companyId, row.kind) === "auto") {
    await decisionStore.update(companyId, (s) => ({
      ...s,
      modes: { ...(s.modes ?? {}), [row.kind]: "suggest" },
      demoted: [...(s.demoted ?? []), { kind: row.kind, at: now.toISOString() }].slice(-20),
    }));
    await opts.onDemoted?.(row.kind);
  }
}

export interface CalibrationRow {
  confidence: number;
  /** Jev's pick was what the person went with. */
  right: boolean;
}

/**
 * The lowest confidence at or above which at least CALIBRATION_TARGET of Jev's
 * picks were right (with at least 5 of them), or Infinity when there's no such
 * point. Pure, so it's tested on its own.
 */
export function calibrate(rows: CalibrationRow[]): number {
  const sorted = [...rows].sort((a, b) => b.confidence - a.confidence);
  let right = 0;
  let bar = Infinity;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].right) right++;
    const n = i + 1;
    const nextSame = i + 1 < sorted.length && sorted[i + 1].confidence === sorted[i].confidence;
    if (nextSame) continue;
    if (n >= 5 && right / n >= CALIBRATION_TARGET) bar = sorted[i].confidence;
  }
  return bar;
}

const ANSWERED = ["accepted", "corrected", "automatic", "undone"];

async function answeredRows(db: Db, companyId: string, kind: string) {
  return db
    .select({ confidence: tethrDecisions.confidence, outcome: tethrDecisions.outcome })
    .from(tethrDecisions)
    .where(and(eq(tethrDecisions.companyId, companyId), eq(tethrDecisions.kind, kind), inArray(tethrDecisions.outcome, ANSWERED)))
    .orderBy(desc(tethrDecisions.createdAt))
    .limit(CALIBRATION_WINDOW);
}

const isRight = (outcome: string) => outcome === "accepted" || outcome === "automatic";

/** The confidence a kind's pick needs before tethr acts on it alone. */
export async function confidenceBar(db: Db, companyId: string, kind: string): Promise<number> {
  const k = decisionKind(kind);
  if (!k) return Infinity;
  const rows = await answeredRows(db, companyId, kind);
  if (rows.length < AUTO_MIN_DECISIONS) return k.startBar;
  return Math.max(calibrate(rows.map((r) => ({ confidence: r.confidence, right: isRight(r.outcome) }))), 0.5);
}

export interface KindStats {
  key: string;
  label: string;
  about: string;
  mode: DecisionMode;
  neverAuto: boolean;
  sendsConversation: boolean;
  answered: number;
  right: number;
  /** The confidence bar (null while it can't be worked out). */
  bar: number | null;
  /** The backtest: of the answered decisions, how many Jev got right, overall and above the bar. */
  backtest: string;
  /** Why Automatic can't be chosen yet, or null when it can. */
  autoBlocked: string | null;
  pending: number;
}

export async function kindStats(db: Db, companyId: string): Promise<KindStats[]> {
  const pendingRows = await db
    .select({ kind: tethrDecisions.kind, n: sql<number>`count(*)` })
    .from(tethrDecisions)
    .where(and(eq(tethrDecisions.companyId, companyId), eq(tethrDecisions.outcome, "pending")))
    .groupBy(tethrDecisions.kind);
  return Promise.all(
    DECISION_KINDS.map(async (k) => {
      const rows = await answeredRows(db, companyId, k.key);
      const right = rows.filter((r) => isRight(r.outcome)).length;
      const bar = rows.length >= AUTO_MIN_DECISIONS ? calibrate(rows.map((r) => ({ confidence: r.confidence, right: isRight(r.outcome) }))) : null;
      const above = bar !== null && Number.isFinite(bar) ? rows.filter((r) => r.confidence >= bar) : [];
      const backtest = rows.length
        ? `Jev's pick was what you went with in ${right} of the last ${rows.length}${above.length ? `, and ${above.filter((r) => isRight(r.outcome)).length} of ${above.length} above its confidence bar` : ""}.`
        : "No answers yet.";
      const autoBlocked = k.neverAuto
        ? "This kind never runs on its own."
        : rows.length < AUTO_MIN_DECISIONS
          ? `Needs ${AUTO_MIN_DECISIONS} answered decisions first (${rows.length} so far).`
          : right / rows.length < AUTO_MIN_ACCURACY
            ? `Jev was right ${Math.round((right / rows.length) * 100)}% of the time; Automatic needs ${Math.round(AUTO_MIN_ACCURACY * 100)}%.`
            : null;
      return {
        key: k.key,
        label: k.label,
        about: k.about,
        mode: decisionMode(companyId, k.key),
        neverAuto: !!k.neverAuto,
        sendsConversation: !!k.sendsConversation,
        answered: rows.length,
        right,
        bar: bar !== null && Number.isFinite(bar) ? bar : null,
        backtest,
        autoBlocked,
        pending: Number(pendingRows.find((p) => p.kind === k.key)?.n ?? 0),
      };
    }),
  );
}

export class DecisionSettingError extends Error {}

/** A person sets a kind's mode. Automatic has to be earned (kindStats autoBlocked). */
export async function setDecisionMode(db: Db, companyId: string, key: string, mode: DecisionMode): Promise<void> {
  const kind = decisionKind(key);
  if (!kind) throw new DecisionSettingError("There's no such kind of decision.");
  if (mode === "auto") {
    const blockedBy = (await kindStats(db, companyId)).find((s) => s.key === key)?.autoBlocked;
    if (blockedBy) throw new DecisionSettingError(blockedBy);
  }
  await decisionStore.update(companyId, (s) => ({ ...s, modes: { ...(s.modes ?? {}), [key]: mode } }));
}

export async function setMonthlyCap(companyId: string, usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd < 0 || usd > 100) throw new DecisionSettingError("The monthly cap is $0 to $100.");
  await decisionStore.update(companyId, (s) => ({ ...s, monthlyCapUsd: Math.round(usd * 100) / 100 }));
}
