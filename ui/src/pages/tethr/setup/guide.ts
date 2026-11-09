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
    tip: "Teammate invites are coming. For now you're the admin, and approvals from Slack only count from your member ID.",
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
      "The Slack bot token and Google Ads keys on the Environment page (already set on this Mac)",
    ],
    tip: "A green row means tethr may use it. The goals interview is the real test: it tells you if a connection doesn't answer.",
    minutes: 3,
  },
  interview: {
    lede: "Real numbers in, realistic targets out.",
    why: "This is where tethr earns its keep. It pulls a starting point from your tools, shows you the trend, and proposes a target you can stand behind. Nothing is saved until you say yes.",
    does: [
      "Opens a side chat called Goals interview and asks about one goal at a time.",
      "Proposes one to three measures per goal, each with a start, a target, a date, and exactly how it will be measured.",
      "Fills in its memory with your products, customers and channels as you talk.",
    ],
    tip: "Push back on any target you don't believe. It saves your number, not its first suggestion. You can leave and come back; this page picks up where you left off.",
    minutes: 10,
  },
  rhythm: {
    lede: "What tethr does on its own, and how often it speaks up.",
    why: "Choose the routines that keep the team pointed at the numbers. Each one is a short write-up in tethr's Operations chat; Slack only gets a heads-up, never the write-up.",
    does: [
      "Monday plan, Friday scorecard and a daily brief, each at the day and time you pick.",
      "Ideas: tethr listens where it's invited in Slack and offers one idea when a conversation settles, only during working hours.",
      "Learns your pace: ideas you use or answer earn more, ones you pass on earn fewer.",
    ],
    tip: "Start with the Friday scorecard. Add the others once you've seen one.",
    minutes: 2,
  },
  finish: {
    lede: "Check it over, take the first measurement, and you're live.",
    why: "A last look at everything you've set, and the first scorecard so the goals have numbers from day one.",
    does: ["Measures every goal the way you agreed and writes the first scorecard into tethr's files.", "Takes you to Growth, where the goals live from now on."],
    tip: "Everything here can be changed later from Set up tethr in the sidebar.",
    minutes: 1,
  },
};

export const SETUP_MINUTES = Object.values(STEP_GUIDE).reduce((sum, g) => sum + g.minutes, 0);
