// Pulse — the PostHog analytics auditor (Phase 8), the second Reliability agent.
// Consumes marketing-site analytics and flags regressions (error spikes, dead
// tracking events, funnel drops) to #scout on the same loop as Sentry. Rules are
// dumb and explainable — no ML — and every finding carries the numbers.
//
// Scope: marketing analytics only, read-only. A PHI denylist (tools/posthog.ts)
// rejects any configured event name that could carry patient/clinical context
// before a query runs — clinical data can never reach a finding.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { memoryService } from "../memory.js";
import { notificationService } from "../notify.js";
import { buildRecommendation, type RecommendationInput } from "../recommendation.js";
import {
  fetchErrorCounts,
  fetchEventVolumes,
  fetchFunnelConversion,
  isDeniedEventName,
  posthogConfigured,
  type ErrorCount,
  type EventVolume,
  type FunnelConversion,
} from "../tools/posthog.js";

export type PulseRule = "error_spike" | "dead_event" | "funnel_drop";
export type Severity = "high" | "medium" | "low";

export interface PulseFinding {
  ruleType: PulseRule;
  severity: Severity;
  title: string;
  why: string;
  detail?: string[];
  fingerprint: string;
}

// ---- Config (server/src/tethr/tools/pulse-events.json) --------------------

export interface PulseConfig {
  errorEvent: string;
  criticalEvents: string[];
  funnels: Array<{ step1: string; step2: string }>;
}

const PLACEHOLDER = "FILL_ME";

export interface LoadedConfig {
  config: PulseConfig;
  ready: boolean; // false until Mark replaces the placeholders
  rejected: string[]; // event names dropped by the PHI denylist
}

/** Load + sanitize the config. Denylisted event names are dropped, not queried. */
export function loadPulseConfig(raw: unknown): LoadedConfig {
  const c = (raw ?? {}) as Partial<PulseConfig>;
  const errorEvent = typeof c.errorEvent === "string" && c.errorEvent ? c.errorEvent : "$exception";
  const criticalRaw = Array.isArray(c.criticalEvents) ? c.criticalEvents.filter((x) => typeof x === "string") : [];
  const funnelsRaw = Array.isArray(c.funnels) ? c.funnels : [];
  const rejected: string[] = [];
  const criticalEvents = criticalRaw.filter((e) => {
    if (isDeniedEventName(e)) {
      rejected.push(e);
      return false;
    }
    return true;
  });
  const funnels = funnelsRaw.filter((f) => {
    const s1 = String(f?.step1 ?? "");
    const s2 = String(f?.step2 ?? "");
    if (isDeniedEventName(s1) || isDeniedEventName(s2)) {
      rejected.push(`${s1}→${s2}`);
      return false;
    }
    return Boolean(s1 && s2);
  });
  const hasPlaceholder =
    criticalRaw.some((e) => e.includes(PLACEHOLDER)) ||
    funnelsRaw.some((f) => JSON.stringify(f).includes(PLACEHOLDER));
  const ready = !hasPlaceholder && (criticalEvents.length > 0 || funnels.length > 0);
  return { config: { errorEvent, criticalEvents, funnels }, ready, rejected };
}

export function readPulseConfigFile(): LoadedConfig {
  const p =
    process.env.TETHR_PULSE_CONFIG?.trim() ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "pulse-events.json");
  try {
    return loadPulseConfig(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return loadPulseConfig({});
  }
}

// ---- Detection rules (pure) ------------------------------------------------

const MIN_ERRORS = 5; // ignore tiny absolute counts
const SPIKE_FACTOR = 3; // > 3x baseline
const MIN_FUNNEL_VOLUME = 20; // rate is meaningful only above this
const FUNNEL_DROP = 0.3; // > 30% relative drop

export function detectErrorSpikes(errors: ErrorCount[]): PulseFinding[] {
  const out: PulseFinding[] = [];
  for (const e of errors) {
    if (e.today >= MIN_ERRORS && e.baselineDaily > 0 && e.today > SPIKE_FACTOR * e.baselineDaily) {
      const x = (e.today / e.baselineDaily).toFixed(1);
      out.push(mk("error_spike", "high", e.type, `Error spike: "${e.type}" ${e.today} in 24h (${x}× the 7-day baseline)`, "A sudden error-type spike usually means a live regression hitting real users.", [`Today: ${e.today}`, `Baseline: ${e.baselineDaily.toFixed(1)}/day`]));
    }
  }
  return out;
}

export function detectDeadEvents(events: EventVolume[]): PulseFinding[] {
  const out: PulseFinding[] = [];
  for (const e of events) {
    if (e.today === 0 && e.baselineDaily >= 1) {
      out.push(mk("dead_event", "high", e.event, `Dead tracking event: "${e.event}" 0 events in 24h (baseline ${e.baselineDaily.toFixed(0)}/day)`, "A critical event dropping to zero usually means the tag broke — data and any downstream automation are now blind.", [`Today: 0`, `Baseline: ${e.baselineDaily.toFixed(1)}/day`]));
    }
  }
  return out;
}

export function detectFunnelDrops(funnels: FunnelConversion[]): PulseFinding[] {
  const out: PulseFinding[] = [];
  for (const f of funnels) {
    if (f.priorRate > 0 && f.todayStep1 >= MIN_FUNNEL_VOLUME) {
      const drop = (f.priorRate - f.todayRate) / f.priorRate;
      if (drop > FUNNEL_DROP) {
        out.push(mk("funnel_drop", "high", `${f.step1}->${f.step2}`, `Funnel drop: ${f.step1} → ${f.step2} conversion fell ${(drop * 100).toFixed(0)}% day-over-day`, "A sharp conversion drop between two steps points at a broken or regressed flow.", [`Today: ${(f.todayRate * 100).toFixed(1)}%`, `Yesterday: ${(f.priorRate * 100).toFixed(1)}%`, `Step-1 volume today: ${f.todayStep1}`]));
      }
    }
  }
  return out;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
export function selectPulseFindings(findings: PulseFinding[], seen: Set<string>, max = 3): PulseFinding[] {
  const fresh = findings.filter((f) => !seen.has(f.fingerprint));
  fresh.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  return fresh.slice(0, max);
}

export function findingToRecommendation(f: PulseFinding): RecommendationInput {
  return { agentCodename: "Pulse", title: f.title, why: f.why, severity: f.severity, details: f.detail };
}

// ---- Runner (used by the adapter's pulse_audit heartbeat mode) -------------

const MEMO_MARK = "pulse:fp:";
const DEDUPE_DAYS = 14;

export interface PulseRunResult {
  ready: boolean;
  configured: boolean;
  findings: number;
  posted: number;
  dryRun: boolean;
  rejected: string[];
  postedFindings: Array<{ fingerprint: string; title: string; severity: string }>;
}

async function seenFingerprints(db: Db, companyId: string, agentId: string): Promise<Set<string>> {
  const rows = await memoryService(db).recall(companyId, agentId, MEMO_MARK, 200);
  const cutoff = Date.now() - DEDUPE_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const re = new RegExp(`${MEMO_MARK}([^\\]\\s]+)`);
  for (const r of rows) {
    const created = r.createdAt ? new Date(r.createdAt).getTime() : 0;
    if (created < cutoff) continue;
    const m = re.exec(r.content ?? "");
    if (m) seen.add(m[1]);
  }
  return seen;
}

export async function runPulseAudit(
  db: Db,
  companyId: string,
  agentId: string,
  opts: { dryRun?: boolean } = {},
): Promise<PulseRunResult> {
  const { config, ready, rejected } = readPulseConfigFile();
  const base = { ready, configured: posthogConfigured(), rejected, findings: 0, posted: 0, dryRun: Boolean(opts.dryRun), postedFindings: [] as PulseRunResult["postedFindings"] };
  if (!posthogConfigured() || !ready) return base; // nothing to do until key + config are set

  const [errors, events] = await Promise.all([
    fetchErrorCounts(config.errorEvent).catch(() => [] as ErrorCount[]),
    fetchEventVolumes(config.criticalEvents).catch(() => [] as EventVolume[]),
  ]);
  const funnels: FunnelConversion[] = [];
  for (const f of config.funnels) {
    const c = await fetchFunnelConversion(f.step1, f.step2).catch(() => null);
    if (c) funnels.push(c);
  }

  const all = [...detectErrorSpikes(errors), ...detectDeadEvents(events), ...detectFunnelDrops(funnels)];
  const seen = await seenFingerprints(db, companyId, agentId);
  const toPost = selectPulseFindings(all, seen, 3);
  const postedFindings = toPost.map((f) => ({ fingerprint: f.fingerprint, title: f.title, severity: f.severity }));

  if (opts.dryRun) return { ...base, findings: all.length, posted: 0, postedFindings };

  const notify = notificationService(db);
  const memory = memoryService(db);
  for (const f of toPost) {
    const rec = buildRecommendation(findingToRecommendation(f));
    await notify.send({ companyId, kind: "system", title: f.title, body: rec.body, agentTag: "@pulse", slackBlocks: rec.blocks });
    await memory.record({ companyId, agentId, kind: "fact", content: `[${MEMO_MARK}${f.fingerprint}] ${f.title}`, source: f.ruleType });
  }
  return { ...base, findings: all.length, posted: toPost.length, postedFindings };
}

function mk(ruleType: PulseRule, severity: Severity, discriminator: string, title: string, why: string, detail?: string[]): PulseFinding {
  return { ruleType, severity, title, why, detail, fingerprint: `pulse:${ruleType}:${discriminator}` };
}
