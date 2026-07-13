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
import { matchMetaCommand, renderHelpMessage } from "./commands.js";
import type { LLMImageAttachment } from "./llm/types.js";
import { memoryService } from "./memory.js";

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

/** An image shared in Slack: a private URL (needs the bot token) + metadata. */
export interface SlackImageRef {
  url: string;
  mimeType: string;
  name?: string;
  size?: number;
}

export type SlackInterpretation =
  | { type: "challenge"; challenge: string }
  | {
      type: "kickoff";
      requestText: string;
      links: string[];
      channel?: string;
      threadTs?: string;
      isDM?: boolean;
      images?: SlackImageRef[];
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
  const images = extractImageFiles(ev.files);
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
      ? `Take a look at this link: ${links[0]}`
      : images.length
        ? "Take a look at the attached image(s) and tell me what you see."
        : "Take a look at the shared file.");

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
    images: images.length ? images : undefined,
  };
}

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;
/** Vision guardrails: cap count and per-image bytes. */
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

/** Pull image files (screenshots, photos) out of a Slack event's files array. */
export function extractImageFiles(files: unknown): SlackImageRef[] {
  if (!Array.isArray(files)) return [];
  const out: SlackImageRef[] = [];
  for (const f of files) {
    const file = f as Record<string, unknown>;
    const mimeType = String(file.mimetype ?? "");
    const url = String(file.url_private_download ?? file.url_private ?? "");
    if (!url || !IMAGE_MIME_RE.test(mimeType)) continue;
    out.push({
      url,
      mimeType: mimeType.toLowerCase().replace("image/jpg", "image/jpeg"),
      name: typeof file.name === "string" ? file.name : undefined,
      size: typeof file.size === "number" ? file.size : undefined,
    });
  }
  return out;
}

/**
 * Download Slack images (private URLs need the bot token) and base64-encode them
 * for the vision model. Skips oversized files, caps the count, and never throws
 * — a failed image just doesn't get attached. No-op under test / without a token.
 */
export async function fetchSlackImageAttachments(
  images: SlackImageRef[],
): Promise<LLMImageAttachment[]> {
  if (underTest()) return [];
  const token = slackBotToken();
  if (!token || !images.length) return [];
  const out: LLMImageAttachment[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    if (img.size && img.size > MAX_IMAGE_BYTES) {
      logger.warn({ name: img.name, size: img.size }, "tethr slack: image too large, skipped");
      continue;
    }
    try {
      const res = await fetch(img.url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        logger.warn({ name: img.name, status: res.status }, "tethr slack: image download failed");
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES || buf.byteLength === 0) continue;
      out.push({ mimeType: img.mimeType, dataBase64: buf.toString("base64"), name: img.name });
    } catch (err) {
      logger.warn({ err, name: img.name }, "tethr slack: image fetch error");
    }
  }
  return out;
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

// ---- Overseer resolution (who to tag when an agent needs a human) ----------

export interface Overseer {
  /** Slack user id for an @-mention, if known. */
  slackId?: string;
  /** Display name, for the message text / fallback when no slackId. */
  name: string;
}

/**
 * The human who oversees an agent: the agent's assigned overseer, else the org
 * default (TETHR_DEFAULT_OVERSEER_SLACK_ID / _NAME). This is who gets tagged in
 * the originating thread when the agent stages work for approval or escalates.
 */
export async function resolveOverseer(
  db: Db,
  companyId: string,
  agentTag: string,
): Promise<Overseer> {
  const [profile] = await db
    .select({
      slackId: tethrAgentProfiles.overseerSlackId,
      name: tethrAgentProfiles.overseerName,
    })
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, agentTag)))
    .limit(1);
  const slackId =
    profile?.slackId?.trim() || process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID?.trim() || undefined;
  const name =
    profile?.name?.trim() || process.env.TETHR_DEFAULT_OVERSEER_NAME?.trim() || "the overseer";
  return { slackId, name };
}

/** Slack @-mention when we have a user id, otherwise the plain display name. */
export function overseerMention(o: Overseer): string {
  return o.slackId ? `<@${o.slackId}>` : o.name;
}

/** The `/agents` roster: every agent and who oversees it. Deterministic. */
export async function renderAgentsMessage(db: Db, companyId: string): Promise<string> {
  const profiles = await db
    .select({ tag: tethrAgentProfiles.tag, codename: tethrAgentProfiles.codename })
    .from(tethrAgentProfiles)
    .where(eq(tethrAgentProfiles.companyId, companyId))
    .orderBy(tethrAgentProfiles.tag);
  const lines: string[] = [];
  for (const p of profiles) {
    const o = await resolveOverseer(db, companyId, p.tag);
    lines.push(`• *${p.tag}* — ${p.codename} (overseer: ${overseerMention(o)})`);
  }
  return [
    "*Team roster*",
    lines.length ? lines.join("\n") : "• Just me for now.",
    "",
    "Specialists get added one at a time, each with its own human overseer. Ask me what's next.",
  ].join("\n");
}

// ---- Inbound routing + Socket Mode (local-friendly, no public URL) ---------

/** A DM is one rolling conversation; a reply after this gap starts fresh. */
const DM_CONTINUITY_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
/** Skip the "On it" ack when the run answers within this window. */
const ACK_AFTER_MS = 4000;
/** Slack messages cap ~4k chars; chunk below that with headroom. */
const SLACK_CHUNK_CHARS = 2900;
const MAX_ANSWER_CHUNKS = 4;
/** A wipe must be confirmed within this window or the request lapses. */
const RESET_CONFIRM_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Wipes are two-step to avoid accidents: a reset command asks for confirmation
 * and parks the request here (keyed by Slack origin) until the next message
 * confirms it. In-memory by design — a confirmation is seconds-long and never
 * needs to survive a restart. Any carried question is answered after the wipe.
 */
const pendingResets = new Map<string, { question: string; expiresAt: number }>();

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

/**
 * A leading command that wipes the conversation: "reset", "new topic",
 * "clear/wipe (the chat|memory|context)", "forget everything", "fresh start".
 * Matched at the start so a normal question mentioning "reset" isn't caught.
 */
const RESET_RE =
  /^\s*(new topic|start over|new (chat|thread|conversation)|reset|clean\s?up(\s+(the\s+)?(chat|memory|context|conversation))?|clean slate|clear(\s+(the\s+)?(chat|memory|context|conversation))?|wipe(\s+(the\s+)?(chat|memory|context|conversation))?|forget(\s+(all|everything|the\s+(chat|context|conversation)))?|fresh start|nvm|never\s?mind)\b[\s,:.!—-]*/i;

/** True when the message opens with a reset/wipe command. */
export function isResetPhrase(text: string): boolean {
  return RESET_RE.test(text);
}

/** Remove a leading reset command, returning any real request that followed. */
export function stripResetPhrase(text: string): string {
  return text.replace(RESET_RE, "").trim();
}

/** A short yes to a confirmation prompt (wipe only proceeds on this). */
export function isAffirmative(text: string): boolean {
  return /^\s*(y|yes+|yep|yeah|yup|confirm(ed)?|do it|go( ahead)?|sure|ok(ay)?|clear it|wipe it|please do)\b[\s.!]*$/i.test(
    text,
  );
}

/** Split a long answer into Slack-sized chunks on paragraph/line boundaries. */
// ---- Markdown → Slack mrkdwn -----------------------------------------------
// The LLM answers in GitHub-flavored Markdown (great for the Console + Drive).
// Slack speaks a different dialect: *bold* not **bold**, _italic_, no `##`
// headers, and NO tables. This converts at the Slack boundary only, so posts
// never show raw `##` or `| pipe | tables |`. The canonical answer stays GFM.

function slackInline(s: string): string {
  // Shield inline code spans so we don't rewrite Markdown inside them.
  const codes: string[] = [];
  let t = s.replace(/`[^`]+`/g, (m) => {
    codes.push(m);
    return ` ${codes.length - 1} `;
  });
  t = t
    // [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, "<$2|$1>")
    // **bold** / __bold__ → *bold* (Slack has no separate strong)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*");
  return t.replace(/ (\d+) /g, (_, n) => codes[Number(n)]);
}

function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Convert a GFM table into a Slack-readable bulleted list (Slack has no tables). */
function renderTableRow(header: string[], cells: string[]): string {
  const first = slackInline(cells[0] ?? "");
  const rest = cells
    .slice(1)
    .map((c, idx) => {
      if (!c) return "";
      const label = header[idx + 1];
      return label ? `${slackInline(label)}: ${slackInline(c)}` : slackInline(c);
    })
    .filter(Boolean);
  return `•  *${first}*${rest.length ? " — " + rest.join(" · ") : ""}`;
}

export function toSlackMrkdwn(md: string): string {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: pass through verbatim (Slack supports ```).
    if (/^\s*```/.test(line)) {
      out.push(line);
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) out.push(lines[i++]);
      if (i < lines.length) out.push(lines[i++]); // closing fence
      continue;
    }

    // GFM table: a row of cells + a separator row of dashes → bullets.
    const next = lines[i + 1] ?? "";
    if (
      line.includes("|") &&
      /\|/.test(next) &&
      /^[\s|:-]+$/.test(next) &&
      /-/.test(next)
    ) {
      const header = splitTableRow(line);
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        out.push(renderTableRow(header, splitTableRow(lines[i])));
        i++;
      }
      continue;
    }

    // Headers `## Title` → *Title*
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      out.push(`*${slackInline(h[1])}*`);
      i++;
      continue;
    }

    // Horizontal rule → blank line
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("");
      i++;
      continue;
    }

    // Bullets `- ` / `* ` / `+ ` → `• ` (keep indentation)
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (b) {
      out.push(`${b[1]}•  ${slackInline(b[2])}`);
      i++;
      continue;
    }

    out.push(slackInline(line));
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
 * Wipe the conversation for a Slack origin: forget the coordinator's recent
 * run-history (so recency recall stops bleeding old chatter in) and drop a
 * reset marker so a later message in this DM/thread starts from a clean slate
 * instead of resuming the pre-reset conversation. Best-effort.
 */
export async function handleConversationReset(
  db: Db,
  companyId: string,
  sourceKey: string | null,
): Promise<void> {
  // Forget @tethr's run-history memories (kind "history" only — facts, rules,
  // and seeded knowledge are untouched).
  const [coordinator] = await db
    .select({ agentId: tethrAgentProfiles.agentId })
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
    .limit(1);
  if (coordinator) {
    await memoryService(db).clearHistory(companyId, coordinator.agentId).catch(() => {});
  }
  // Cap the conversation: a marker run with a fresh thread so continuity for
  // this origin resolves past everything said before the reset.
  if (sourceKey) {
    const [marker] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId,
        requestText: "(conversation reset)",
        invocationSource: "api",
        sourceKey,
        status: "done",
        resultText: "Conversation reset by the user.",
        llmProvider: "system",
      })
      .returning({ id: tethrRouteRuns.id });
    if (marker) {
      await db
        .update(tethrRouteRuns)
        .set({ threadId: marker.id })
        .where(eq(tethrRouteRuns.id, marker.id));
    }
  }
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
  interp: {
    requestText: string;
    channel?: string;
    threadTs?: string;
    isDM?: boolean;
    images?: SlackImageRef[];
  },
): Promise<{ routeRunId: string; threadId: string } | null> {
  const companyId = await resolveTethrCompanyId(db);
  if (!companyId) {
    logger.warn("tethr slack: no Tethr company resolved for inbound kickoff");
    return null;
  }

  const sourceKey = slackSourceKey(interp);
  const now = Date.now();

  // Built-in commands. "/help" and "help" both work (leading slash optional),
  // so they act like slash commands without Slack's native registration. A
  // bare word must match exactly; a slash signals intent, so "/agents foo" also
  // matches on the first word.
  const slashPrefixed = interp.requestText.trim().startsWith("/");
  const bareCommand = interp.requestText.trim().replace(/^\/+/, "").trim();
  const meta = matchMetaCommand(bareCommand, { firstWord: slashPrefixed });
  if (meta === "help") {
    await postSlackMessage({ channel: interp.channel, threadTs: interp.threadTs, text: renderHelpMessage() });
    return null;
  }
  if (meta === "agents") {
    await postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: await renderAgentsMessage(db, companyId),
    });
    return null;
  }
  // An explicit "/something" we don't recognize (and isn't a wipe) → nudge to help.
  if (interp.requestText.trim().startsWith("/") && bareCommand && !isResetPhrase(bareCommand)) {
    const attempted = bareCommand.split(/\s+/)[0];
    await postSlackMessage({
      channel: interp.channel,
      threadTs: interp.threadTs,
      text: `I don't know the command \`/${attempted}\`. Try \`/help\` to see what I can do.`,
    });
    return null;
  }

  // Wipes are confirmed, not immediate. A reset command asks first and parks
  // any carried question; the next message confirms (wipe) or cancels (route
  // it normally). Requires a sourceKey to correlate the two turns.
  let requestText = interp.requestText;
  let forceFresh = false;
  if (sourceKey) {
    if (isResetPhrase(bareCommand)) {
      // New/repeat reset command → confirm before wiping. Don't route yet.
      pendingResets.set(sourceKey, {
        question: stripResetPhrase(bareCommand),
        expiresAt: now + RESET_CONFIRM_TTL_MS,
      });
      await postSlackMessage({
        channel: interp.channel,
        threadTs: interp.threadTs,
        text: "This clears what I remember from our current conversation (your standing facts and settings stay). Reply *yes* to confirm — or just keep chatting to cancel.",
      });
      return null;
    }
    const pending = pendingResets.get(sourceKey);
    if (pending) {
      pendingResets.delete(sourceKey);
      if (pending.expiresAt > now && isAffirmative(interp.requestText)) {
        await handleConversationReset(db, companyId, sourceKey);
        if (!pending.question) {
          await postSlackMessage({
            channel: interp.channel,
            threadTs: interp.threadTs,
            text: "Cleared — fresh start. What's next?",
          });
          return null;
        }
        // A reset that carried a question ("new topic — how are ads?"): wiped,
        // now answer it in a fresh thread.
        requestText = pending.question;
        forceFresh = true;
      }
      // Not a confirmation (or expired) → the pending wipe is cancelled and this
      // message is treated as an ordinary request.
    }
  }

  // Continuity: reuse the live thread for this Slack origin unless we just reset.
  const threadId = forceFresh
    ? null
    : await resolveContinuationThreadId(db, companyId, sourceKey, { isDM: interp.isDM });

  // Download any shared screenshots so the model can see them (live vision).
  const attachments = interp.images?.length
    ? await fetchSlackImageAttachments(interp.images)
    : undefined;

  // Dynamic import breaks the notify → slack → routing → notify module cycle.
  const { routingService } = await import("./routing.js");
  const routing = routingService(db);
  type RunResult = {
    status: string;
    resultText: string;
    outputs: Array<{ title: string; gated: boolean; agentTag: string }>;
    escalations: Array<{ agentTag: string; note: string; urgency: string }>;
  };
  let runPromise!: Promise<RunResult>;
  const ids = await new Promise<{ routeRunId: string; threadId: string }>((resolve, reject) => {
    runPromise = routing
      .routeRequest({
        companyId,
        requestText,
        invocationSource: "api",
        threadId,
        sourceKey,
        attachments,
        hopDelayMs: 0,
        onStarted: resolve,
      })
      .catch((err) => {
        reject(err);
        return {
          status: "failed",
          resultText: err instanceof Error ? err.message : String(err),
          outputs: [],
          escalations: [],
        };
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
      await tagOverseersInThread(db, companyId, interp, result);
    })
    .catch((err) => {
      settled = true;
      clearTimeout(ackTimer);
      logger.warn({ err }, "tethr slack: failed to post the answer back");
    });
  return ids;
}

/**
 * When the run staged gated work or an agent escalated, tag the responsible
 * agent's human overseer directly in the originating thread — the two moments a
 * human actually needs to step in. Best-effort; never throws into the caller.
 */
async function tagOverseersInThread(
  db: Db,
  companyId: string,
  interp: { channel?: string; threadTs?: string },
  result: {
    outputs: Array<{ title: string; gated: boolean; agentTag: string }>;
    escalations: Array<{ agentTag: string; note: string; urgency: string }>;
  },
): Promise<void> {
  const lines: string[] = [];
  // Cache overseer lookups per agent so we don't re-query for each item.
  const overseerByAgent = new Map<string, Overseer>();
  const overseerFor = async (agentTag: string): Promise<Overseer> => {
    const cached = overseerByAgent.get(agentTag);
    if (cached) return cached;
    const o = await resolveOverseer(db, companyId, agentTag);
    overseerByAgent.set(agentTag, o);
    return o;
  };

  for (const esc of result.escalations) {
    const o = await overseerFor(esc.agentTag);
    const flag = esc.urgency === "high" ? " *(high priority)*" : "";
    lines.push(`${overseerMention(o)} — ${esc.agentTag} needs your call${flag}: ${esc.note}`);
  }
  for (const out of result.outputs.filter((o) => o.gated)) {
    const o = await overseerFor(out.agentTag);
    lines.push(
      `${overseerMention(o)} — ${out.agentTag} staged “${out.title}” for your review. Approve it in the Tethr Queue before it goes anywhere.`,
    );
  }
  if (!lines.length) return;
  await postSlackMessage({
    channel: interp.channel,
    threadTs: interp.threadTs,
    text: lines.join("\n"),
  });
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
  // Slack renders its own mrkdwn, not GitHub Markdown — translate so headers,
  // bold, and tables never post as raw ## / ** / | pipes |.
  const chunks = chunkSlackText(toSlackMrkdwn(full));
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
