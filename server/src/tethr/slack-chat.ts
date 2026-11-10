import path from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ATTACH_LIMITS, saveAttachment, withAttachments } from "./assistant/attachments.js";
import type { SlackReplyTarget } from "./assistant/gate.js";
import { resolveInFiles } from "./assistant/files.js";
import { workspaceDir } from "./assistant/workspace.js";
import { mirrorDir } from "./mirror.js";
import { logFailure } from "./best-effort.js";
import * as chats from "./chats.js";
import { companyProfileService } from "./company.js";
import { getIntegrations } from "./integrations.js";
import {
  chunkSlackText,
  isSlackFileUrl,
  type SlackFileRef,
  normalizeToClaudeImage,
  postSlackMessage,
  slackBotToken,
  slackDecisionIntent,
  slackSourceKey,
  toSlackMrkdwn,
} from "./slack.js";
import { SECOND } from "./time.js";

// Phase 26.1: one brain behind every door. A message to tethr in Slack from a
// company admin reaches the same tethr as the app's chat (memory, recall,
// connectors, goals, team), not the old classic engine:
// - a DM with the bot is the main chat, the same ongoing conversation as the app;
// - a channel thread gets its own side chat ("Slack: …"), the same one for every
//   reply in that thread.
// The answer is posted back where it was asked. Everyone else in Slack still
// reaches the classic engine: the chat brain uses the admin's own connectors
// (reading Gmail or Drive needs no approval), so only an admin may drive it.
//
// A channel thread can be read by others there, so an answer from a chat that
// has read connector data goes to the asker privately, with a note in the thread.

/** The Slack poster (swappable in tests). */
export type ChatSlackPoster = (input: { channel?: string; threadTs?: string; text: string }) => Promise<{ ok: boolean; error?: string }>;
let poster: ChatSlackPoster = (input) => postSlackMessage(input);
export function setSlackChatPosterForTests(p: ChatSlackPoster | null): void {
  poster = p ?? ((input) => postSlackMessage(input));
}

const ACK_AFTER_MS = 4 * SECOND;
const MAX_ANSWER_CHUNKS = 4;

/** A Slack reply target read back from stored meta (an approval card's), or undefined. */
export function slackReplyTargetOf(raw: unknown): SlackReplyTarget | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.channel !== "string" || !r.channel || typeof r.askedBy !== "string" || !r.askedBy) return undefined;
  return {
    channel: r.channel,
    ...(typeof r.threadTs === "string" && r.threadTs ? { threadTs: r.threadTs } : {}),
    dm: r.dm === true,
    askedBy: r.askedBy,
  };
}

/** The admin driving tethr from Slack, when this sender is one and the chat
 * brain is the company's engine. Anyone else gets the classic engine. */
export async function chatBrainAsker(db: Db, companyId: string, slackUserId: string | undefined): Promise<{ slackId: string; name: string } | null> {
  if (!slackUserId) return null;
  if (getIntegrations(companyId).assistant.engine !== "session") return null;
  const admins = await companyProfileService(db).adminSlackIds(companyId);
  return admins.find((a) => a.slackId === slackUserId) ?? null;
}

// ---- files ------------------------------------------------------------------------

export { extractSlackFiles, type SlackFileRef } from "./slack.js";

export type SlackDownloader = (file: SlackFileRef) => Promise<Buffer>;

/** Download a Slack file with the bot token, only from Slack's own file host. */
const downloadFromSlack: SlackDownloader = async (file) => {
  const token = slackBotToken();
  if (!token) throw new Error("the Slack bot token isn't set");
  if (!isSlackFileUrl(file.url)) throw new Error("it isn't on Slack's file host");
  if (file.size && file.size > ATTACH_LIMITS.bytes) throw new Error("it's over 20 MB");
  const res = await fetch(file.url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30 * SECOND) });
  if (!res.ok) throw new Error(`Slack answered ${res.status}`);
  // Without the files:read scope, Slack answers a file link with its login page.
  if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new Error("the Slack app needs the files:read permission");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("it was empty");
  if (buf.byteLength > ATTACH_LIMITS.bytes) throw new Error("it's over 20 MB");
  return buf;
};

/** Any image Slack sends (HEIC from an iPhone, oversized photos) becomes a JPEG the chat can open. */
async function forTheChat(file: SlackFileRef, data: Buffer): Promise<{ name: string; data: Buffer }> {
  const isImage = file.mimeType.startsWith("image/") || /\.(heic|heif|tiff?|avif|bmp|png|jpe?g|gif|webp)$/i.test(file.name);
  if (!isImage) return { name: file.name, data };
  const stem = path.basename(file.name, path.extname(file.name)) || "image";
  return { name: `${stem}.jpg`, data: await normalizeToClaudeImage(data) };
}

/** Save what someone sent into the chat's uploads. Returns the saved paths and what was skipped (with why). */
export async function saveSlackFiles(
  files: SlackFileRef[],
  download: SlackDownloader = downloadFromSlack,
): Promise<{ paths: string[]; skipped: Array<{ name: string; why: string }> }> {
  const paths: string[] = [];
  const skipped: Array<{ name: string; why: string }> = [];
  for (const file of files) {
    try {
      const { name, data } = await forTheChat(file, await download(file));
      const saved = await saveAttachment(workspaceDir().dir, name, data);
      if ("error" in saved) skipped.push({ name: file.name, why: saved.error });
      else paths.push(saved.path);
    } catch (err) {
      skipped.push({ name: file.name, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return { paths, skipped };
}

// ---- starting a turn ----------------------------------------------------------

export interface SlackChatRequest {
  requestText: string;
  channel: string;
  threadTs?: string;
  isDM?: boolean;
  userId: string;
  files?: SlackFileRef[];
}

const acks = new Map<string, NodeJS.Timeout>();

/** The newest card still waiting on a person in this chat. */
async function pendingCardInThread(db: Db, companyId: string, threadId: string) {
  const [row] = await db
    .select({ output: tethrOutputs })
    .from(tethrOutputs)
    .innerJoin(tethrRouteRuns, eq(tethrRouteRuns.id, tethrOutputs.routeRunId))
    .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrRouteRuns.threadId, threadId), inArray(tethrOutputs.status, ["gated", "changes_requested"])))
    .orderBy(desc(tethrOutputs.createdAt))
    .limit(1);
  return row?.output ?? null;
}

/**
 * Hand a Slack message from an admin to the chat brain. Returns the turn, or
 * null when the message was handled without one (an approve/reject reply).
 */
export async function startSlackChatTurn(
  db: Db,
  companyId: string,
  req: SlackChatRequest,
  asker: { slackId: string; name: string },
  deps: { download?: SlackDownloader } = {},
): Promise<{ routeRunId: string; threadId: string } | null> {
  const sourceKey = slackSourceKey(req);
  const reply = (text: string) => poster({ channel: req.channel, threadTs: req.threadTs, text });
  // A DM is the main chat; a channel thread is its own side chat.
  const threadId = req.isDM ? chats.mainThreadId(companyId) : sourceKey ? chats.slackLinkedThread(companyId, sourceKey) : null;

  // "approve" / "reject" in a conversation with a card waiting decides it.
  const decision = slackDecisionIntent(req.requestText);
  if (decision && threadId && !req.files?.length) {
    const card = await pendingCardInThread(db, companyId, threadId);
    if (card) {
      const { gatingService } = await import("./gating.js");
      try {
        await gatingService(db).decide({ companyId, outputId: card.id, decision, reviewer: `${asker.name} (Slack)` });
        await reply(
          decision === "approve"
            ? card.kind === "external_action"
              ? `Approved: ${card.title}. Running it now; the result comes here.`
              : `Approved: ${card.title}.`
            : `Rejected: ${card.title}. Nothing was done.`,
        );
      } catch (err) {
        await reply(`Couldn't ${decision} that: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  let text = req.requestText;
  if (req.files?.length) {
    const { paths, skipped } = await saveSlackFiles(req.files, deps.download);
    if (skipped.length) {
      await reply(`I couldn't open ${skipped.map((s) => `${s.name} (${s.why})`).join(", ")}.`);
    }
    if (!paths.length && !req.requestText.trim()) return null;
    // Phase 26.3: files sent with no message go to tethr's Inbox to be filed.
    if (!req.requestText.trim() && mirrorDir()) {
      const { inboxService } = await import("./inbox/pipeline.js");
      const names: string[] = [];
      for (const rel of paths) {
        const resolved = resolveInFiles(workspaceDir().dir, rel, "file");
        if ("error" in resolved) continue;
        const item = await inboxService(db).takeWorkspaceFile(companyId, resolved.abs, "slack").catch(logFailure("Slack file to the Inbox"));
        if (item) names.push(item.name);
      }
      if (names.length) {
        await reply(`Put ${names.join(", ")} in tethr's Inbox. Where ${names.length === 1 ? "it goes" : "they go"} is waiting for you in tethr.`);
        return null;
      }
    }
    text = withAttachments(text, paths);
  }

  const { getAssistantRunner } = await import("./assistant/runner.js");
  const target: SlackReplyTarget = { channel: req.channel, ...(req.threadTs ? { threadTs: req.threadTs } : {}), dm: req.isDM === true, askedBy: req.userId };
  const ids = await getAssistantRunner(db).send({ companyId, threadId, text, kind: "user", slack: target });
  if (!threadId && sourceKey) {
    await chats.linkSlackThread(companyId, sourceKey, ids.threadId);
    await chats.addSideChat(companyId, ids.threadId, `Slack: ${chats.chatTitle(req.requestText || "files")}`);
  }

  // A slow answer gets a quick "on it" (a fast one just answers, like a person).
  const timer = setTimeout(() => {
    acks.delete(ids.routeRunId);
    void reply("On it. The answer will come here.").catch(logFailure("posting a Slack ack"));
  }, ACK_AFTER_MS);
  timer.unref?.();
  acks.set(ids.routeRunId, timer);
  return ids;
}

// ---- the answer ---------------------------------------------------------------

function answerChunks(text: string): string[] {
  const chunks = chunkSlackText(toSlackMrkdwn(text));
  const shown = chunks.slice(0, MAX_ANSWER_CHUNKS);
  if (chunks.length > MAX_ANSWER_CHUNKS) shown[shown.length - 1] += "\n\n_(The rest is in tethr's chat.)_";
  return shown;
}

/**
 * Post a finished turn's answer to the Slack conversation it came from (the
 * runner calls this when a Slack turn ends). With cards waiting on approval,
 * says so and how to decide. In a channel thread, a chat that has read
 * connector data answers the asker privately instead.
 */
export async function deliverSlackTurn(
  db: Db,
  input: { companyId: string; threadId: string; runId: string; target: SlackReplyTarget },
): Promise<void> {
  const timer = acks.get(input.runId);
  if (timer) clearTimeout(timer);
  acks.delete(input.runId);

  const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, input.runId));
  if (!row) return;
  const answer =
    row.status === "failed"
      ? `That didn't work: ${(row.error ?? row.resultText ?? "unknown error").slice(0, 500)}`
      : row.status === "stopped"
        ? "Stopped."
        : (row.resultText ?? "").trim() || "Done (no text answer; see the chat in tethr).";
  const cards = await db
    .select({ id: tethrOutputs.id, title: tethrOutputs.title })
    .from(tethrOutputs)
    .where(and(eq(tethrOutputs.routeRunId, input.runId), inArray(tethrOutputs.status, ["gated", "changes_requested"])));

  const t = input.target;
  const privately = !t.dm && chats.isTainted(input.companyId, input.threadId);
  if (privately) {
    await poster({
      channel: t.channel,
      threadTs: t.threadTs,
      text: "This answer uses data from your connected tools, so I sent it to you directly.",
    });
    for (const chunk of answerChunks(answer)) await poster({ channel: t.askedBy, text: chunk });
    if (cards.length) {
      await poster({
        channel: t.askedBy,
        text: `Waiting for your approval in tethr: ${cards.map((c) => `*${c.title}*`).join("; ")}. Decide it in tethr's Queue.`,
      });
    }
    return;
  }
  for (const chunk of answerChunks(answer)) await poster({ channel: t.channel, threadTs: t.threadTs, text: chunk });
  if (cards.length) {
    await poster({
      channel: t.channel,
      threadTs: t.threadTs,
      text:
        cards.length === 1
          ? `Waiting for your approval: *${cards[0]!.title}*. Reply *approve* or *reject* here, or decide it in tethr.`
          : `Waiting for your approval: ${cards.map((c) => `*${c.title}*`).join("; ")}. Reply *approve* or *reject* here to decide the newest, or decide them in tethr.`,
    });
  }
  logger.debug({ runId: input.runId, privately }, "tethr slack: chat answer posted");
}
