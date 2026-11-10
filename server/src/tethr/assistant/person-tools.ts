import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import { logFailure } from "../best-effort.js";
import { mainThreadId } from "../chats.js";
import { personalHealthReason } from "../screen.js";
import { teamService } from "../team.js";
import { askQuestion, buttonsOf, parseAsk, QuestionInputError, type Question } from "./questions.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Phase 27: how tethr and its agents reach a person without burying the ask in
// prose. `ask` puts a question in front of them as a card with buttons. Every
// agent on the team has these whatever its connectors (team-spec.ts
// AGENT_ALWAYS_TOOLS); a private turn and the sealed learner don't.

export const PERSON_TOOL_NAMES = ["ask"] as const;
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
];

/** The Slack line that tells an owner a question is waiting. The question itself goes
 * along only when it carries no one's health details; otherwise just that there is one. */
export function questionDmText(who: string, question: Question): string {
  const base = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const where = base ? `<${base}/queue|Answer it in tethr>` : "Answer it in tethr (Needs you, or the chat).";
  const safe = personalHealthReason(`${question.question} ${question.detail ?? ""}`) === null;
  return safe ? `${who} has a question for you: *${question.question}* ${where}` : `${who} has a question for you. ${where}`;
}

/** Tell the person a question is waiting when they aren't in the chat it was asked in:
 * an agent's own chat, or a turn tethr started itself (a task, a check-in, a routine). */
async function buzz(db: Db, companyId: string, question: Question, startedByTethr: boolean): Promise<void> {
  if (!question.agentTag && !startedByTethr) return;
  const who = question.agentTag ?? "tethr";
  const { notificationService } = await import("../notify.js");
  await notificationService(db)
    .send({
      companyId,
      kind: "approval",
      title: `${who} asks: ${question.question}`,
      body: question.detail ?? undefined,
      href: question.threadId === mainThreadId(companyId) ? "/chat" : `/chat?chat=${question.threadId}`,
      agentTag: question.agentTag ?? "@tethr",
    })
    .catch(logFailure("question bell", { questionId: question.id }));
  const { dmOverseer } = await import("../slack.js");
  await dmOverseer(db, companyId, question.agentTag ?? "@tethr", questionDmText(who, question));
}

async function ask(args: Record<string, unknown>, ctx: TethrToolContext & { db: Db; companyId: string; threadId: string }): Promise<TethrToolResult> {
  const parsed = parseAsk(args);
  const member = await teamService(ctx.db).byThread(ctx.companyId, ctx.threadId);
  const question = await askQuestion(ctx.companyId, { ...parsed, threadId: ctx.threadId, runId: ctx.runId ?? null, agentTag: member?.tag ?? null }, ctx.now?.() ?? new Date());
  const [run] = ctx.runId ? await ctx.db.select({ sourceKey: tethrRouteRuns.sourceKey }).from(tethrRouteRuns).where(eq(tethrRouteRuns.id, ctx.runId)) : [];
  await buzz(ctx.db, ctx.companyId, question, run?.sourceKey === "chat-system").catch(logFailure("telling the person about a question", { questionId: question.id }));
  return {
    text: `Shown to the person as a card with ${buttonsOf(question)}. End your reply here: their answer arrives as their next message. Don't ask it again in your text, and don't act as if they had answered.`,
    meta: { questionId: question.id, options: question.options?.length ?? 0 },
  };
}

export async function runPersonTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId || !ctx.threadId) return { text: `${name} isn't available here.`, isError: true };
  const scoped = { ...ctx, db: ctx.db, companyId: ctx.companyId, threadId: ctx.threadId };
  try {
    if (name === "ask") return await ask(args, scoped);
    return { text: `There's no tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof QuestionInputError) return { text: `${name}: ${err.message}`, isError: true };
    throw err;
  }
}
