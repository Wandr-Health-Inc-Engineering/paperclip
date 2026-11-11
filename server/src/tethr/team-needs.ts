import type { Db } from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { answerQuestion, askQuestion, openQuestions, QuestionInputError, type Question } from "./assistant/questions.js";
import { logFailure } from "./best-effort.js";
import * as chats from "./chats.js";
import { findConnection } from "./connections.js";
import { DEFAULT_CONNECTOR_AUTONOMY } from "./integrations.js";
import { deliverAgentReport } from "./team-report.js";
import { teamService, type TeamAgent, type UnmetNeed } from "./team.js";
import type { TaskService } from "./tasks.js";

// Phase 27: an agent whose job needs a connection that's missing waits, and
// spends nothing, until a person connects it or says to carry on without it
// (Mark: "ensure that it doesn't endlessly waste budget without using the actual
// connector it needs unless I explicitly tell it forget it").
//
// The check runs before any turn (team-run.ts). The person sees one card per
// missing connection, with the fix in place: a question card with a
// `connection` on it, in the chat of the agent whose need it is.

/** What a connection card asks. One per agent and connection, however often the agent is held. */
export function needCardText(agent: Pick<TeamAgent, "tag" | "name">, need: UnmetNeed): { question: string; detail: string } {
  return {
    question: `${agent.tag} needs ${need.key}`,
    detail: [need.why, `Right now: ${need.detail}.`, `${agent.name} won't run, or spend anything, until this is connected or you say to carry on without it.`].filter(Boolean).join("\n"),
  };
}

/** Make sure each missing connection has its card. Returns the ones made just now. */
export async function openNeedCards(db: Db, companyId: string, unmet: UnmetNeed[], runId: string | null = null): Promise<Question[]> {
  const team = teamService(db);
  const made: Question[] = [];
  for (const need of unmet) {
    const owner = await team.get(companyId, need.ofTag);
    if (!owner) continue;
    if (openQuestions(companyId, { agentTag: owner.tag }).some((q) => q.connection?.key === need.key)) continue;
    try {
      const card = await askQuestion(companyId, { ...needCardText(owner, need), options: null, threadId: owner.threadId, runId, agentTag: owner.tag, connection: { key: need.key } });
      made.push(card);
      const { tellPersonAboutQuestion } = await import("./assistant/person-tools.js");
      await tellPersonAboutQuestion(db, companyId, card, true).catch(logFailure("telling the person about a missing connection", { tag: owner.tag }));
    } catch (err) {
      if (!(err instanceof QuestionInputError)) throw err; // already asked: nothing to add
    }
  }
  return made;
}

/**
 * Hold a task instead of running it: no turn, nothing spent. A scheduled run is
 * skipped; a task someone handed over waits and starts when the need is settled.
 * The main chat hears once, when the card is first made.
 */
export async function holdTaskForNeeds(
  db: Db,
  input: { companyId: string; agent: TeamAgent; issueId: string; issue: { title: string; identifier: string | null; originKind: string }; unmet: UnmetNeed[]; tasks: TaskService; ctx: AdapterExecutionContext },
): Promise<string> {
  const { companyId, agent, issueId, issue, unmet, tasks, ctx } = input;
  const names = [...new Set(unmet.map((n) => n.key))].join(", ");
  const viaLead = unmet.every((n) => n.ofTag !== agent.tag) ? ` (its lead ${unmet[0]!.ofTag} needs it)` : "";
  const scheduled = issue.originKind === "routine_execution";
  const why = `${agent.tag} didn't run ${issue.identifier ?? "this"}: it's waiting for ${names}${viaLead}. ${
    scheduled ? "This scheduled run was skipped." : "The task starts by itself once that's sorted."
  } Connect it, or say to carry on without it, in tethr (Needs you).`;
  await ctx.onLog("stdout", `[tethr] ${why}\n`);
  await tasks.comment(issueId, why, { agentId: ctx.agent.id }).catch(logFailure("hold comment", { issueId }));
  if (scheduled) {
    await tasks.setStatus(issueId, "cancelled", { agentId: ctx.agent.id });
  } else {
    await tasks.setStatus(issueId, "blocked", { agentId: ctx.agent.id });
    await teamService(db).holdTask(agent, issueId);
  }
  const made = await openNeedCards(db, companyId, unmet);
  // A sub-agent held by its lead's need has nothing of its own to report; the lead's card says it.
  if (made.length && !agent.leadTag) {
    await deliverAgentReport(db, { companyId, agent, title: names, outcome: "held", text: why, runId: null }).catch(logFailure("hold report", { tag: agent.tag }));
  }
  return why;
}

/** Whether a "connected" answer can stand: tethr has to be able to use it now. Null when it can. */
/**
 * The connection works for the company, but this agent (or, for a sub-agent, its
 * lead) isn't given it: what it needs is access, not a key or a login.
 */
export function needsAccess(companyId: string, agent: { connectors: string[] } | null, lead: { connectors: string[] } | null, key: string): boolean {
  if (!agent || findConnection(companyId, key)?.ok !== true) return false;
  return !agent.connectors.includes(key) || (!!lead && !lead.connectors.includes(key));
}

/** Connection cards, each marked when what it needs is access (the UI shows "Give it access" then). */
export async function withAccess<T extends Question>(db: Db, companyId: string, questions: T[]): Promise<Array<T & { access: boolean }>> {
  const cards = questions.filter((q) => q.connection && q.agentTag && q.status === "open");
  if (!cards.length) return questions.map((q) => ({ ...q, access: false }));
  const agents = await teamService(db).list(companyId);
  return questions.map((q) => {
    if (!q.connection || !q.agentTag || q.status !== "open") return { ...q, access: false };
    const agent = agents.find((a) => a.tag === q.agentTag) ?? null;
    const lead = agent?.leadTag ? (agents.find((a) => a.tag === agent.leadTag) ?? null) : null;
    return { ...q, access: needsAccess(companyId, agent, lead, q.connection.key) };
  });
}

/** Give an agent a connection it lacks (a sub-agent's lead too, whose settings it works under). A person's call. */
async function grantAccess(db: Db, companyId: string, agent: TeamAgent, key: string, auto: boolean, actor: { userId: string | null }): Promise<void> {
  const team = teamService(db);
  const lead = agent.leadTag ? await team.get(companyId, agent.leadTag) : null;
  // Its own settings, or its lead's: Automatic or Approval needed for this tool, the sensitive kinds asking.
  const owner = lead ?? agent;
  const setting = { [key]: { mode: auto ? ("auto" as const) : ("ask" as const), autonomy: owner.settings[key]?.autonomy ?? { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { ...DEFAULT_CONNECTOR_AUTONOMY.spend } } } };
  if (lead && !lead.connectors.includes(key)) {
    await team.update(companyId, lead.tag, { connectors: [...lead.connectors, key], settings: setting }, actor);
  } else if (lead) {
    await team.update(companyId, lead.tag, { settings: setting }, actor);
  }
  if (!agent.connectors.includes(key)) {
    await team.update(companyId, agent.tag, { connectors: [...agent.connectors, key], ...(lead ? {} : { settings: setting }) }, actor);
  } else if (!lead) {
    await team.update(companyId, agent.tag, { settings: setting }, actor);
  }
}

export function stillMissing(companyId: string, key: string): string | null {
  const connection = findConnection(companyId, key);
  if (connection?.ok) return null;
  return `tethr still can't use ${key}: ${connection?.detail ?? "it isn't a connection tethr knows"}.`;
}

/**
 * A person answered a connection card. For an agent's card this settles the
 * need (throws TeamInputError when "connected" isn't true yet) and starts what
 * waited. Returns whether the agent already has work starting, in which case
 * the news rides along as a note instead of a turn of its own.
 */
export async function settleConnectionCard(
  db: Db,
  companyId: string,
  question: Question,
  answer: "connected" | "without" | "grant" | "grant_auto",
  actor: { userId: string | null },
): Promise<{ startedTasks: number }> {
  const key = question.connection!.key;
  if (!question.agentTag) return { startedTasks: 0 };
  const team = teamService(db);
  const before = await team.get(companyId, question.agentTag);
  if (!before) return { startedTasks: 0 };
  // Giving it access: the connection works, the agent just wasn't given it.
  if (answer === "grant" || answer === "grant_auto") await grantAccess(db, companyId, before, key, answer === "grant_auto", actor);
  const choice = answer === "without" ? "without" : "connected";
  const waiting = before.heldIssues.length + (await team.subTeam(companyId, before.tag)).reduce((n, a) => n + a.heldIssues.length, 0);
  await team.settleNeed(companyId, before.tag, key, choice, actor);
  const after = await team.get(companyId, before.tag);
  const stillWaiting = (after?.heldIssues.length ?? 0) + (await team.subTeam(companyId, before.tag)).reduce((n, a) => n + a.heldIssues.length, 0);
  const startedTasks = Math.max(0, waiting - stillWaiting);
  if (startedTasks) {
    const note =
      choice === "connected"
        ? `The team connected ${key}. Check that it answers, then carry on.`
        : `The team said to carry on without ${key}. Don't ask for it again; do what you can and say what you couldn't.`;
    await chats.addNote(companyId, before.threadId, note).catch(logFailure("need note", { tag: before.tag }));
  }
  return { startedTasks };
}

/**
 * A key or a connector setting was just saved. Connections tethr can now see for
 * itself close their cards and start what waited. A need the agent raised
 * against something tethr thought was on stays open: only a person's word
 * ("I've connected it") clears that.
 */
export async function recheckConnections(db: Db, companyId: string): Promise<{ closed: number; startedTasks: number }> {
  const team = teamService(db);
  let closed = 0;
  for (const card of openQuestions(companyId)) {
    if (!card.connection || !card.agentTag) continue;
    const agent = await team.get(companyId, card.agentTag);
    if (!agent) continue;
    if ((await team.unmetNeeds(companyId, agent)).some((n) => n.key === card.connection!.key && n.ofTag === agent.tag)) continue;
    await answerQuestion(companyId, card.id, { choice: "connected", by: "tethr" }).catch(logFailure("closing a connection card", { questionId: card.id }));
    closed += 1;
  }
  return { closed, startedTasks: await team.recheckHolds(companyId) };
}
