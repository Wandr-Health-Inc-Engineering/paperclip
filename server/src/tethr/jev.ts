// Jev — TypeSafe AI's decision model (phase 19). It answers typed questions about
// a piece of content: a yes/no probability ("noul"), one pick from a list
// ("choice"), or a score on an ordered rubric ("score"). It never writes text.
// About $0.042 per million input tokens; output is free. Raw fetch, no SDK (same
// as the Google tools). API: https://docs.typesafe.ai/api/system-one.md

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** Dollars per million input tokens (Jev 1.13 / 1.14). */
export const JEV_PRICE_PER_MTOK = 0.042;

export function jevConfigured(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

/** Whether TypeSafe accepts the key: a key being present says nothing (a
 * mistyped or revoked one answers 401 on every call). */
export type JevHealth = "missing" | "ok" | "rejected" | "unreachable";

const HEALTH_TTL_MS = 10 * 60_000;
const HEALTH_RETRY_MS = 60_000;
let health: { key: string; at: number; value: JevHealth } | null = null;

function remember(key: string, value: JevHealth): JevHealth {
  health = { key, at: Date.now(), value };
  return value;
}

/** Ask TypeSafe whether the key works (its model list needs only the key).
 * Cached: 10 minutes for a clear answer, 1 minute when it couldn't be reached;
 * a new key is checked at once. Every real call updates it too. */
export async function jevHealth(opts: { fetchImpl?: typeof fetch; timeoutMs?: number; fresh?: boolean } = {}): Promise<JevHealth> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return "missing";
  if (!opts.fresh && health && health.key === key) {
    const ttl = health.value === "unreachable" ? HEALTH_RETRY_MS : HEALTH_TTL_MS;
    if (Date.now() - health.at < ttl) return health.value;
  }
  // Tests never reach the network on their own: without a fake fetch, a key counts as working.
  if (process.env.VITEST && !opts.fetchImpl) return "ok";
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return remember(key, "ok");
    return remember(key, res.status === 401 || res.status === 403 ? "rejected" : "unreachable");
  } catch {
    return remember(key, "unreachable");
  }
}

/** What to tell a person about Jev's connection. */
export function jevHealthText(h: JevHealth): string {
  if (h === "ok") return "Connected";
  if (h === "rejected") return "TypeSafe rejected the key. Copy it again from console.typesafe.ai and save it here.";
  if (h === "unreachable") return "Key saved, but TypeSafe couldn't be reached just now.";
  return "Optional: add TYPESAFE_API_KEY";
}

export function jevModel(): string {
  return process.env.TETHR_JEV_MODEL?.trim() || "jev-latest";
}

function baseUrl(): string {
  return (process.env.TYPESAFE_API_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "JevError";
  }
}

export interface JevCallOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after the first, for rate limits, overload and network errors. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(10_000, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(10_000, at - Date.now())) : null;
}

async function errorDetail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const d = parsed.detail;
    if (typeof d === "string") return d.slice(0, 300);
    if (Array.isArray(d)) {
      return d
        .map((e) => (e && typeof e === "object" ? `${(e as { loc?: unknown[] }).loc?.join(".") ?? ""}: ${(e as { msg?: string }).msg ?? ""}` : String(e)))
        .join("; ")
        .slice(0, 300);
    }
    if (d && typeof d === "object") return JSON.stringify(d).slice(0, 300);
  } catch {
    // not JSON
  }
  return body.slice(0, 300);
}

function statusMessage(status: number, detail: string): string {
  if (status === 401) return "TypeSafe rejected the Jev API key (TYPESAFE_API_KEY). It needs to be copied again from console.typesafe.ai.";
  if (status === 400 && /max_tokens_exceeded/.test(detail)) return "This item is too long for Jev.";
  if (status === 413) return "This request is too big for Jev.";
  if (status === 422) return `Jev couldn't read the request${detail ? `: ${detail}` : "."}`;
  if (status === 429) return "Jev's rate limit was hit; try again in a minute.";
  if (status === 529) return "Jev is overloaded right now; try again shortly.";
  return `Jev returned an error (${status})${detail ? `: ${detail}` : "."}`;
}

function isAnswerMap(v: unknown): v is Record<string, JevAnswer> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every((a) => {
    if (!a || typeof a !== "object") return false;
    const x = a as Record<string, unknown>;
    if (x.type === "noul") return typeof x.noul === "number";
    if (x.type === "choice") return typeof x.choice === "string";
    if (x.type === "score") return typeof x.score === "number";
    return false;
  });
}

/** Ask Jev every question about one piece of content (all evaluated in parallel). */
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>, opts: JevCallOptions = {}): Promise<JevResponse> {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new JevError("Jev isn't set up (no TYPESAFE_API_KEY).", null);
  const f = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? wait;
  const body = JSON.stringify({ model: jevModel(), state, questions });
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(`${baseUrl()}/v1/systemone`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const why = err instanceof Error && err.name === "TimeoutError" ? "it took too long" : err instanceof Error ? err.message : String(err);
      throw new JevError(`Couldn't reach Jev (${why}).`, null);
    }
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as Partial<JevResponse> | null;
      if (!data || !isAnswerMap(data.answers)) throw new JevError("Jev sent back an answer Tethr couldn't read.", res.status);
      remember(key, "ok");
      return {
        model: typeof data.model === "string" ? data.model : jevModel(),
        answers: data.answers,
        usage: {
          input_tokens: Number(data.usage?.input_tokens) || 0,
          output_tokens: Number(data.usage?.output_tokens) || 0,
        },
      };
    }
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < retries) {
      await res.body?.cancel().catch(() => {});
      await sleep(retryAfterMs(res) ?? backoffMs(attempt));
      continue;
    }
    if (res.status === 401) remember(key, "rejected");
    throw new JevError(statusMessage(res.status, await errorDetail(res)), res.status);
  }
}

export function jevCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * JEV_PRICE_PER_MTOK;
}
