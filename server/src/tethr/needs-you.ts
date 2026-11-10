import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs } from "@paperclipai/db";
import { openQuestions, type Question } from "./assistant/questions.js";
import * as chats from "./chats.js";
import { AGENT_REPORT_SOURCE } from "./team-report.js";
import { teamService, type TeamAgent } from "./team.js";

// Phase 27: everything that waits on a person, as one list. Mark: "I don't feel
// the UI is really intuitive on knowing what is required of me." Three kinds:
// approvals (gated outputs), questions tethr or an agent asked as cards, and
// connections an agent can't run without (questions with a `connection`). The
// chat's pill, the Needs you page, the sidebar count and an agent's report card
// all read this, so they always agree.

const PENDING = ["gated", "changes_requested"];

type OutputRow = typeof tethrOutputs.$inferSelect;

export interface NeedsYou {
  approvals: Array<OutputRow & { from: string | null; threadId: string | null }>;
  questions: Array<Question & { from: string }>;
  connections: Array<Question & { from: string }>;
  count: number;
}

/** Where a card came from, in a few words: the agent, or the chat. */
function chatName(companyId: string, threadId: string, agents: TeamAgent[]): string {
  if (threadId === chats.mainThreadId(companyId)) return "your chat with tethr";
  const agent = agents.find((a) => a.threadId === threadId);
  if (agent) return `${agent.tag}'s chat`;
  const side = chats.listSideChats(companyId).find((c) => c.threadId === threadId);
  return side ? `side chat "${side.title}"` : "a side chat";
}

async function pendingOutputs(db: Db, companyId: string, agentIds?: string[]): Promise<OutputRow[]> {
  if (agentIds && !agentIds.length) return [];
  return db
    .select()
    .from(tethrOutputs)
    .where(and(eq(tethrOutputs.companyId, companyId), inArray(tethrOutputs.status, PENDING), ...(agentIds ? [inArray(tethrOutputs.agentId, agentIds)] : [])))
    .orderBy(desc(tethrOutputs.createdAt))
    .limit(100);
}

/** The chat an approval card can be talked about in: the one that asked for it. */
function threadOfOutput(output: OutputRow): string | null {
  const meta = (output.meta ?? {}) as Record<string, unknown>;
  return typeof meta.threadId === "string" ? meta.threadId : null;
}

/** Everything in the company that waits on a person, newest first. */
export async function needsYou(db: Db, companyId: string): Promise<NeedsYou> {
  const agents = await teamService(db).list(companyId);
  const outputs = await pendingOutputs(db, companyId);
  const open = [...openQuestions(companyId)].reverse().map((q) => ({ ...q, from: chatName(companyId, q.threadId, agents) }));
  const approvals = outputs.map((o) => {
    const threadId = threadOfOutput(o);
    return { ...o, threadId, from: threadId ? chatName(companyId, threadId, agents) : (agents.find((a) => a.agentId === o.agentId)?.tag ?? null) };
  });
  const questions = open.filter((q) => !q.connection);
  const connections = open.filter((q) => !!q.connection);
  return { approvals, questions, connections, count: approvals.length + questions.length + connections.length };
}

/** For a chat's turns: what each agent's newest report card should show as waiting on the person. */
export async function needsYouOnReportCards(
  db: Db,
  companyId: string,
  runs: Array<{ id: string; sourceKey: string | null; agentId: string | null }>,
): Promise<Map<string, { approvals: OutputRow[]; questions: Question[] }>> {
  const byCard = new Map<string, { approvals: OutputRow[]; questions: Question[] }>();
  // Runs come oldest first: the last card of each agent wins.
  const newest = new Map<string, string>();
  for (const run of runs) if (run.sourceKey === AGENT_REPORT_SOURCE && run.agentId) newest.set(run.agentId, run.id);
  if (!newest.size) return byCard;
  const agents = await teamService(db).list(companyId);
  for (const [agentId, cardId] of newest) {
    const agent = agents.find((a) => a.agentId === agentId);
    if (!agent) continue;
    const group = [agent, ...agents.filter((a) => a.leadTag === agent.tag)];
    const approvals = await pendingOutputs(db, companyId, group.map((a) => a.agentId));
    const questions = group.flatMap((a) => openQuestions(companyId, { agentTag: a.tag }));
    if (approvals.length || questions.length) byCard.set(cardId, { approvals, questions });
  }
  return byCard;
}

/**
 * For a chat's turns: an agent that was just approved from one of them and is
 * waiting on a connection shows that card under the turn that proposed it, so
 * approving it leads straight to the fix. Once the agent has a report card in
 * this chat, the card rides there instead (needsYouOnReportCards).
 */
export async function connectionCardsOnCreationTurns(
  db: Db,
  companyId: string,
  runs: Array<{ id: string; sourceKey: string | null; agentId: string | null }>,
  outputs: Array<{ routeRunId: string | null; kind: string; status: string; meta: unknown }>,
): Promise<Map<string, Question[]>> {
  const byRun = new Map<string, Question[]>();
  const created = outputs.filter((o) => o.kind === "team_agent" && o.status === "published" && o.routeRunId);
  if (!created.length) return byRun;
  const agents = await teamService(db).list(companyId);
  const reported = new Set(runs.filter((r) => r.sourceKey === AGENT_REPORT_SOURCE && r.agentId).map((r) => r.agentId));
  for (const output of created) {
    const spec = ((output.meta ?? {}) as { spec?: { tag?: unknown } }).spec;
    const agent = agents.find((a) => a.tag === spec?.tag);
    if (!agent || reported.has(agent.agentId)) continue;
    const cards = openQuestions(companyId, { agentTag: agent.tag }).filter((q) => q.connection);
    if (cards.length) byRun.set(output.routeRunId!, [...(byRun.get(output.routeRunId!) ?? []), ...cards]);
  }
  return byRun;
}
