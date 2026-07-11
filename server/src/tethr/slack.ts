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
// inbound turns a tagged link/photo into a routed Helm task (intake).

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const SLACK_API = "https://slack.com/api";

/** Default #scout channel from the bundle. Override with SLACK_SCOUT_CHANNEL. */
export const DEFAULT_SCOUT_CHANNEL = "C0AE02FJR5Y";

/** Wandr Growth company name (the seeded Tethr company). */
const TETHR_COMPANY_NAME = "Wandr Growth";

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
  };
}

// ---- Company resolution for inbound (no companyId in Slack payloads) ------

/**
 * Resolve which Tethr company an inbound Slack event routes into.
 * Prefers TETHR_SLACK_COMPANY_ID; otherwise the seeded "Wandr Growth".
 */
export async function resolveTethrCompanyId(db: Db): Promise<string | null> {
  const override = process.env.TETHR_SLACK_COMPANY_ID?.trim();
  if (override) return override;
  const [row] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, TETHR_COMPANY_NAME))
    .limit(1);
  return row?.id ?? null;
}

// ---- Inbound routing + Socket Mode (local-friendly, no public URL) ---------

/**
 * Turn an interpreted kickoff into a routed Helm task + threaded ack. Shared by
 * the HTTP events endpoint (cloud) and the Socket Mode client (local). Helm is
 * the router that absorbs any request and routes it — same entry point as the
 * Console chat, so a Slack DM/tag and a Console message behave identically.
 */
export async function routeInboundKickoff(
  db: Db,
  interp: { requestText: string; channel?: string; threadTs?: string },
): Promise<{ routeRunId: string; threadId: string } | null> {
  const companyId = await resolveTethrCompanyId(db);
  if (!companyId) {
    logger.warn("tethr slack: no Tethr company resolved for inbound kickoff");
    return null;
  }
  // Dynamic import breaks the notify → slack → routing → notify module cycle.
  const { routingService } = await import("./routing.js");
  const routing = routingService(db);
  const ids = await new Promise<{ routeRunId: string; threadId: string }>((resolve, reject) => {
    routing
      .routeRequest({
        companyId,
        requestText: interp.requestText,
        invocationSource: "api",
        hopDelayMs: 0,
        onStarted: resolve,
      })
      .catch(reject);
  });
  await postSlackMessage({
    channel: interp.channel,
    threadTs: interp.threadTs,
    text: `On it — routing to Helm (task ${ids.routeRunId}). I'll follow up here.`,
  });
  return ids;
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
  const WS = (globalThis as { WebSocket?: new (url: string) => SlackWs }).WebSocket;
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
