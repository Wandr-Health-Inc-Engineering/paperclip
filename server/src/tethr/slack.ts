// Slack surface for Tethr (Phase 2).
//
// Outbound: a tiny Web API client (plain fetch — no SDK to vendor, same
// philosophy as the Claude provider). Used by the Notifier's `slack` channel.
// Inbound: signature verification + a PURE event interpreter (unit-tested) that
// the Express events endpoint drives. `../scout` was absent at build time, so
// this is a fresh implementation on the notify.ts seam rather than a port; if
// Scout turns up, reuse its handlers here (see docs/tethr-buildout/scout-audit.md).
//
// Nothing here auto-posts content anywhere: outbound is notifications only,
// inbound turns a tag/DM/link into a routed @tethr task (intake) whose answer
// is posted back into the same thread.

import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, tethrAgentProfiles, tethrRouteRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const SLACK_API = "https://slack.com/api";

/** Default #scout channel from the bundle. Override with SLACK_SCOUT_CHANNEL. */
export const DEFAULT_SCOUT_CHANNEL = "C0AE02FJR5Y";

/** Legacy company-name fallback (pre-Phase-11 orgs). */
const LEGACY_COMPANY_NAME = "Wandr Growth";

/** Never touch real Slack under test — the suite must not post to #scout even
 * if a real token leaks into process.env (e.g. loaded from the instance .env). */
function underTest(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

export function slackBotToken(): string | undefined {
  return process.env.SLACK_BOT_TOKEN?.trim() || undefined;
}

/** True once a bot token is set (cloud). Local dev stays offline without it. */
export function slackConfigured(): boolean {
  if (underTest()) return false;
  return Boolean(slackBotToken());
}

export function slackChannel(): string {
  return process.env.SLACK_SCOUT_CHANNEL?.trim() || DEFAULT_SCOUT_CHANNEL;
}

export interface PostMessageInput {
  channel?: string;
  text?: string;
  blocks?: Array<Record<string, unknown>>;
  threadTs?: string;
}

export interface PostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  /** True when skipped because no token is configured (offline dev). */
  skipped?: boolean;
}

/** POST chat.postMessage. Returns `{ ok:false, skipped:true }` with no token. */
export async function postSlackMessage(
  input: PostMessageInput,
): Promise<PostMessageResult> {
  if (underTest()) return { ok: false, skipped: true, error: "test env" };
  const token = slackBotToken();
  if (!token) return { ok: false, skipped: true, error: "no SLACK_BOT_TOKEN" };
  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: input.channel ?? slackChannel(),
        text: input.text ?? "",
        ...(input.blocks ? { blocks: input.blocks } : {}),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      channel?: string;
      error?: string;
    };
    return {
      ok: Boolean(data.ok),
      ts: data.ts,
      channel: data.channel,
      error: data.ok ? undefined : (data.error ?? `http ${res.status}`),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- Inbound: signature verification -------------------------------------

export interface VerifyInput {
  signingSecret?: string;
  timestamp?: string | null;
  signature?: string | null;
  rawBody: string;
  /** Injectable for tests; defaults to now. */
  nowSeconds?: number;
}

/**
 * Verify Slack's `v0=` HMAC-SHA256 signature over `v0:timestamp:body`.
 * Fail-OPEN only when no signing secret is configured (offline/local dev);
 * once SLACK_SIGNING_SECRET is set, a missing/invalid/stale signature fails.
 */
export function verifySlackSignature(input: VerifyInput): boolean {
  const secret = input.signingSecret ?? process.env.SLACK_SIGNING_SECRET?.trim();
  if (!secret) return true; // not configured — skip (local dev)
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false; // replay window: 5 min
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  const expected =
    "v0=" + crypto.createHmac("sha256", secret).update(base).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(input.signature);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---- Inbound: pure event interpreter -------------------------------------

export type SlackInterpretation =
  | { type: "challenge"; challenge: string }
  | {
      type: "kickoff";
      requestText: string;
      links: string[];
      channel?: string;
      threadTs?: string;
      isDM?: boolean;
    }
  | { type: "ignore"; reason: string };

const LINK_RE = /<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>]+)/g;

/** Extract URLs from Slack text (handles `<url>`, `<url|label>`, and bare). */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const url = (m[1] ?? m[2] ?? "").replace(/[.,)]+$/, "");
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Interpret a Slack Events API payload. Kicks off content when the bot is
 * mentioned OR a link/photo is shared; ignores bot/own messages (loop guard)
 * and everything else. Pure — no I/O — so it's unit-testable.
 */
export function interpretSlackEvent(
  payload: unknown,
  _opts: { botUserId?: string } = {},
): SlackInterpretation {
  const p = payload as Record<string, any> | null;
  if (!p || typeof p !== "object") return { type: "ignore", reason: "empty" };

  if (p.type === "url_verification" && typeof p.challenge === "string") {
    return { type: "challenge", challenge: p.challenge };
  }
  if (p.type !== "event_callback" || !p.event) {
    return { type: "ignore", reason: `not an event_callback (${p.type})` };
  }

  const ev = p.event as Record<string, any>;
  // Loop guard: never react to bot messages (including our own).
  if (ev.bot_id || ev.subtype === "bot_message" || ev.subtype === "message_changed") {
    return { type: "ignore", reason: "bot/edited message" };
  }
  const isMention = ev.type === "app_mention";
  const isMessage = ev.type === "message";
  if (!isMention && !isMessage) return { type: "ignore", reason: `event ${ev.type}` };

  const rawText = String(ev.text ?? "");
  const links = extractLinks(rawText);
  const hasFiles = Array.isArray(ev.files) && ev.files.length > 0;

  // In a DM (`channel_type: "im"`) the bot is 1:1 with the user, so ANY message
  // is a request to route — like typing in the Console chat. In a channel we
  // require a mention or a link/photo so we don't react to unrelated chatter.
  const isDM = ev.channel_type === "im";
  if (!isMention && !isDM && links.length === 0 && !hasFiles) {
    return { type: "ignore", reason: "no mention/DM/link/photo" };
  }
  if (!rawText.trim() && links.length === 0 && !hasFiles) {
    return { type: "ignore", reason: "empty message" };
  }

  const cleaned = rawText.replace(/<@[^>]+>/g, "").trim();
  const requestText =
    cleaned ||
    (links[0]
      ? `Review this link and kick off content: ${links[0]}`
      : "Kick off content from the shared media");

  return {
    type: "kickoff",
    requestText,
    links,
    channel: typeof ev.channel === "string" ? ev.channel : undefined,
    threadTs:
      typeof ev.thread_ts === "string"
        ? ev.thread_ts
        : typeof ev.ts === "string"
          ? ev.ts
          : undefined,
    isDM,
  };
}

// ---- Company resolution for inbound (no companyId in Slack payloads) ------

/**
 * Resolve which Tethr company an inbound Slack event routes into.
 * Prefers TETHR_SLACK_COMPANY_ID; otherwise the company that has the @tethr
 * coordinator seeded (Phase 11 clean slate); legacy name lookup last.
 */
export async function resolveTethrCompanyId(db: Db): Promise<string | null> {
  const override = process.env.TETHR_SLACK_COMPANY_ID?.trim();
  if (override) return override;
  const [tethr] = await db
    .select({ companyId: tethrAgentProfiles.companyId })
    .from(tethrAgentProfiles)
    .where(eq(tethrAgentProfiles.tag, "@tethr"))
    .limit(1);
  if (tethr) return tethr.companyId;
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, LEGACY_COMPANY_NAME))
    .limit(1);
  return row?.id ?? null;
}

// ---- Inbound routing + Socket Mode (local-friendly, no public URL) ---------

/** A DM is one rolling conversation; a reply after this gap starts fresh. */
const DM_CONTINUITY_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
/** Skip the "On it" ack when the run answers within this window. */
const ACK_AFTER_MS = 4000;
/** Slack messages cap ~4k chars; chunk below that with headroom. */
const SLACK_CHUNK_CHARS = 2900;
const MAX_ANSWER_CHUNKS = 4;

/** Origin key so a later message from the same Slack thread/DM continues it. */
export function slackSourceKey(interp: {
  channel?: string;
  threadTs?: string;
  isDM?: boolean;
}): string | null {
  if (!interp.channel) return null;
  // A DM channel is 1:1 — the whole DM is one rolling conversation.
  if (interp.isDM) return `slack:im:${interp.channel}`;
  // A channel thread is a conversation; the thread root ties replies together.
  if (interp.threadTs) return `slack:${interp.channel}:${interp.threadTs}`;
  return null;
}

/** "new topic" / "start over" forces a fresh conversation even in a live DM. */
export function isResetPhrase(text: string): boolean {
  return /^\s*(new topic|start over|new thread|reset|nvm|never ?mind)\b/i.test(text);
}

/** Split a long answer into Slack-sized chunks on paragraph/line boundaries. */
export function chunkSlackText(text: string, max = SLACK_CHUNK_CHARS): string[] {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > max) {
    // Prefer a paragraph break, then a line break, then a hard cut.
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Resume the conversation thread for a Slack origin, if one is live. Channel
 * threads always continue; DMs continue within a rolling window unless the
 * user opens a new topic. Returns the threadId to reuse, or null to start fresh.
 */
export async function resolveContinuationThreadId(
  db: Db,
  companyId: string,
  sourceKey: string | null,
  opts: { isDM?: boolean; nowMs?: number } = {},
): Promise<string | null> {
  if (!sourceKey) return null;
  const [prior] = await db
    .select({ threadId: tethrRouteRuns.threadId, createdAt: tethrRouteRuns.createdAt })
    .from(tethrRouteRuns)
    .where(
      and(
        eq(tethrRouteRuns.companyId, companyId),
        eq(tethrRouteRuns.sourceKey, sourceKey),
      ),
    )
    .orderBy(desc(tethrRouteRuns.createdAt))
    .limit(1);
  if (!prior?.threadId) return null;
  if (!opts.isDM) return prior.threadId; // a channel thread is a conversation
  const now = opts.nowMs ?? Date.now();
  const age = now - new Date(prior.createdAt).getTime();
  return age <= DM_CONTINUITY_WINDOW_MS ? prior.threadId : null;
}

/**
 * Turn an interpreted kickoff into a routed Tethr task: the answer is posted
 * back to the originating thread when the run finishes (a quick "On it" ack
 * only if the run is slow). Replies in the same Slack thread/DM continue the
 * conversation with context. Shared by the HTTP events endpoint (cloud) and
 * the Socket Mode client (local) — @tethr absorbs any request, same entry
 * point as the Console chat.
 */
export async function routeInboundKickoff(
  db: Db,
  interp: { requestText: string; channel?: string; threadTs?: string; isDM?: boolean },
): Promise<{ routeRunId: string; threadId: string } | null> {
  const companyId = await resolveTethrCompanyId(db);
  if (!companyId) {
    logger.warn("tethr slack: no Tethr company resolved for inbound kickoff");
    return null;
  }
  // Continuity: reuse the live thread for this Slack origin unless the user
  // explicitly opens a new topic.
  const sourceKey = slackSourceKey(interp);
  const threadId = isResetPhrase(interp.requestText)
    ? null
    : await resolveContinuationThreadId(db, companyId, sourceKey, { isDM: interp.isDM });

  // Dynamic import breaks the notify → slack → routing → notify module cycle.
  const { routingService } = await import("./routing.js");
  const routing = routingService(db);
  let runPromise!: Promise<{ status: string; resultText: string }>;
  const ids = await new Promise<{ routeRunId: string; threadId: string }>((resolve, reject) => {
    runPromise = routing
      .routeRequest({
        companyId,
        requestText: interp.requestText,
        invocationSource: "api",
        threadId,
        sourceKey,
        hopDelayMs: 0,
        onStarted: resolve,
      })
      .catch((err) => {
        reject(err);
        return { status: "failed", resultText: err instanceof Error ? err.message : String(err) };
      });
  });

  // Ack only if the answer is slow — a fast reply just answers, like a person.
  let settled = false;
  const ackTimer = setTimeout(() => {
    if (settled) return;
    void postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: "On it — answer coming in this thread.",
    });
  }, ACK_AFTER_MS);

  // Post the actual answer back to the thread when the run finishes. Fire and
  // forget: the events endpoint must return fast, Slack retries on slow acks.
  void runPromise
    .then(async (result) => {
      settled = true;
      clearTimeout(ackTimer);
      await postAnswerToThread(interp, result);
    })
    .catch((err) => {
      settled = true;
      clearTimeout(ackTimer);
      logger.warn({ err }, "tethr slack: failed to post the answer back");
    });
  return ids;
}

/** Post a run's result to the originating thread, chunking long answers. */
async function postAnswerToThread(
  interp: { channel?: string; threadTs?: string },
  result: { status: string; resultText: string },
): Promise<void> {
  const answer = (result.resultText || "").trim();
  if (result.status === "failed") {
    await postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: `That didn't work: ${answer.slice(0, 500) || "unknown error"}`,
    });
    return;
  }
  if (!answer) {
    await postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: "Done — no text output (check the Tethr Console).",
    });
    return;
  }
  const gatedNote =
    "\n\n_This is staged in the Tethr Queue — review it before it goes anywhere._";
  const full = result.status === "gated" ? answer + gatedNote : answer;
  const chunks = chunkSlackText(full);
  const posted = chunks.slice(0, MAX_ANSWER_CHUNKS);
  if (chunks.length > MAX_ANSWER_CHUNKS) {
    posted[posted.length - 1] += "\n\n_(truncated — full text in the Tethr Console)_";
  }
  for (const chunk of posted) {
    await postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: chunk,
    });
  }
}

/** Minimal WebSocket surface we use (avoids a DOM lib dependency in tsconfig). */
interface SlackWs {
  onmessage: (ev: { data: unknown }) => void;
  onclose: () => void;
  onerror: () => void;
  send(data: string): void;
  close(): void;
}

/**
 * Slack Socket Mode: receive events over an outbound WebSocket — no public URL,
 * no tunnel — so tag/DM works with the whole stack on a laptop. Enabled by
 * `SLACK_APP_TOKEN` (xapp-…, scope `connections:write`). Needs a global
 * WebSocket (Node ≥ 22); logs + no-ops otherwise. Fire-and-forget; reconnects.
 */
export async function startSlackSocketMode(db: Db): Promise<void> {
  const appToken = process.env.SLACK_APP_TOKEN?.trim();
  if (!appToken) return;
  const WS = (globalThis as unknown as { WebSocket?: new (url: string) => SlackWs }).WebSocket;
  if (!WS) {
    logger.warn("SLACK_APP_TOKEN set but no global WebSocket (need Node ≥ 22); Socket Mode disabled");
    return;
  }
  let stopped = false;
  const scheduleReconnect = () => {
    if (!stopped) setTimeout(() => void connect(), 5000);
  };
  const connect = async (): Promise<void> => {
    if (stopped) return;
    let url: string | undefined;
    try {
      const res = await fetch("https://slack.com/api/apps.connections.open", {
        method: "POST",
        headers: {
          authorization: `Bearer ${appToken}`,
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) {
        logger.warn({ error: data.error }, "slack socket: apps.connections.open failed");
        scheduleReconnect();
        return;
      }
      url = data.url;
    } catch (err) {
      logger.warn({ err }, "slack socket: open error");
      scheduleReconnect();
      return;
    }
    if (!url) {
      scheduleReconnect();
      return;
    }
    const ws = new WS(url);
    ws.onmessage = (ev: { data: unknown }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        logger.info("tethr slack: Socket Mode connected");
        return;
      }
      if (typeof msg.envelope_id === "string") {
        try {
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        } catch {
          /* ack is best-effort */
        }
      }
      if (msg.type === "disconnect") {
        try {
          ws.close();
        } catch {
          /* onclose schedules reconnect */
        }
        return;
      }
      if (msg.type === "events_api" && msg.payload) {
        const interp = interpretSlackEvent(msg.payload);
        if (interp.type === "kickoff") {
          void routeInboundKickoff(db, interp).catch((err) =>
            logger.warn({ err }, "tethr slack: Socket Mode route failed"),
          );
        }
      }
    };
    ws.onclose = () => scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose schedules reconnect */
      }
    };
  };
  void connect();
}
