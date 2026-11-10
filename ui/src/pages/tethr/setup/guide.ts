import type { StepKey } from "./shared";

// The guidance beside each setup step: why it matters, what tethr does with
// it, what to have ready, and one tip. Plain words; shown in the onboarding.

export interface StepGuide {
  /** One-line promise, under the step's title. */
  lede: string;
  why: string;
  does: string[];
  need?: string[];
  tip?: string;
  minutes: number;
}

export const STEP_GUIDE: Record<StepKey, StepGuide> = {
  company: {
    lede: "Who tethr works for, and who it's talking to.",
    why: "tethr works for one company and one team. Knowing what you sell and what you do lets it speak about your business instead of a generic one.",
    does: [
      "Writes the company and the team into every chat, so you never have to explain them again.",
      "Shapes its help around your position: a CTO hears about fixes that improve the client experience, growth hears about channels and conversion.",
      "Counts email on your own domain as inside the company; anything else asks first.",
    ],
    need: ["Your company's name and one line on what it sells", "Your Slack member ID: in Slack, your profile, then ⋯, then Copy member ID"],
    tip: "Add your Slack member ID. With it, a message to tethr in Slack reaches the same tethr as this app; without it, tethr won't act on Slack messages. Teammate invites are coming.",
    minutes: 2,
  },
  focus: {
    lede: "What to grow first, and how hard to push.",
    why: "Goals keep tethr honest. Every suggestion it makes names the goal it moves, so start with the two or three areas that matter most this quarter.",
    does: [
      "Creates a goal for each area; the numbers come in the interview.",
      "Sets targets above the current trend: Steady about 5%, Balanced about 15%, Ambitious about 30%.",
      "With auto-adjust on, it moves a target halfway back toward realistic when the numbers drift, at most every two weeks, and tells you why.",
    ],
    tip: "Balanced suits most teams. You can change the pace later without losing anything.",
    minutes: 1,
  },
  connect: {
    lede: "What tethr can read to measure the goals.",
    why: "tethr measures with real numbers, not guesses: revenue and new customers from Stripe, traffic and conversion from PostHog, spend and search volume from Google Ads.",
    does: [
      "Reads freely. Anything that writes, sends or spends waits for your approval in a card.",
      "Uses the Slack bot to post heads-ups to #tethr and to send you ideas and approvals.",
    ],
    need: [
      "Stripe, PostHog and Gmail connected in your Claude account: claude.ai, Settings, Connectors",
      "Any keys you want to add (Slack bot, Google Ads, Jev). Fix on a row opens it right here, with what to paste and where to find it.",
    ],
    tip: "A green row means tethr may use it. Grey rows are optional. The goals interview is the real test: it tells you if a connection doesn't answer.",
    minutes: 3,
  },
  rhythm: {
    lede: "The routines tethr runs, and how often it speaks up.",
    why: "Choose the routines that keep the team pointed at the numbers. Each one is a short write-up in tethr's Operations chat; Slack only gets a heads-up, never the write-up.",
    does: [
      "Monday plan, Friday scorecard and a daily brief, each at the day and time you pick.",
      "Ideas: tethr listens where it's invited in Slack and offers one idea when a conversation settles, only during working hours.",
      "Learns your pace: ideas you use or answer earn more, ones you pass on earn fewer.",
    ],
    tip: "Start with the Friday scorecard. Add the others once you've seen one.",
    minutes: 2,
  },
  autonomy: {
    lede: "How much tethr does without being asked.",
    why: "Left alone, tethr answers when you write to it and waits. These switches decide whether it comes to you: checking on the goals each morning, acting when its agents report, adding agents, and studying how other companies grow.",
    does: [
      "Daily review: each morning it checks the goals and the team and decides the day's moves.",
      "Check-ins: when an agent reports, it reads the report and acts on it instead of waiting for you.",
      "The learner studies one area a week and brings back lessons; you choose which to apply.",
      "Whatever you pick, money, anything public and anything medical still ask you first.",
    ],
    tip: "Daily review and check-ins are what make tethr feel proactive. You can change any of these later in Integrations.",
    minutes: 2,
  },
  interview: {
    lede: "Real numbers in, realistic targets out.",
    why: "This is where tethr earns its keep. It pulls a starting point from your tools, shows you the trend, and proposes a target you can stand behind. Nothing is saved until you say yes.",
    does: [
      "Opens your chat with tethr, the one ongoing conversation you keep using from here on, and asks about one goal at a time.",
      "Proposes one to three measures per goal, each with a start, a target, a date, and exactly how it will be measured.",
      "Fills in its memory with your products, customers and channels as you talk.",
    ],
    tip: "Push back on any target you don't believe. It saves your number, not its first suggestion. Setup is done once the interview starts; you can come back here to change anything.",
    minutes: 10,
  },
};

/** The forms, without the conversation at the end. */
export const FORM_MINUTES = Object.entries(STEP_GUIDE).reduce((sum, [key, g]) => (key === "interview" ? sum : sum + g.minutes), 0);
