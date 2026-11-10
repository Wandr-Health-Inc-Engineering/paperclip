// The kinds of decision tethr asks Jev for (phase 26.2). Each has a plain label,
// a default mode, and whether it may ever run on its own. Jev decides; anything
// that needs words stays with Claude.

export type DecisionMode = "off" | "suggest" | "auto";
export const DECISION_MODES: DecisionMode[] = ["off", "suggest", "auto"];

export interface DecisionKind {
  key: string;
  label: string;
  /** What Off / Suggest / Automatic mean for this kind, in a line. */
  about: string;
  defaultMode: DecisionMode;
  /** Money, anything public and anything medical never run on their own. */
  neverAuto?: boolean;
  /** Sends other people's words (Slack) to TypeSafe: it needs its own yes. */
  sendsConversation?: boolean;
  /** The confidence bar to use before the record has enough answers to calibrate one. */
  startBar: number;
}

export const DECISION_KINDS: DecisionKind[] = [
  {
    key: "inbox.destination",
    label: "Where a file goes",
    about: "Suggest shows where tethr would file it; Automatic files it when Jev is sure enough (Put it back works for 7 days).",
    defaultMode: "suggest",
    startBar: 0.95,
  },
  {
    key: "inbox.notify",
    label: "Who should know about a file",
    about: "Suggest offers to tell someone or hand it to an agent; Automatic tells them (and hands agents a task).",
    defaultMode: "suggest",
    startBar: 0.95,
  },
  {
    key: "inbox.type",
    label: "What a file is",
    about: "Invoice, contract, partner material, research, report or other. Shown on the card; it never acts.",
    defaultMode: "suggest",
    neverAuto: true,
    startBar: 1,
  },
  {
    key: "inbox.urgency",
    label: "How soon a file needs someone",
    about: "Shown on the card; it never acts.",
    defaultMode: "suggest",
    neverAuto: true,
    startBar: 1,
  },
  {
    key: "report.urgency",
    label: "Whether an agent's report needs you now",
    about: "Suggest marks the report \"needs you\" or \"can wait\"; Automatic also holds the Slack DM for a report that can wait (it waits for the daily review).",
    defaultMode: "off",
    startBar: 0.9,
  },
  {
    key: "idea.rank",
    label: "Which conversations get the idea slots",
    about: "Jev ranks the Slack conversations tethr heard, so the few ideas a week go to the best ones.",
    defaultMode: "off",
    sendsConversation: true,
    startBar: 0,
  },
  {
    key: "lesson.score",
    label: "How good a lesson is",
    about: "Jev scores what the learner brings back (fit, evidence, usable now, new); the best become cards. It never applies a lesson.",
    defaultMode: "suggest",
    neverAuto: true,
    startBar: 1,
  },
];

const BY_KEY = new Map(DECISION_KINDS.map((k) => [k.key, k]));

export function decisionKind(key: string): DecisionKind | null {
  return BY_KEY.get(key) ?? null;
}

/** How many answered decisions a kind needs before it may be switched to Automatic. */
export const AUTO_MIN_DECISIONS = 20;
/** And how often Jev's pick must have been right among them. */
export const AUTO_MIN_ACCURACY = 0.9;
/** The confidence bar is where you accepted at least this share of Jev's picks. */
export const CALIBRATION_TARGET = 0.95;
export const CALIBRATION_WINDOW = 50;
/** Two corrections of automatic decisions within this many days put the kind back to Suggest. */
export const DEMOTION_DAYS = 7;
export const DEFAULT_MONTHLY_CAP_USD = 5;
