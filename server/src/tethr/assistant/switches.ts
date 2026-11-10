import type { DecisionMode } from "../decide/kinds.js";
import type { TeamAutonomy } from "../integrations.js";
import type { RhythmKey, SetupState } from "../setup.js";
import { scheduleWords } from "../team-spec.js";

// "What's switched on" in the chat's CLAUDE.md (2026-11-10). tethr has routines,
// a daily review, a learner and an Inbox, but every one of them is off until a
// person switches it on, and the chat wasn't told they exist. So with nothing on,
// tethr never came to the team by itself and never said what to switch on; it
// answered questions and waited. This section lists each feature, whether it's on,
// and where a person switches it on, so tethr can recommend them by name and
// doesn't make an agent for a job a built-in already does.

export interface SwitchesState {
  setup: Pick<SetupState, "rhythm" | "steps" | "completedAt" | "timezone" | "ideas">;
  autonomy: TeamAutonomy;
  /** The learner on the team (team.ts TeamAgent with sandbox: true), or null. */
  learner: { tag: string; paused: boolean; cron: string | null } | null;
  inboxFiling: DecisionMode;
}

const RHYTHM: Record<RhythmKey, { name: string; does: string }> = {
  plan: { name: "Monday plan", does: "you write the week's growth plan and set the growth map's focus" },
  scorecard: { name: "Friday scorecard", does: "you measure every goal's number, record it and write the scorecard" },
  brief: { name: "Daily brief", does: "you write a short brief of what changed and what needs the team" },
};

const WHERE = {
  rhythm: "Setup → Rhythm and ideas",
  autonomy: "Integrations → Team",
  learner: "Integrations → Learning",
  inbox: "Integrations → Jev decisions",
};

function rhythmLine(key: RhythmKey, s: SwitchesState): string {
  const { name, does } = RHYTHM[key];
  const choice = s.setup.rhythm[key];
  return choice.enabled
    ? `- ${name}: on, ${scheduleWords(choice.cron, s.setup.timezone)}: ${does}.`
    : `- ${name}: off (${WHERE.rhythm}). When on, ${does}.`;
}

function ideasLine(s: SwitchesState): string {
  const chosen = !!s.setup.steps.rhythm || !!s.setup.completedAt;
  if (!chosen) return `- Ideas (from the team's Slack conversations, goals and quiet stretches): off until the team saves ${WHERE.rhythm}.`;
  const from = s.setup.ideas.slackListen ? "the team's Slack conversations, goals and quiet stretches" : "goals and quiet stretches only, not listening to Slack";
  return `- Ideas: on, at a ${s.setup.ideas.level} pace, from ${from}.`;
}

function autonomyLines(a: TeamAutonomy): string[] {
  return [
    a.actOnReports
      ? "- Check-ins: on. When agents report, you get a turn to act on what came back."
      : `- Check-ins when agents report: off (${WHERE.autonomy} → Act on reports). Reports wait until someone writes to you.`,
    a.dailyReview.enabled
      ? `- Daily review: on, at ${a.dailyReview.time}${a.dailyReview.weekdaysOnly ? " on weekdays" : ""}. You check the goals and the team and decide the day's moves.`
      : `- Daily review: off (${WHERE.autonomy} → Daily review). This is the switch that makes you come to the team each day instead of waiting to be asked.`,
  ];
}

function learnerLine(s: SwitchesState): string {
  const l = s.learner;
  if (!l) return `- Learner: off (${WHERE.learner}). When on, an agent studies how other companies grow each week and brings back lessons for the team to apply.`;
  if (l.paused) return `- Learner ${l.tag}: paused (${WHERE.learner}).`;
  return `- Learner ${l.tag}: on${l.cron ? `, ${scheduleWords(l.cron, s.setup.timezone)}` : ""}. It studies how other companies grow and proposes lessons.`;
}

function inboxLine(mode: DecisionMode): string {
  const filing =
    mode === "off"
      ? "with no filing suggestion"
      : mode === "auto"
        ? "filed by Jev when it's sure, otherwise with its suggestion"
        : "with Jev's filing suggestion when Jev is working";
  return `- Inbox: a file dropped in the "00 Inbox" folder of 00 Tethr becomes a card for a person in the main chat and the Drive's Inbox view, ${filing} (${WHERE.inbox}). It isn't sent to you to read.`;
}

/** The "What's switched on" section of the chat's CLAUDE.md (company-level). */
export function switchesContextText(s: SwitchesState): string {
  return [
    "## What's switched on",
    "tethr's built-in features, whether each is on, and where a person switches it on. You can't switch these yourself. Setup is \"Set up tethr\" in the sidebar, or Growth → Edit goals once setup is done.",
    ...(["plan", "scorecard", "brief"] as RhythmKey[]).map((k) => rhythmLine(k, s)),
    ideasLine(s),
    ...autonomyLines(s.autonomy),
    learnerLine(s),
    inboxLine(s.inboxFiling),
    "How to use this:",
    "- When one of these would serve your recommendation, name it, say where to switch it on and what it will do for the goal. One or two in a reply at most, and only where they help.",
    "- Don't make an agent for a job one of these already does: the Friday scorecard keeps the goal numbers current, the daily review checks on the team, the learner studies other companies. Suggest switching it on instead.",
    "- With the daily review and check-ins off, nothing happens until someone writes to you. If the team expects you to come to them, say so and point to the daily review.",
  ].join("\n");
}
