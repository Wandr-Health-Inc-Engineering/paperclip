import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import { logFailure } from "../best-effort.js";
import { isTainted, mainThreadId } from "../chats.js";
import { connections, findConnection } from "../connections.js";
import { orgService } from "../org.js";
import { checkCleanup, cleanupCardBody, cleanupDestination, CLEANUP_LIMITS } from "./cleanup.js";
import { personalHealthReason } from "../screen.js";
import { teamService } from "../team.js";
import { askQuestion, buttonsOf, parseAsk, QuestionInputError, type Question } from "./questions.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Phase 27: how tethr and its agents reach a person without burying the ask in
// prose. `ask` puts a question in front of them as a card with buttons. Every
// agent on the team has these whatever its connectors (team-spec.ts
// AGENT_ALWAYS_TOOLS); a private turn and the sealed learner don't.

export const PERSON_TOOL_NAMES = ["ask", "need_connection", "delete_files"] as const;
export const PERSON_TOOL_SET = new Set<string>(PERSON_TOOL_NAMES);

export const PERSON_TOOL_DEFS: McpToolDef[] = [
  {
    name: "ask",
    description:
      'Ask the person a question as a card with buttons, instead of asking in your text. Use it whenever you need a yes or no, a go-ahead or a choice before you can go on ("Save these goals as they are?", "Which of these should I draft first?"). With no options the card has Approve, Reject and Comment; with 2 to 4 options it has a button for each, plus Comment. After calling it, end your reply: the answer arrives as their next message. Don\'t use it for something that has its own approval card (a new agent, anything outward): make that call instead. Don\'t ask something that\'s still waiting.',
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, in one line (at most 200 characters), clear without reading your message." },
        detail: { type: "string", description: "Optional: what they need to decide, in a few plain lines (at most 1,200 characters). Shown as plain text under the question." },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          description: "Leave out for a yes/no (Approve / Reject). Otherwise 2 to 4 choices, your recommendation first.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "The button's text, at most 40 characters." },
              description: { type: "string", description: "Optional: one line about this choice." },
            },
            required: ["label"],
          },
        },
      },
      required: ["question"],
    },
  },
  {
    name: "need_connection",
    description:
      "Say that a job can't be done without a tool or connection that's missing, switched off or not answering (see the Connections section). The person gets a card with the fix in place, plus \"I've connected it\" and \"Carry on without it\". Call it once per connection, then finish with what you have and say what you couldn't do. From an agent's chat it also stops that agent's runs until the card is answered, so nothing is spent waiting. Don't use it for something that's merely nice to have.",
    inputSchema: {
      type: "object",
      properties: {
        connector: { type: "string", description: 'What\'s missing, by its name in the Connections section (e.g. "Google Ads", "PostHog").' },
        why: { type: "string", description: "What can't be done without it, in a sentence or two. Shown on the card." },
      },
      required: ["connector", "why"],
    },
  },
  {
    name: "delete_files",
    description:
      "Remove files from ./files/ that aren't needed any more (drafts that were replaced, duplicates, scratch files), so tethr's folder doesn't get clogged. The person gets an approval card listing them; approving moves them to the archive (nothing is erased). Up to 20 files per call, paths like \"files/content/draft.md\". Use this instead of overwriting a file to \"discard\" it. Never for anything you didn't make or that someone may still use without asking first.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20, description: "Files in ./files/ to remove." },
        why: { type: "string", description: "Why they can go, in a sentence. Shown on the card." },
      },
      required: ["paths", "why"],
    },
  },
];

/**
 * The Slack line that tells an owner a question is waiting. The question's own
 * words go along only when they can't carry anything that shouldn't leave tethr:
 * the chat that asked hasn't read connector data (`tainted`), and there are no
 * health details in it. Otherwise Slack just says one is waiting.
 */
export function questionDmText(who: string, question: Question, opts: { tainted?: boolean } = {}): string {
  const base = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const where = base ? `<${base}/queue|Answer it in tethr>` : "Answer it in tethr (Needs you, or the chat).";
  const safe = !opts.tainted && personalHealthReason(`${question.question} ${question.detail ?? ""}`) === null;
  if (question.connection) return `*${question.question}*, and isn't running until it's connected or you say to carry on without it. ${where}`;
  return safe ? `${who} has a question for you: *${question.question}* ${where}` : `${who} has a question for you. ${where}`;
}

/** Tell the person a question is waiting when they aren't in the chat it was asked in:
 * an agent's own chat, or a turn tethr started itself (a task, a check-in, a routine). */
export async function tellPersonAboutQuestion(db: Db, companyId: string, question: Question, startedByTethr: boolean): Promise<void> {
  if (!question.agentTag && !startedByTethr) return;
  const who = question.agentTag ?? "tethr";
  const { notificationService } = await import("../notify.js");
  await notificationService(db)
    .send({
      companyId,
      kind: "approval",
      title: question.connection ? question.question : `${who} asks: ${question.question}`,
      body: question.detail ?? undefined,
      href: question.threadId === mainThreadId(companyId) ? "/chat" : `/chat?chat=${question.threadId}`,
      agentTag: question.agentTag ?? "@tethr",
    })
    .catch(logFailure("question bell", { questionId: question.id }));
  const { dmOverseer } = await import("../slack.js");
  await dmOverseer(db, companyId, question.agentTag ?? "@tethr", questionDmText(who, question, { tainted: isTainted(companyId, question.threadId) }));
}

async function ask(args: Record<string, unknown>, ctx: TethrToolContext & { db: Db; companyId: string; threadId: string }): Promise<TethrToolResult> {
  const parsed = parseAsk(args);
  const member = await teamService(ctx.db).byThread(ctx.companyId, ctx.threadId);
  const question = await askQuestion(ctx.companyId, { ...parsed, threadId: ctx.threadId, runId: ctx.runId ?? null, agentTag: member?.tag ?? null }, ctx.now?.() ?? new Date());
  const [run] = ctx.runId ? await ctx.db.select({ sourceKey: tethrRouteRuns.sourceKey }).from(tethrRouteRuns).where(eq(tethrRouteRuns.id, ctx.runId)) : [];
  await tellPersonAboutQuestion(ctx.db, ctx.companyId, question, run?.sourceKey === "chat-system").catch(logFailure("telling the person about a question", { questionId: question.id }));
  return {
    text: `Shown to the person as a card with ${buttonsOf(question)}. End your reply here: their answer arrives as their next message. Don't ask it again in your text, and don't act as if they had answered.`,
    meta: { questionId: question.id, options: question.options?.length ?? 0 },
  };
}

/** A missing connection, as a card with the fix. In an agent's chat it also holds the agent. */
async function needConnection(args: Record<string, unknown>, ctx: TethrToolContext & { db: Db; companyId: string; threadId: string }): Promise<TethrToolResult> {
  const name = typeof args.connector === "string" ? args.connector.trim() : "";
  const connection = name ? findConnection(ctx.companyId, name) : null;
  if (!connection) {
    return { text: `need_connection: "${name}" isn't a connection tethr knows. Use one of: ${connections(ctx.companyId).map((c) => c.key).join(", ")}. For anything else, ask the person with the ask tool.`, isError: true };
  }
  const why = typeof args.why === "string" ? args.why.replace(/\s+/g, " ").trim().slice(0, 400) : "";
  if (!why) return { text: "need_connection: say in a sentence what can't be done without it (why).", isError: true };
  const team = teamService(ctx.db);
  const member = await team.byThread(ctx.companyId, ctx.threadId);
  if (!member) {
    // tethr's own chat: a card, no hold (tethr isn't on a schedule here).
    try {
      const card = await askQuestion(ctx.companyId, { question: `Connect ${connection.key}`, detail: `${why}\nRight now: ${connection.detail}.`, options: null, threadId: ctx.threadId, runId: ctx.runId ?? null, agentTag: null, connection: { key: connection.key } }, ctx.now?.() ?? new Date());
      return { text: `Shown to the person as a card with ${buttonsOf(card)}. Carry on with what you can do without ${connection.key} and say what you couldn't; don't ask for it again.`, meta: { questionId: card.id, connection: connection.key } };
    } catch (err) {
      if (err instanceof QuestionInputError) return { text: `The person already has a card for ${connection.key}. Carry on with what you can do without it.` };
      throw err;
    }
  }
  const raised = await team.raiseNeed(ctx.companyId, member.tag, connection.key, why);
  if (raised === "waived") return { text: `The team already said to work without ${connection.key}. Don't ask for it again: do what you can and say what you couldn't.` };
  const { openNeedCards } = await import("../team-needs.js");
  const fresh = await team.get(ctx.companyId, member.tag);
  await openNeedCards(ctx.db, ctx.companyId, fresh ? await team.unmetNeeds(ctx.companyId, fresh) : [], ctx.runId ?? null);
  return {
    text: `Recorded: the person has a card to connect ${connection.key} or to tell you to carry on without it. Finish this turn with what you have and say plainly what you couldn't do. You won't be run again until they answer, so nothing is spent waiting.`,
    meta: { connection: connection.key, raised },
  };
}

/** Ask the person to remove files from files/: one approval card for the lot. */
async function deleteFiles(args: Record<string, unknown>, ctx: TethrToolContext & { db: Db; companyId: string; threadId: string }): Promise<TethrToolResult> {
  const why = typeof args.why === "string" ? args.why.replace(/\s+/g, " ").trim().slice(0, CLEANUP_LIMITS.why) : "";
  if (!why) return { text: "delete_files: say in a sentence why they can go (why).", isError: true };
  const raw = Array.isArray(args.paths) ? args.paths : [];
  if (!raw.length) return { text: "delete_files: name the files (paths).", isError: true };
  if (raw.length > CLEANUP_LIMITS.files) return { text: `delete_files: at most ${CLEANUP_LIMITS.files} files per card.`, isError: true };
  const { ok, problems } = await checkCleanup(raw, ctx.workspaceDir);
  if (!ok.length) return { text: `delete_files: nothing to remove. ${problems.join(" ")}`, isError: true };
  const member = await teamService(ctx.db).byThread(ctx.companyId, ctx.threadId);
  const router = member ? null : await orgService(ctx.db).getRouterProfile(ctx.companyId);
  const agentId = member?.agentId ?? router?.agent.id;
  if (!agentId) return { text: "delete_files isn't available here.", isError: true };
  const { gatingService } = await import("../gating.js");
  const files = ok.map((f) => f.rel);
  const output = await gatingService(ctx.db).createOutput({
    companyId: ctx.companyId,
    agentId,
    agentTag: member?.tag ?? router!.profile.tag,
    routeRunId: ctx.runId ?? null,
    kind: "drive_change",
    title: `Delete ${files.length === 1 ? files[0]!.split("/").pop() : `${files.length} files`} from tethr's folder`,
    body: cleanupCardBody(ok, why, cleanupDestination(ctx.workspaceDir)),
    // Destructive: always a person's yes, never automatic.
    sensitivity: "destructive",
    meta: { cleanup: { files, why }, threadId: ctx.threadId },
  });
  return {
    text: `A card asking to remove ${files.length} file${files.length === 1 ? "" : "s"} is right under your reply; they're moved to the archive when the person approves.${problems.length ? ` Left out: ${problems.join(" ")}` : ""} Don't overwrite them meanwhile.`,
    meta: { outputId: output.id, files: files.length },
  };
}

export async function runPersonTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId || !ctx.threadId) return { text: `${name} isn't available here.`, isError: true };
  const scoped = { ...ctx, db: ctx.db, companyId: ctx.companyId, threadId: ctx.threadId };
  try {
    if (name === "ask") return await ask(args, scoped);
    if (name === "need_connection") return await needConnection(args, scoped);
    if (name === "delete_files") return await deleteFiles(args, scoped);
    return { text: `There's no tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof QuestionInputError) return { text: `${name}: ${err.message}`, isError: true };
    throw err;
  }
}
