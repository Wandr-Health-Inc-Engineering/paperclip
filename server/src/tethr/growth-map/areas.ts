// The growth map's areas (phase 26.9): the twelve parts of growing a company,
// the same for every company. Each names the playbooks tethr loads before it
// works there (skills in ~/.claude/skills), the data it reads, what tethr can't
// see yet, and the areas it feeds. Placement: two spiral arms of six, so areas
// that feed each other sit next to each other and their links never cross the map.

export const AREA_IDS = [
  "positioning",
  "content",
  "seo",
  "geo",
  "paid_ads",
  "measurement",
  "customer_voice",
  "conversion",
  "pricing",
  "retention",
  "email",
  "partnerships",
] as const;

export type AreaId = (typeof AREA_IDS)[number];

/** Where an area's data comes from. "profile" = what the company sells (setup step 1);
 * "website" = the company's own domain (Integrations → inside the company). */
export type DataSource = "google_ads" | "stripe" | "posthog" | "gmail" | "slack" | "website" | "profile";

/** A claude.ai connector's label on the Integrations page. */
export const CONNECTOR_OF: Partial<Record<DataSource, string>> = {
  stripe: "Stripe",
  posthog: "PostHog",
  gmail: "Gmail",
  slack: "Slack",
};

export const DATA_LABEL: Record<DataSource, string> = {
  google_ads: "Google Ads",
  stripe: "Stripe",
  posthog: "PostHog",
  gmail: "Gmail",
  slack: "Slack",
  website: "your website",
  profile: "what the company sells (setup)",
};

/** The scheduled work that owns an area when it's switched on (rhythm.ts keys). */
export type AreaSchedule = "scorecard";

export interface GrowthArea {
  id: AreaId;
  name: string;
  /** Under ten characters, for the phone map. */
  short: string;
  /** What the area is about, in a line. */
  blurb: string;
  /** Which spiral arm, and how far out along it (0 = nearest the center). */
  arm: 0 | 1;
  step: number;
  playbooks: string[];
  /** Any one of these, connected, equips the area. */
  data: DataSource[];
  /** What the area reads, said plainly (the panel). */
  dataNote: string;
  /** What tethr can't see for this area yet, so a low level is explained. */
  blindSpots: string[];
  schedules?: AreaSchedule[];
}

export const GROWTH_AREAS: GrowthArea[] = [
  {
    id: "positioning",
    name: "Positioning",
    short: "Position",
    blurb: "Who it's for, what it replaces, and why it's the better choice.",
    arm: 0,
    step: 0,
    playbooks: ["obviously-awesome", "storybrand-messaging"],
    data: ["profile"],
    dataNote: "Nothing outside tethr: what the company sells, its pages and what customers say.",
    blindSpots: [],
  },
  {
    id: "content",
    name: "Content & social",
    short: "Content",
    blurb: "What the company publishes, and where people see it.",
    arm: 0,
    step: 1,
    playbooks: ["content-strategy", "social-content", "copywriting"],
    data: ["profile"],
    dataNote: "Nothing outside tethr. Social accounts aren't connected, so reach is unknown.",
    blindSpots: ["Social account analytics"],
  },
  {
    id: "seo",
    name: "Search (SEO)",
    short: "SEO",
    blurb: "Showing up when people search Google for what the company sells.",
    arm: 0,
    step: 2,
    playbooks: ["seo-audit", "programmatic-seo", "schema-markup"],
    data: ["google_ads"],
    dataNote: "Google Ads keyword volumes.",
    blindSpots: ["Search Console (rankings and clicks)"],
  },
  {
    id: "geo",
    name: "AI search (GEO)",
    short: "GEO",
    blurb: "Being the answer ChatGPT, Perplexity and Google's AI give.",
    arm: 0,
    step: 3,
    playbooks: ["ai-seo", "schema-markup"],
    data: ["website"],
    dataNote: "The company's own pages.",
    blindSpots: ["What AI search engines actually say about the company"],
  },
  {
    id: "paid_ads",
    name: "Paid ads",
    short: "Paid ads",
    blurb: "Buying attention that pays back.",
    arm: 0,
    step: 4,
    playbooks: ["paid-ads", "ad-creative"],
    data: ["google_ads"],
    dataNote: "Google Ads.",
    blindSpots: ["Meta and other ad platforms"],
  },
  {
    id: "measurement",
    name: "Measurement",
    short: "Measure",
    blurb: "Knowing what works: tracking, attribution and the scorecard.",
    arm: 0,
    step: 5,
    playbooks: ["analytics-tracking", "scorecard-marketing"],
    data: ["posthog", "stripe"],
    dataNote: "PostHog or Stripe.",
    blindSpots: [],
    schedules: ["scorecard"],
  },
  {
    id: "customer_voice",
    name: "Customer voice",
    short: "Voice",
    blurb: "What customers say they need, love and struggle with.",
    arm: 1,
    step: 0,
    playbooks: ["customer-research", "mom-test", "jobs-to-be-done"],
    data: ["gmail", "slack"],
    dataNote: "A feedback source such as Gmail or Slack (themes only, never a customer's details).",
    blindSpots: ["Reviews and support tickets"],
  },
  {
    id: "conversion",
    name: "Conversion",
    short: "Convert",
    blurb: "Turning visitors into customers: pages, sign-up and checkout.",
    arm: 1,
    step: 1,
    playbooks: ["page-cro", "signup-flow-cro", "ab-test-setup"],
    data: ["posthog"],
    dataNote: "PostHog.",
    blindSpots: [],
  },
  {
    id: "pricing",
    name: "Pricing & offers",
    short: "Pricing",
    blurb: "What it costs, how it's packaged, and the offers around it.",
    arm: 1,
    step: 2,
    playbooks: ["pricing-strategy", "hundred-million-offers"],
    data: ["stripe"],
    dataNote: "Stripe.",
    blindSpots: ["Competitors' prices"],
  },
  {
    id: "retention",
    name: "Retention",
    short: "Retain",
    blurb: "Keeping customers and bringing them back.",
    arm: 1,
    step: 3,
    playbooks: ["churn-prevention", "improve-retention"],
    data: ["stripe"],
    dataNote: "Stripe.",
    blindSpots: [],
  },
  {
    id: "email",
    name: "Email & lifecycle",
    short: "Email",
    blurb: "The emails that welcome, nurture and win people back.",
    arm: 1,
    step: 4,
    playbooks: ["email-sequence", "cold-email", "lead-magnets"],
    data: ["gmail"],
    dataNote: "Gmail.",
    blindSpots: ["Email platform analytics (opens and clicks)"],
  },
  {
    id: "partnerships",
    name: "Partnerships",
    short: "Partners",
    blurb: "Other businesses and people who send customers your way.",
    arm: 1,
    step: 5,
    playbooks: ["referral-program", "sales-enablement"],
    data: ["profile"],
    dataNote: "Nothing outside tethr: partners and deals tethr knows about.",
    blindSpots: [],
  },
];

/** Areas that feed each other: neighbours along an arm, so a link never crosses the map. */
export const AREA_LINKS: Array<[AreaId, AreaId]> = [
  ["positioning", "content"],
  ["content", "seo"],
  ["seo", "geo"],
  ["geo", "paid_ads"],
  ["paid_ads", "measurement"],
  ["customer_voice", "conversion"],
  ["conversion", "pricing"],
  ["pricing", "retention"],
  ["retention", "email"],
  ["email", "partnerships"],
];

const BY_ID = new Map(GROWTH_AREAS.map((a) => [a.id, a]));

export function isAreaId(value: unknown): value is AreaId {
  return typeof value === "string" && BY_ID.has(value as AreaId);
}

export function areaById(id: AreaId): GrowthArea {
  return BY_ID.get(id)!;
}

export const LEVEL_NAMES = ["Unexplored", "Discovered", "Charted", "Working", "Established", "Strong", "Mastered"] as const;

/** The six things an area can unlock, in the order they're usually earned. */
export const UNLOCKS = ["mapped", "equipped", "informed", "aimed", "staffed", "proven"] as const;
export type UnlockKey = (typeof UNLOCKS)[number];

export const UNLOCK_LABEL: Record<UnlockKey, string> = {
  mapped: "Mapped",
  equipped: "Equipped",
  informed: "Informed",
  aimed: "Aimed",
  staffed: "Staffed",
  proven: "Proven",
};

/** A link lights up when both of its areas are at least this level (Working). */
export const LIT_LINK_LEVEL = 3;
