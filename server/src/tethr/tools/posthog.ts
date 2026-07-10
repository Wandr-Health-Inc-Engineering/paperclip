// Constrained, read-only PostHog access for the Pulse agent (Phase 8).
//
// EXACTLY three queries, marketing-analytics only. No person-level queries, no
// PII/PHI fields, ever. A denylist rejects any configured event name that looks
// clinical before a single query runs. All queries go through the HogQL Query
// API against project 361561 (us.posthog.com) with a read-only personal key.

const POSTHOG_HOST = "https://us.posthog.com";
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID?.trim() || "361561";

export function posthogKey(): string | undefined {
  return process.env.POSTHOG_API_KEY?.trim() || undefined;
}
export function posthogConfigured(): boolean {
  return Boolean(posthogKey());
}

/** Reject event names that could carry patient/clinical context. */
export const PHI_DENYLIST = [
  "patient",
  "diagnos",
  "medication",
  "prescription",
  "clinical",
  "medical_record",
  "mrn",
  "ssn",
  "dob",
  "date_of_birth",
  "phi",
  "insurance",
  "symptom",
  "condition",
  "provider_note",
];

export function isDeniedEventName(name: string): boolean {
  const n = name.toLowerCase();
  return PHI_DENYLIST.some((bad) => n.includes(bad));
}

async function hogql<T = unknown[]>(query: string): Promise<T[]> {
  const key = posthogKey();
  if (!key) throw new Error("POSTHOG_API_KEY not set");
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${PROJECT_ID}/query/`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) throw new Error(`posthog query failed: ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { results?: T[] };
  return data.results ?? [];
}

export interface ErrorCount {
  type: string;
  today: number;
  baselineDaily: number;
}
export interface EventVolume {
  event: string;
  today: number;
  baselineDaily: number;
}
export interface FunnelConversion {
  step1: string;
  step2: string;
  todayStep1: number;
  todayRate: number;
  priorRate: number;
}

/** (a) Exception counts by type: today vs the prior-7-day daily average. */
export async function fetchErrorCounts(errorEvent = "$exception"): Promise<ErrorCount[]> {
  const rows = await hogql<[string, number, number]>(
    `SELECT coalesce(properties.$exception_type, 'unknown') AS type,
            countIf(timestamp > now() - INTERVAL 1 DAY) AS today,
            countIf(timestamp <= now() - INTERVAL 1 DAY AND timestamp > now() - INTERVAL 8 DAY) / 7 AS baseline
     FROM events
     WHERE event = ${sqlStr(errorEvent)} AND timestamp > now() - INTERVAL 8 DAY
     GROUP BY type ORDER BY today DESC LIMIT 50`,
  );
  return rows.map((r) => ({ type: String(r[0]), today: Number(r[1]) || 0, baselineDaily: Number(r[2]) || 0 }));
}

/** (b) Volume of each configured critical event: today vs prior-7-day daily average. */
export async function fetchEventVolumes(names: string[]): Promise<EventVolume[]> {
  const safe = names.filter((n) => !isDeniedEventName(n));
  const out: EventVolume[] = [];
  for (const name of safe) {
    const rows = await hogql<[number, number]>(
      `SELECT countIf(timestamp > now() - INTERVAL 1 DAY) AS today,
              countIf(timestamp <= now() - INTERVAL 1 DAY AND timestamp > now() - INTERVAL 8 DAY) / 7 AS baseline
       FROM events WHERE event = ${sqlStr(name)} AND timestamp > now() - INTERVAL 8 DAY`,
    );
    const r = rows[0] ?? [0, 0];
    out.push({ event: name, today: Number(r[0]) || 0, baselineDaily: Number(r[1]) || 0 });
  }
  return out;
}

/** (c) Conversion between two steps: today vs yesterday. */
export async function fetchFunnelConversion(step1: string, step2: string): Promise<FunnelConversion | null> {
  if (isDeniedEventName(step1) || isDeniedEventName(step2)) return null;
  const rows = await hogql<[number, number, number, number]>(
    `SELECT countIf(event = ${sqlStr(step1)} AND timestamp > now() - INTERVAL 1 DAY) AS s1_today,
            countIf(event = ${sqlStr(step2)} AND timestamp > now() - INTERVAL 1 DAY) AS s2_today,
            countIf(event = ${sqlStr(step1)} AND timestamp <= now() - INTERVAL 1 DAY AND timestamp > now() - INTERVAL 2 DAY) AS s1_prior,
            countIf(event = ${sqlStr(step2)} AND timestamp <= now() - INTERVAL 1 DAY AND timestamp > now() - INTERVAL 2 DAY) AS s2_prior
     FROM events WHERE timestamp > now() - INTERVAL 2 DAY`,
  );
  const r = rows[0];
  if (!r) return null;
  const [s1t, s2t, s1p, s2p] = r.map((x) => Number(x) || 0);
  return {
    step1,
    step2,
    todayStep1: s1t,
    todayRate: s1t > 0 ? s2t / s1t : 0,
    priorRate: s1p > 0 ? s2p / s1p : 0,
  };
}

/** HogQL string literal (single-quote escaped). Only used for configured event names. */
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
