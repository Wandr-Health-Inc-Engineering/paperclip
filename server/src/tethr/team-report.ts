import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import type { TethrRouteHop } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logFailure } from "./best-effort.js";
import * as chats from "./chats.js";
import { companyProfileService } from "./company.js";
import { teamService, type TeamAgent } from "./team.js";
import { leadNudgeText, reportBody, splitSlackSummary } from "./team-spec.js";
import type { SlackPoster } from "./watch.js";

// Phase 23: an agent reports back. When an agent finishes work tethr started
// (a task, or the follow-up after an approval), the result lands in four
// places (Mark: "main chat, but also DM or message the appropriate person"):
// 1. a card in the main chat (route run, sourceKey "tethr-agent-report") with
//    the agent's report and its files, so they open in the side panel;
// 2. a note on the main chat's next turn, so tethr knows what came back;
// 3. the bell;
// 4. Slack: a DM to the agent's owner (the roster person for its role, else
//    the admin), else #tethr. Only the headline and the agent's one-line
//    "Slack summary", never the report (it can mention customers).

export const AGENT_REPORT_SOURCE = "tethr-agent-report";

export type ReportOutcome = "done" | "failed" | "skipped" | "capped" | "waiting" | "update" | "held";

export interface AgentReport {
  companyId: string;
  agent: TeamAgent;
  title: string;
  identifier?: string | null;
  outcome: ReportOutcome;
  /** The agent's answer (or why it didn't run). */
  text: string;
  /** The agent's turn, for its files. */
  runId: string | null;
  /** A sub-task its lead handed out (the lead rolls those up; no nudge). */
  partOfLeadTask?: boolean;
}

/** "@scout finished WD-12: Check competitor prices" and friends. */
export function reportHeadline(r: Pick<AgentReport, "agent" | "title" | "identifier" | "outcome">): string {
  const what = `${r.identifier ? `${r.identifier}: ` : ""}${r.title}`;
  switch (r.outcome) {
    case "done":
      return `${r.agent.tag} finished ${what}`;
    case "update":
      return `${r.agent.tag} has an update: ${what}`;
    case "waiting":
      return `${r.agent.tag} needs your approval to finish ${what}`;
    case "held":
      // Phase 27: it didn't run because a connection its job needs is missing (the title names it).
      return `${r.agent.tag} is waiting on a connection: ${r.title}`;
    case "capped":
      return `${r.agent.tag} hit its daily limit before ${what}`;
    case "skipped":
      return `${r.agent.tag} skipped ${what} (agents were paused)`;
    default:
      return `${r.agent.tag} couldn't finish ${what}`;
  }
}

/** The files an agent's turn wrote, as tool hops the chat shows as chips. */
async function fileHops(db: Db, runId: string | null): Promise<TethrRouteHop[]> {
  if (!runId) return [];
  const [run] = await db.select({ hops: tethrRouteRuns.hops }).from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
  return (run?.hops ?? []).filter((h) => h.layer === "tool" && h.file && h.status === "ok");
}

/** Where an agent's Slack heads-up goes: its owner, else the admin, else #tethr. */
async function ownerChannel(db: Db, companyId: string, agent: TeamAgent): Promise<string> {
  const slack = await import("./slack.js");
  const owner = await slack.resolveOverseer(db, companyId, agent.tag);
  if (owner.slackId) return owner.slackId;
  const admin = (await companyProfileService(db).adminSlackIds(companyId))[0];
  return admin?.slackId ?? slack.slackChannel();
}

/** The Slack heads-up: headline, the agent's one-line summary, a link. Never the report. */
export function reportSlackText(r: AgentReport, summary: string | null): string {
  const base = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const link = base ? `\n<${base}/chat?chat=${r.agent.threadId}|Open ${r.agent.tag}'s chat in tethr>` : "";
  return `*${r.agent.name}* · ${reportHeadline(r)}${summary ? `\n${summary}` : ""}${link}`;
}

export async function deliverAgentReport(db: Db, r: AgentReport, deps: { post?: SlackPoster } = {}): Promise<{ cardRunId: string }> {
  const split = splitSlackSummary(r.text);
  const body = reportBody(split.body);
  // Phase 26.6: a sandboxed agent read the open web, so its own summary never
  // goes into tethr's notes or a Slack DM; the headline does, the report stays on its card.
  const summary = r.agent.sandbox ? null : split.summary;
  const headline = reportHeadline(r);
  // Phase 24: a sub-agent reports to its lead (a card and a note in the lead's
  // chat), not to the main chat, the bell or Slack; the lead reports for its team.
  const lead = r.agent.leadTag ? await teamService(db).get(r.companyId, r.agent.leadTag) : null;
  const threadId = lead?.threadId ?? chats.mainThreadId(r.companyId);
  const now = new Date();
  const [card] = await db
    .insert(tethrRouteRuns)
    .values({
      companyId: r.companyId,
      requestText: headline,
      invocationSource: "chat",
      threadId,
      sourceKey: AGENT_REPORT_SOURCE,
      status: "done",
      resultText: body.slice(0, 8_000),
      hops: await fileHops(db, r.runId),
      agentId: r.agent.agentId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await chats
    .addNote(r.companyId, threadId, `${headline}${summary ? `: ${summary}` : ""}. The full report is in ${r.agent.tag}'s chat and on its card in this chat.`)
    .catch(logFailure("agent report note", { tag: r.agent.tag }));
  if (lead) {
    // A report the lead didn't ask for in a task (a first task, a scheduled
    // run) wakes the lead, so the work keeps moving without anyone prompting it.
    if (!r.partOfLeadTask && !lead.paused) {
      const { getAssistantRunner } = await import("./assistant/runner.js");
      await getAssistantRunner(db)
        .send({
          companyId: r.companyId,
          threadId: lead.threadId,
          kind: "system",
          text: leadNudgeText({ tag: r.agent.tag, title: r.title, identifier: r.identifier, summary }),
        })
        .catch(logFailure("lead nudge", { tag: lead.tag }));
    }
    return { cardRunId: card.id };
  }

  // tethr may check in on it (if the person turned that on).
  const { noteReport } = await import("./team-brain.js");
  await noteReport(r.companyId, { tag: r.agent.tag, title: r.title, outcome: r.outcome }, now).catch(logFailure("brain report note", { tag: r.agent.tag }));

  const { notificationService } = await import("./notify.js");
  await notificationService(db)
    // Tapping it opens the report's card in the chat, read in full.
    .send({ companyId: r.companyId, kind: "run", title: headline, body: summary ?? undefined, href: chats.chatHref(r.companyId, threadId, card.id), agentTag: r.agent.tag })
    .catch(logFailure("agent report bell", { tag: r.agent.tag }));

  // Phase 26.4: Jev may judge whether it needs the owner now (report.urgency).
  // A report that can wait is held for the daily review only when that kind is
  // Automatic and Jev is above its confidence bar.
  const { reportUrgency } = await import("./decide/points.js");
  const urgency = await reportUrgency(db, r.companyId, { cardRunId: card.id, agentTag: r.agent.tag, headline, summary, body }).catch(() => null);
  if (!urgency?.hold) await postReportToSlack(db, r, summary, deps.post);
  return { cardRunId: card.id };
}

async function postReportToSlack(db: Db, r: AgentReport, summary: string | null, poster: SlackPoster | undefined): Promise<void> {
  const slack = await import("./slack.js");
  // Under tests Slack is never configured; an injected poster stands in.
  if (!poster && !slack.slackConfigured()) return;
  const post: SlackPoster = poster ?? ((message) => slack.postSlackMessage(message));
  const channel = await ownerChannel(db, r.companyId, r.agent);
  const result = await post({ channel, text: reportSlackText(r, summary) }).catch((err) => ({ ok: false, error: String(err) }));
  if (!result.ok) logger.warn({ companyId: r.companyId, tag: r.agent.tag, error: (result as { error?: string }).error }, "[tethr] agent report Slack post failed");
}

/** tethr added an agent on its own (Automatic): the bell, and a Slack heads-up to the admin. */
export async function announceNewAgent(db: Db, companyId: string, agent: TeamAgent, why: string, deps: { post?: SlackPoster } = {}): Promise<void> {
  const title = `tethr added ${agent.tag} to the team: ${agent.title}`;
  const { notificationService } = await import("./notify.js");
  await notificationService(db)
    .send({ companyId, kind: "run", title, body: why || agent.mission, href: `/chat?chat=${agent.threadId}`, agentTag: "@tethr" })
    .catch(logFailure("new agent bell", { tag: agent.tag }));
  const slack = await import("./slack.js");
  if (!deps.post && !slack.slackConfigured()) return;
  const post: SlackPoster = deps.post ?? ((message) => slack.postSlackMessage(message));
  const admin = (await companyProfileService(db).adminSlackIds(companyId))[0];
  const channel = admin?.slackId ?? slack.slackChannel();
  await post({ channel, text: `*${title}*\n${agent.mission}` }).catch(logFailure("new agent Slack post", { tag: agent.tag }));
}
