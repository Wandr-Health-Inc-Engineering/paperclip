import type { Db } from "@paperclipai/db";
import { companyProfileService } from "../company.js";
import { needsPersonReason } from "../screen.js";
import { decideWithJev, decisionMode, resolveDecision, type ChoiceOption, type DecideDeps } from "./decide.js";

// Phase 26.4: Jev at tethr's other decision points. Each is a kind in the
// decision record, Off until a person turns it on, and falls back to what tethr
// did before when Jev is off, over its cap or down. Anything that needs words
// stays with Claude.

export const URGENCY_NOW = "needs you now";
export const URGENCY_WAIT = "can wait";

export interface ReportUrgency {
  decisionId: string;
  pick: string;
  /** Hold the Slack DM: Automatic, and Jev above its bar that it can wait. */
  hold: boolean;
}

/**
 * Does an agent's report need its owner now (a Slack DM), or can it wait for
 * the daily review? Null when the kind is Off, Jev can't be asked, or the report
 * holds something a person has to see (then it's never held).
 */
export async function reportUrgency(
  db: Db,
  companyId: string,
  report: { cardRunId: string; agentTag: string; headline: string; summary: string | null; body: string },
  deps: DecideDeps = {},
): Promise<ReportUrgency | null> {
  if (decisionMode(companyId, "report.urgency") === "off") return null;
  const text = `${report.headline}\n${report.summary ?? ""}\n${report.body}`.slice(0, 4_000);
  if (needsPersonReason(text)) return null;
  const options: ChoiceOption[] = [
    { key: "now", label: URGENCY_NOW, description: "The owner should see this today: a decision to make, a blocker, a problem, money, a deadline, or something that changes plans." },
    { key: "wait", label: URGENCY_WAIT, description: "It can wait for the daily review: routine progress, a finished task with nothing to decide." },
  ];
  const res = await decideWithJev(
    db,
    companyId,
    {
      label: `${report.agentTag}: ${report.headline}`,
      subjectId: report.cardRunId,
      state: { report: text },
      asks: [{ kind: "report.urgency", instructions: "Does this report from an agent need its owner's attention now?", options }],
    },
    deps,
  );
  if (!res.ok) return null;
  const r = res.results["report.urgency"];
  if (!r) return null;
  const hold = r.pick.label === URGENCY_WAIT && r.mode === "auto" && r.confident;
  if (hold) await resolveDecision(db, companyId, r.decisionId, "automatic");
  return { decisionId: r.decisionId, pick: r.pick.label, hold };
}

export interface RankableConversation {
  key: string;
  channel: string;
  messages: Array<{ text: string }>;
}

/**
 * Order the settled Slack conversations best first for an idea (idea.rank).
 * It sends their words to TypeSafe, so it runs only when a person switched it
 * on. A conversation with someone's health details or a key is never sent; it
 * keeps its place after the ranked ones. On any trouble, the order is unchanged.
 */
export async function rankConversations<T extends RankableConversation>(
  db: Db,
  companyId: string,
  conversations: T[],
  deps: DecideDeps = {},
): Promise<T[]> {
  if (conversations.length < 2 || decisionMode(companyId, "idea.rank") === "off") return conversations;
  const sendable = conversations.filter((c) => !needsPersonReason(c.messages.map((m) => m.text).join("\n"))).slice(0, 8);
  if (sendable.length < 2) return conversations;
  const options: ChoiceOption[] = sendable.map((c, i) => ({
    key: `c${i + 1}`,
    label: c.key,
    description: `In ${c.channel}: ${c.messages.map((m) => m.text.replace(/\s+/g, " ")).join(" / ").slice(-700)}`,
  }));
  const profile = await companyProfileService(db).get(companyId);
  const res = await decideWithJev(db, companyId, {
    label: `${sendable.length} conversations`,
    state: { company: profile?.sells || profile?.name || "" },
    asks: [
      {
        kind: "idea.rank",
        instructions: "Which of these team conversations is the best chance for one concrete, useful growth idea (not small talk, not already decided)?",
        options,
      },
    ],
  }, deps);
  if (!res.ok || !res.results["idea.rank"]) return conversations;
  const order = res.results["idea.rank"].ranked.map((o) => o.label);
  await resolveDecision(db, companyId, res.results["idea.rank"].decisionId, "dropped").catch(() => {});
  const ranked = order.map((key) => sendable.find((c) => c.key === key)).filter((c): c is T => !!c);
  return [...ranked, ...conversations.filter((c) => !ranked.includes(c))];
}
