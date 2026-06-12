// Vendored compact org spec for the Wandr Growth company, derived from the
// /tethr bundle (import/wandr-growth.company.json + FINE-TUNING-SUMMARY.md +
// every agent's ROLE.md / ROUTING.md / subagents/*.md, bundle version
// 2026-06-10). The seeder prefers the live bundle markdown (TETHR_BUNDLE_PATH)
// for Drive content; this spec makes the product fully self-contained.

import type { TethrSensitivity } from "@paperclipai/shared";

export interface SpecRoutingEntry {
  when: string[];
  to: string;
  description: string;
}

export interface SpecSubagent {
  key: string;
  name: string;
  job: string;
  routeWhen: string[];
  notHere: Array<{ phrase: string; to: string }>;
  reads: string[];
  steps: string[];
  output: string;
  guardrails: string[];
  doneWhen: string;
  escalation: string;
  sensitivity: TethrSensitivity;
}

export interface SpecAgent {
  key: string;
  codename: string;
  role: string;
  mission: string;
  approvalGate: "medical" | "public" | "spend" | "pr" | "internal" | "none";
  heartbeatCron: string | null;
  heartbeatNote: string;
  status: "active" | "paused";
  icon: string;
  portPriority?: number;
  heartbeatRequest?: string;
  heartbeatChain?: string[];
  budgetMonthlyCents: number;
  routing: SpecRoutingEntry[];
  subagents: SpecSubagent[];
}

export const COMPANY = {
  name: "Wandr Growth",
  issuePrefix: "WG",
  goal:
    "Grow Wandr Health's qualified traffic and revenue through owned content (SEO/GEO), destination briefs, itineraries, paid acquisition, PR, and strategy — within sustainable unit economics and with clinical accuracy gated by human review.",
  budgetMonthlyCents: 150000,
};

export const DIVISIONS = [
  {
    key: "growth",
    name: "Growth",
    description:
      "Content, briefs, itineraries, scout, ads, analytics, PR, and strategy under Helm. Division #1 — fully built.",
    status: "active" as const,
    icon: "trending-up",
    sortOrder: 0,
  },
  {
    key: "engineering",
    name: "Engineering",
    description:
      "Product and platform engineering. Ready-to-fill shell: add a head and agents — no re-architecture needed.",
    status: "shell" as const,
    icon: "wrench",
    sortOrder: 1,
  },
  {
    key: "reliability",
    name: "Reliability",
    description:
      "Errors, uptime, and incident response. Ready-to-fill shell division.",
    status: "shell" as const,
    icon: "shield-check",
    sortOrder: 2,
  },
  {
    key: "support",
    name: "Customer Feedback",
    description:
      "Support, feedback triage, and voice-of-customer. Ready-to-fill shell division.",
    status: "shell" as const,
    icon: "message-circle",
    sortOrder: 3,
  },
];

export const STANDING_RULES = [
  "No 'delivered to your door' framing (shipping wound down May 2026)",
  "Azithromycin 500mg ×3 for traveler's diarrhea — never 'Z-Pak'",
  "Only prescribe from the 11-medication catalog",
  "Rotate hero-headline patterns; no competitor plagiarism; minimize em-dashes",
  "Clinical + public-facing output is human-approved before publish",
];

export const HELM = {
  key: "helm",
  codename: "Helm",
  role: "Chief Growth Officer",
  tag: "@helm",
  icon: "compass",
  mission:
    "Route every growth request to the right agent; assign and sequence work so efforts compound; hold budget and route approvals; keep brand/resources consistent; report rolled-up growth view to CEO.",
  routing: [
    {
      when: ["blog posts", "seo", "geo", "keywords", "content images", "article", "write a post"],
      to: "@atlas",
      description: "Content & SEO drafting, optimization, keyword research",
    },
    {
      when: ["destination briefs", "travel-medicine briefs", "bundles", "brief"],
      to: "@compass",
      description: "Destination-level travel-medicine content (deeper than country pages)",
    },
    {
      when: ["day-by-day itineraries", "travel plans", "itinerary", "plan a trip"],
      to: "@voyager",
      description: "Health-smart itinerary drafting with medicine + pacing layers",
    },
    {
      when: ["finding leads", "social listening", "travel-health news", "scan reddit", "leads", "news scan"],
      to: "@sonar",
      description: "Scout for travelers asking health Qs, surface content opportunities",
    },
    {
      when: ["google ads", "paid campaigns", "ad copy", "bids", "negatives", "campaign"],
      to: "@tailwind",
      description: "Ads analysis, copy, bidding, performance optimization",
    },
    {
      when: ["what we can afford", "analytics", "p&l", "cac", "roas", "traffic", "unit economics", "budget", "dashboard"],
      to: "@ledger",
      description: "Economics, guardrails, analytics dashboard",
    },
    {
      when: ["press releases", "announcements", "media pickups", "press", "newsroom"],
      to: "@herald",
      description: "Newsroom content, PR, third-party coverage capture",
    },
    {
      when: ["icp", "positioning", "messaging", "brand voice", "experiments", "target audience", "on-brand"],
      to: "@beacon",
      description: "Strategy, brand coherence, targeting, winning messages",
    },
  ] satisfies SpecRoutingEntry[],
};

export const AGENTS: SpecAgent[] = [
  {
    key: "atlas",
    codename: "Atlas",
    role: "Content & SEO",
    mission:
      "Produce and optimize Wandr's GEO/SEO blog content on a daily cadence, keep the content library healthy. Never auto-publish clinical content.",
    approvalGate: "medical",
    heartbeatCron: "0 21 * * *",
    heartbeatNote: "Daily 9:01 PM (daily-blog-writer workflow, enabled)",
    status: "active",
    icon: "pen-line",
    heartbeatRequest:
      "Write today's post: draft the next GEO/SEO blog article from the content calendar and stage it for review.",
    heartbeatChain: ["blog"],
    budgetMonthlyCents: 20000,
    routing: [
      {
        when: ["write today's post", "draft an article", "blog about"],
        to: "@atlas.blog",
        description: "Blog article drafting, pillar-cluster model",
      },
      {
        when: ["optimize this for ai search", "make this geo-ready", "add schema", "json-ld"],
        to: "@atlas.geo",
        description: "Retrofit answer capsules, chunking, schema onto existing content",
      },
      {
        when: ["keyword research", "what should we rank for", "topic ideas"],
        to: "@atlas.keywords",
        description: "Keyword/topic opportunity research, gap analysis",
      },
    ],
    subagents: [
      {
        key: "blog",
        name: "Blog Writer",
        job: "Draft one CMS-ready, GEO-optimized travel-health blog article (pillar-cluster model) and stage it for human approval.",
        routeWhen: [
          "write today's post",
          "draft an article on x",
          "blog about",
          "turn this keyword into a post",
        ],
        notHere: [
          { phrase: "Pure GEO/schema retrofit of existing content", to: "@atlas.geo" },
          { phrase: "Pure keyword research", to: "@atlas.keywords" },
          { phrase: "Destination brief", to: "@compass.brief" },
          { phrase: "Day-by-day itinerary", to: "@voyager.draft" },
        ],
        reads: [
          "_content-calendar.md (next topic + TOPIC SELECTION WEIGHTING)",
          "_pillar-trip-prep-spec.md (required for Pillar 6 posts)",
          "_geo-checklist.md (mandatory pre-publish)",
          "shared/CLAUDE.md (brand voice, clinical rules, author bios)",
          "Existing drafts/published (to dedupe featured_image)",
        ],
        steps: [
          "Pick topic from calendar; respect Pillar-6 cap (skip if 2+ of last 8 were Travel Planning)",
          "Draft H1 → answer capsule (75–150 words, ≥1 stat, physician signal) → standalone H2 chunks",
          "Apply Princeton methods (≥2 CDC/WHO citations; ≥3 statistics; authoritative tone; target ≥6 of 8)",
          "Add FAQ (5–10 Qs, 40–60-word answers) + FAQPage schema",
          "YAML front matter: approved author, author_bio VERBATIM, unique deduped featured_image, internal links",
          "Run GEO checklist; save",
        ],
        output:
          "One markdown file → content-pipeline/drafts/, then approval message. Accuracy-critical posts also copy to review/ for physician sign-off",
        guardrails: [
          "Medical-sensitive → never auto-publish; human approves",
          "No 'delivered to your door' framing; Azithromycin 500mg ×3, never 'Z-Pak'",
          "Only the 11-med catalog; no competitor plagiarism; minimize em-dashes",
          "Never invent author bios/credentials; never give visa/immigration determinations",
        ],
        doneWhen:
          "Draft in drafts/, GEO checklist ≥6/8, unique featured image, approval message posted",
        escalation: "Out of scope but Atlas's domain → @atlas; cross-domain → @helm",
        sensitivity: "medical",
      },
      {
        key: "geo",
        name: "GEO Optimizer",
        job: "Make existing content the source LLMs cite. Retrofit answer capsules, chunking, schema/JSON-LD, and Princeton methods onto a page that already exists.",
        routeWhen: [
          "optimize this for ai search",
          "make this geo-ready",
          "add schema",
          "why aren't we getting cited",
          "add an answer capsule",
        ],
        notHere: [
          { phrase: "Writing a brand-new article from scratch", to: "@atlas.blog" },
          { phrase: "Finding what topics to target", to: "@atlas.keywords" },
        ],
        reads: ["Target page/draft", "_geo-checklist.md", "shared/CLAUDE.md (author signals)"],
        steps: [
          "Score the page against the GEO checklist (answer capsule, chunk optimization, Princeton 8)",
          "Insert/replace answer capsule after H1 (75–150 words, ≥1 stat, physician signal)",
          "Rework H2s into standalone 75–225-word chunks; kill 'as mentioned above' dependencies",
          "Add/repair FAQPage schema (5–10 Qs) and any missing JSON-LD",
          "Verify ≥2 citations, ≥3 stats, authoritative tone; confirm NO keyword stuffing",
        ],
        output: "Optimized page/draft in place, plus short before/after GEO score note",
        guardrails: [
          "Don't change clinical facts while optimizing; flag any that look wrong for review",
          "Same brand/clinical rules as @atlas.blog",
        ],
        doneWhen: "GEO checklist ≥6/8 with capsule + schema present; score note recorded",
        escalation: "Out of scope but Atlas's domain → @atlas; cross-domain → @helm",
        sensitivity: "medical",
      },
      {
        key: "keywords",
        name: "Keyword & Topic Researcher",
        job: "Find keyword/topic opportunities and map them to the pillar-cluster model so the blog writer always has a sharp, intent-ranked queue.",
        routeWhen: [
          "keyword research",
          "what should we rank for",
          "topic ideas",
          "find content gaps",
          "what is competitor ranking for",
        ],
        notHere: [
          { phrase: "Actually writing the post", to: "@atlas.blog" },
          { phrase: "Retrofitting an existing page", to: "@atlas.geo" },
          { phrase: "Paid keyword mining for ads", to: "@tailwind.negatives" },
        ],
        reads: [
          "_content-calendar.md (existing queue + tiers)",
          "Competitor pages (Runway, Passport, TravelMeds2Go)",
          "Search-term signals",
          "Tailwind's high-converting terms",
        ],
        steps: [
          "Cluster opportunities by pillar (1–6) and intent (bottom/mid/top funnel)",
          "Check each candidate against the calendar to avoid duplicates",
          "Rank by intent + revenue proximity (medication-comparison / 'how to get' first)",
          "Note target query, pillar, and suggested angle for each",
        ],
        output:
          "Ranked topic/keyword list → appended as candidates in _content-calendar.md (or returned in chat)",
        guardrails: [
          "Bottom-funnel, revenue-linked topics first; no competitor copying — angles only",
          "Respect the Pillar-6 down-weight",
        ],
        doneWhen: "Ranked, de-duplicated candidate list with pillar + intent tags",
        escalation: "Out of scope but Atlas's domain → @atlas; cross-domain → @helm",
        sensitivity: "internal",
      },
    ],
  },
  {
    key: "compass",
    codename: "Compass",
    role: "Destination Briefs",
    mission:
      "Nightly, draft one travel-medicine destination brief and queue the next idea, going a layer deeper than the existing country pages (hotspot-level long-tail).",
    approvalGate: "medical",
    heartbeatCron: "53 22 * * *",
    heartbeatNote: "Nightly 10:53 PM (destination-brief-auto workflow, enabled)",
    status: "active",
    icon: "map",
    heartbeatRequest:
      "Run tonight's brief: pick the oldest un-briefed destination, draft the travel-medicine brief, and queue one new idea atomically.",
    heartbeatChain: ["brief"],
    budgetMonthlyCents: 15000,
    routing: [
      {
        when: ["brief", "destination page", "travel-medicine page", "tonight's brief"],
        to: "@compass.brief",
        description: "Destination brief engine, queue advancement",
      },
    ],
    subagents: [
      {
        key: "brief",
        name: "Destination Brief Engine",
        job: "Produce travel-medicine destination/hotspot briefs and keep the pipeline ahead of what's published. The live nightly workflow, also callable on demand.",
        routeWhen: [
          "brief [destination]",
          "write a destination page",
          "draft tonight's brief",
          "queue a new destination",
          "advance the brief queue",
        ],
        notHere: [
          { phrase: "A blog article", to: "@atlas.blog" },
          { phrase: "A day-by-day itinerary", to: "@voyager.draft" },
          { phrase: "Promoting draft to Published / Stripe IDs", to: "human step" },
        ],
        reads: [
          "Destination/bundle tracker",
          "11-med catalog",
          "wandr-nightly-auto-brief skill",
          "CDC/WHO research data",
        ],
        steps: [
          "Locked-tracker check: if locked, read from copy only; if unreadable, post a note and exit cleanly",
          "Discover schema adaptively (fuzzy-match headers; don't hard-code columns)",
          "Pick target: topmost destination row with no existing brief and enough context",
          "Draft brief: live CDC/WHO research, primary-risk classification, single med + bundle meds, every stat cited",
          "Queue one new destination idea atomically across all three tracker sheets",
          "Post run summary (what was briefed, queued, any skips)",
        ],
        output: "One {slug}-brief.md in /Drafts/ + one new queued destination + summary",
        guardrails: [
          "Pricing: $89 single / $129 bundle",
          "URL path: /travel-medicine/[slug] (never /destinations/)",
          "11 Wandr meds only; no loperamide → Dicyclomine (Bentyl) for TD cramps",
          "Never write 'Z-Pak' anywhere; it's azithromycin 500mg ×3",
          "No shipping language; headlines must vary; seo_tags REQUIRED (4–6 tags)",
        ],
        doneWhen:
          "Brief drafted with all hard rules satisfied and seo_tags present; one idea queued atomically; summary posted",
        escalation:
          "Out of scope but Compass's domain → @compass; cross-domain → @helm. Medical output → staged for human approval",
        sensitivity: "medical",
      },
    ],
  },
  {
    key: "voyager",
    codename: "Voyager",
    role: "Itineraries",
    mission:
      "Draft one day-by-day, health-smart, GEO-optimized travel itinerary per day and stage it for review.",
    approvalGate: "medical",
    heartbeatCron: "0 1 * * *",
    heartbeatNote: "Nightly 1:00 AM (itineraries-auto workflow, enabled)",
    status: "active",
    icon: "route",
    heartbeatRequest:
      "Draft the next itinerary from the content calendar with the full health layer woven in, and stage it for review.",
    heartbeatChain: ["draft", "health"],
    budgetMonthlyCents: 15000,
    routing: [
      {
        when: ["itinerary for", "plan x days in", "draft the next itinerary", "travel plan"],
        to: "@voyager.draft",
        description: "Day-by-day itinerary writing, render-ready prep",
      },
      {
        when: ["health layer", "what meds for this trip", "acclimatization pacing", "disease seasonality"],
        to: "@voyager.health",
        description: "Travel-medicine layer (disease seasonality, meds, timelines)",
      },
    ],
    subagents: [
      {
        key: "draft",
        name: "Itinerary Writer",
        job: "Draft one day-by-day, health-smart travel itinerary as render-ready markdown. The live itineraries-auto workflow, also callable on demand.",
        routeWhen: ["itinerary for", "plan x days in", "draft the next itinerary", "build a travel plan"],
        notHere: [
          { phrase: "The medical layer specifically", to: "@voyager.health" },
          { phrase: "A reference 'health situation in X' page", to: "@compass.brief" },
          { phrase: "A blog article", to: "@atlas.blog" },
        ],
        reads: [
          "_agent-instructions.md (operating manual)",
          "RENDERING-REFERENCE.md (live contract)",
          "_pillar-trip-prep-spec.md",
          "wandr-itineraries-engine skill",
        ],
        steps: [
          "Pick the next Idea row from _content-calendar.md",
          "Write a genuinely useful day-by-day plan (days[]: day, title, summary, health_note)",
          "Add H1 → answer capsule, ## The route, 1–2 body images at natural breakpoints",
          "Rotate physician byline; copy author_bio VERBATIM (3 approved authors)",
          "Render contract: full frontmatter, days[], rails, cta_variant, single cta split marker",
          "Unique featured image + body images: free-license only, deduped, verified, logged",
        ],
        output:
          "Render-ready {slug}.md in Drafts/, valid frontmatter, unique deduped images, calendar row at Review",
        guardrails: [
          "Medical-sensitive → never auto-publish; physician reviews on dev first",
          "Never duplicate a destination guide (planning layer, not reference)",
          "No shipping language; 11-med catalog only; never 'Z-Pak'; vary headlines",
        ],
        doneWhen:
          "Render-ready file in Drafts/ with valid frontmatter and deduped images; calendar row at Review; summary posted",
        escalation: "Out of scope but Voyager's domain → @voyager; cross-domain → @helm",
        sensitivity: "medical",
      },
      {
        key: "health",
        name: "Health Layerer",
        job: "Add the travel-medicine layer that makes an itinerary 'health-smart' — the actual differentiation and the reason Voyager exists.",
        routeWhen: [
          "add the health layer",
          "what meds for this trip",
          "acclimatization pacing",
          "when should they start",
          "disease seasonality",
        ],
        notHere: [
          { phrase: "Writing the day structure / prose", to: "@voyager.draft" },
          { phrase: "Prescribing copy for a destination page", to: "@compass.brief" },
        ],
        reads: [
          "11-medication catalog",
          "Destination health data (CDC/WHO)",
          "Trip-Prep spec's health-prep-timeline rules",
        ],
        steps: [
          "Produce acclimatization/altitude pacing baked into day order (sleep-altitude limits, rest days)",
          "Layer disease seasonality on the route tied to best_time_to_go",
          "Populate health_focus[], travel_medicine_slugs[], medication_slugs[]",
          "Populate health_prep_timeline[] counting back from departure",
        ],
        output:
          "Health layer integrated into days[] + the four health frontmatter fields populated and catalog-valid",
        guardrails: [
          "11-med catalog only; no loperamide → Dicyclomine (Bentyl) for TD cramps",
          "Azithromycin 500mg ×3 for TD — never 'Z-Pak'",
          "Every clinical claim grounded in CDC/WHO; phrase conditionally, cite source",
          "Medical-sensitive → physician reviews before publish",
        ],
        doneWhen:
          "Health layer integrated and catalog-valid, ready for physician review",
        escalation: "Out of scope but Voyager's domain → @voyager; cross-domain → @helm",
        sensitivity: "medical",
      },
    ],
  },
  {
    key: "sonar",
    codename: "Sonar",
    role: "Scout",
    mission:
      "Detect where travelers ask health questions, surface real leads, draft genuinely helpful (non-promotional) replies for a human to send, and flag timely content opportunities.",
    approvalGate: "public",
    heartbeatCron: "0 8 * * *",
    heartbeatNote: "Daily 8:07 AM (lead-scout workflow, paused since 2026-03-25)",
    status: "paused",
    icon: "radar",
    portPriority: 1,
    heartbeatRequest:
      "Run the morning scout: scan Reddit, X, and forums for fresh travel-health questions, rank the leads, and draft a zero-promotion reply for the top thread.",
    heartbeatChain: ["leads", "reply"],
    budgetMonthlyCents: 10000,
    routing: [
      {
        when: ["find leads", "who's asking about", "scan reddit", "competitor chatter"],
        to: "@sonar.leads",
        description: "Lead discovery on social/forums",
      },
      {
        when: ["draft a reply", "respond to this thread", "what should i say here"],
        to: "@sonar.reply",
        description: "Response drafting for human posting",
      },
      {
        when: ["any travel news", "news scan", "what's trending in travel health", "check cdc"],
        to: "@sonar.news",
        description: "CDC/WHO/State Dept news ranking",
      },
    ],
    subagents: [
      {
        key: "leads",
        name: "Lead Finder",
        job: "Scan Reddit, X, forums, and Q&A for recent travelers asking health questions (or discussing competitors) and rank the best lead opportunities. The live lead-scout workflow.",
        routeWhen: ["find leads", "who's asking about", "scan reddit", "competitor chatter"],
        notHere: [
          { phrase: "Writing the actual reply", to: "@sonar.reply" },
          { phrase: "CDC/WHO news", to: "@sonar.news" },
        ],
        reads: [
          "Reddit (r/travel, r/solotravel, r/digitalnomad, regional subs, r/AskDocs)",
          "X/Twitter",
          "Tripadvisor / Lonely Planet / Quora",
          "Pain-point + competitor query list (Passport Health, Runway, TravelMeds2Go)",
        ],
        steps: [
          "Search pain-point categories + competitor queries; focus on the last 4–6 hours",
          "Keep only genuine questions/comparisons; drop old threads without fresh activity",
          "Rank: quality over quantity (3 great > 15 mediocre); hand each to @sonar.reply",
        ],
        output:
          "Ranked lead list (link, context, why qualifies) → #scout. Message only if leads found",
        guardrails: [
          "Public sources only; no Drive-write dependency; never auto-engage — humans act on leads",
        ],
        doneWhen: "Ranked, fresh, deduped lead list posted (or silence if none)",
        escalation: "Out of scope but Sonar's domain → @sonar; cross-domain → @helm",
        sensitivity: "safe",
      },
      {
        key: "reply",
        name: "Response Drafter",
        job: "Write a genuinely helpful, non-promotional expert reply to a lead a human can post.",
        routeWhen: ["draft a reply", "respond to this thread", "what should i say here"],
        notHere: [
          { phrase: "Finding the leads", to: "@sonar.leads" },
          { phrase: "News scan", to: "@sonar.news" },
        ],
        reads: ["Thread/lead context (from @sonar.leads)", "Travel-health domain knowledge"],
        steps: [
          "Answer the person's actual question, concretely and accurately",
          "Match the platform's tone; sound like a knowledgeable human, not a brand",
          "Keep it tight; lead with the helpful answer",
        ],
        output: "A ready-to-post reply (plain text) attached to the lead",
        guardrails: [
          "No self-promotion; never mention Wandr, the domain, or any product — promotional replies get accounts banned",
          "A human posts it; never auto-post",
          "Clinically accurate; no dosing advice that should come from a clinician; never 'Z-Pak'",
        ],
        doneWhen: "A helpful, zero-pitch reply drafted for a human to send",
        escalation: "Out of scope but Sonar's domain → @sonar; cross-domain → @helm",
        sensitivity: "public",
      },
      {
        key: "news",
        name: "News Scanner",
        job: "Scan CDC/WHO/State Dept for travel-health news and rank blog-post opportunities. Research only — writes no files.",
        routeWhen: ["any travel news", "news scan", "what's trending in travel health", "check cdc"],
        notHere: [
          { phrase: "Finding leads", to: "@sonar.leads" },
          { phrase: "Writing the post the news suggests", to: "@atlas.blog" },
        ],
        reads: ["CDC", "WHO", "State Department", "Wandr content pillars + 11-med catalog"],
        steps: [
          "Pull recent travel-health items from gov sources",
          "Score each for relevance to Wandr's pillars/meds",
          "Rank as content opportunities (what to write, which pillar, why timely)",
        ],
        output: "Ranked digest → chat only. Modifies no files, no trackers",
        guardrails: ["Research/reporting only — safe to auto-run; cite sources"],
        doneWhen: "Ranked, relevance-scored opportunity digest delivered",
        escalation: "Out of scope but Sonar's domain → @sonar; cross-domain → @helm",
        sensitivity: "safe",
      },
    ],
  },
  {
    key: "tailwind",
    codename: "Tailwind",
    role: "Ads",
    mission:
      "Run profitable paid acquisition within the limits Ledger sets. Analyze performance, recommend changes, and execute approved ones.",
    approvalGate: "spend",
    heartbeatCron: null,
    heartbeatNote:
      "On-demand only; moves real money. Google Ads MCP + Chrome action layer are laptop-bound — port last, execution-gated.",
    status: "active",
    icon: "wind",
    heartbeatRequest:
      "Review current campaign performance against Ledger's guardrails and surface any recommended changes (no execution).",
    heartbeatChain: ["analyze"],
    budgetMonthlyCents: 40000,
    routing: [
      {
        when: ["how are ads doing", "campaign performance", "search term report", "what's working"],
        to: "@tailwind.analyze",
        description: "Performance analysis vs guardrails",
      },
      {
        when: ["clean up search terms", "add negatives", "wasting spend"],
        to: "@tailwind.negatives",
        description: "Negative-keyword mining from wasted spend",
      },
      {
        when: ["new ad copy", "write ad variations", "rsa headlines"],
        to: "@tailwind.copy",
        description: "Ad copy drafting on brand + winning angles",
      },
      {
        when: ["adjust bids", "reallocate budget", "scale campaign", "apply the negatives"],
        to: "@tailwind.bids",
        description: "Bid/budget changes (human-gated), apply negatives",
      },
    ],
    subagents: [
      {
        key: "analyze",
        name: "Performance Analyst",
        job: "Pull and interpret Google Ads performance — campaigns, keywords, search terms, audiences — against Ledger's guardrails.",
        routeWhen: ["how are ads doing", "campaign performance", "what's working", "search term report"],
        notHere: [
          { phrase: "Proposing negatives", to: "@tailwind.negatives" },
          { phrase: "New ad copy", to: "@tailwind.copy" },
          { phrase: "Changing bids/budgets", to: "@tailwind.bids" },
        ],
        reads: [
          "Google Ads MCP (sub-acct 672-664-9537, MCC 878-630-0625) — mocked locally",
          "CSV fallback",
          "Ledger guardrails (max CAC / ideal ROAS)",
          "_kpi-targets.md",
        ],
        steps: [
          "Pull performance via the MCP (GAQL) or CSV fallback",
          "Compare CPA/ROAS against Ledger's targets — flag profitable vs underwater",
          "Surface insights + push spend totals back to Ledger",
        ],
        output: "Performance read + ranked insights (→ Beacon for messaging, Ledger for spend)",
        guardrails: ["Read/analyze only — no live changes here; confirm MCP auth before relying"],
        doneWhen: "Performance summarized vs guardrails with clear next actions",
        escalation: "Out of scope but Tailwind's domain → @tailwind; cross-domain → @helm",
        sensitivity: "internal",
      },
      {
        key: "bids",
        name: "Bid & Budget Optimizer",
        job: "Recommend bid and budget changes within Ledger's guardrails. The money-moving subagent — it proposes, a human approves.",
        routeWhen: ["adjust bids", "reallocate budget", "scale campaign", "apply the negatives"],
        notHere: [
          { phrase: "Analysis", to: "@tailwind.analyze" },
          { phrase: "Setting the affordability limits", to: "@ledger.guardrails" },
        ],
        reads: ["Ledger guardrails (max CAC, ideal CPC/ROAS, budget rec)", "Current performance"],
        steps: [
          "Compare current spend/CPA to guardrails",
          "Produce a specific change set (bid/budget deltas, pauses, the approved negatives)",
        ],
        output: "A change RECOMMENDATION → HUMAN APPROVAL required before anything goes live",
        guardrails: [
          "Never auto-execute spend changes; stay within Ledger's caps",
          "Google Ads MCP + Chrome action layer are local today — execution stays human until hosted/headless is confirmed",
        ],
        doneWhen: "Approved-ready change set that respects the guardrails, queued for a human",
        escalation: "Out of scope but Tailwind's domain → @tailwind; cross-domain → @helm",
        sensitivity: "spend",
      },
      {
        key: "copy",
        name: "Ad Copy Writer",
        job: "Draft new ad variations on Wandr's brand + winning messaging angles.",
        routeWhen: ["new ad copy", "write ad variations", "rsa headlines"],
        notHere: [
          { phrase: "Which message wins strategically", to: "@beacon.messaging" },
          { phrase: "Performance", to: "@tailwind.analyze" },
        ],
        reads: [
          "Beacon messaging/ICP",
          "Winning angles from @tailwind.analyze",
          "Brand voice in shared/CLAUDE.md",
        ],
        steps: [
          "Lead with consumer benefit (saves money/time, eliminates hassle); physician-founded is supporting credibility, never the lead",
          "Draft headlines/descriptions within Google Ads limits; vary angles",
        ],
        output: "Ad copy drafts (RSA-ready)",
        guardrails: [
          "No 'delivered to your door'/shipping language — Wandr stopped shipping (May 2026)",
          "Never fear-based; never 'Z-Pak'",
        ],
        doneWhen: "On-brand, benefit-led ad variations ready to load",
        escalation: "Out of scope but Tailwind's domain → @tailwind; cross-domain → @helm",
        sensitivity: "spend",
      },
      {
        key: "negatives",
        name: "Negative-Keyword Miner",
        job: "Find wasted spend in search terms and propose negative keywords.",
        routeWhen: ["clean up search terms", "add negatives", "where are we wasting spend"],
        notHere: [
          { phrase: "General performance", to: "@tailwind.analyze" },
          { phrase: "Applying changes live", to: "@tailwind.bids" },
        ],
        reads: ["Search-term reports (MCP/CSV)", "Conversion data"],
        steps: [
          "Pull search terms; flag irrelevant/non-converting/expensive queries",
          "Propose a negative-keyword list with rationale and match types",
        ],
        output: "Negative-keyword recommendation list",
        guardrails: ["Proposes only; applying negatives is a change → human approval (@tailwind.bids path)"],
        doneWhen: "Justified negative list ready for approval",
        escalation: "Out of scope but Tailwind's domain → @tailwind; cross-domain → @helm",
        sensitivity: "spend",
      },
    ],
  },
  {
    key: "ledger",
    codename: "Ledger",
    role: "Analytics & Economics",
    mission:
      "Own the numbers. Calculate what Wandr can afford per customer, set the ad guardrails, and keep the analytics source of truth current.",
    approvalGate: "internal",
    heartbeatCron: "0 0 * * 0",
    heartbeatNote: "Weekly Sunday (analytics-weekly-refresh workflow, enabled)",
    status: "active",
    icon: "calculator",
    heartbeatRequest:
      "Run the weekly analytics refresh: pull rolling-30d GA4 metrics, refresh the dashboard, and post the weekly update.",
    heartbeatChain: ["reporter"],
    budgetMonthlyCents: 10000,
    routing: [
      {
        when: ["what we can afford", "max cac", "ideal cpc", "roas", "ad budget"],
        to: "@ledger.guardrails",
        description: "CAC/ROAS guardrails and budget recommendations",
      },
      {
        when: ["is product profitable", "unit economics", "margins", "blended p&l"],
        to: "@ledger.modeler",
        description: "Per-product + blended P&L and LTV modeling",
      },
      {
        when: ["weekly numbers", "refresh the dashboard", "traffic report", "ga4"],
        to: "@ledger.reporter",
        description: "Analytics dashboard refresh and traffic reporting",
      },
    ],
    subagents: [
      {
        key: "guardrails",
        name: "CAC / ROAS Guardrails",
        job: "Set what Wandr can afford per customer — the limits Tailwind must obey.",
        routeWhen: ["what can we afford", "max cac", "ideal cpc", "roas", "what's the ad budget"],
        notHere: [
          { phrase: "The underlying P&L math", to: "@ledger.modeler" },
          { phrase: "Traffic dashboard", to: "@ledger.reporter" },
        ],
        reads: ["Unit-economics outputs from @ledger.modeler", "unit-economics_agent-instructions.md"],
        steps: [
          "From margins + AOV + repeat behavior, derive max allowable CAC, ideal CPC, ideal ROAS",
          "Recommend a monthly budget; flag if current spend exceeds sustainable levels",
        ],
        output: "Guardrail targets → consumed by @tailwind.bids/@tailwind.analyze and Helm",
        guardrails: [
          "Internal; ~100-customer dataset → flag low statistical confidence in every output",
          "Exclude free pre-trip health check from revenue/AOV",
        ],
        doneWhen: "Current max CAC / CPC / ROAS / budget rec published with a confidence caveat",
        escalation: "Out of scope but Ledger's domain → @ledger; cross-domain → @helm",
        sensitivity: "internal",
      },
      {
        key: "modeler",
        name: "Unit Economics Modeler",
        job: "Compute per-product and blended P&L / margin so the guardrails rest on real math.",
        routeWhen: ["is product profitable", "unit economics", "margins", "blended p&l"],
        notHere: [
          { phrase: "Turning margins into ad limits", to: "@ledger.guardrails" },
          { phrase: "GA4 traffic", to: "@ledger.reporter" },
        ],
        reads: [
          "Shopify exports (revenue, orders, AOV, product mix, repeat rate)",
          "COGS, fulfillment, operating costs",
          "Ad-spend from Tailwind",
        ],
        steps: [
          "Build per-line margins (meds = COGS+fulfillment; vaccines = booking fee; insurance = commission)",
          "Roll up blended contribution + defensible LTV given ~100 customers",
        ],
        output: "Per-product + blended P&L / margin + LTV → feeds @ledger.guardrails and Beacon",
        guardrails: ["Internal; state assumptions; flag small-sample uncertainty; exclude free health check"],
        doneWhen: "Margin + LTV model with explicit assumptions and confidence notes",
        escalation: "Out of scope but Ledger's domain → @ledger; cross-domain → @helm",
        sensitivity: "internal",
      },
      {
        key: "reporter",
        name: "Analytics Reporter",
        job: "Refresh the Wandr analytics dashboard (rolling 30d) and post the weekly update. The live weekly-refresh workflow.",
        routeWhen: ["weekly numbers", "refresh the dashboard", "traffic report", "how's ga4 looking"],
        notHere: [
          { phrase: "Profitability math", to: "@ledger.modeler" },
          { phrase: "Ad spend efficiency", to: "@tailwind.analyze" },
        ],
        reads: ["GA4 (property 462397403) — mocked locally", "Drive analytics data"],
        steps: [
          "Pull rolling-30d GA4 metrics",
          "Refresh the dashboard file in the Drive",
          "Post the weekly update",
        ],
        output: "Refreshed dashboard in the Drive + weekly summary",
        guardrails: ["Internal; note any tracking gaps (GTM/GA4 config) rather than assuming clean data"],
        doneWhen: "Dashboard current (rolling 30d) + weekly note posted",
        escalation: "Out of scope but Ledger's domain → @ledger; cross-domain → @helm",
        sensitivity: "internal",
      },
    ],
  },
  {
    key: "herald",
    codename: "Herald",
    role: "PR / Newsroom",
    mission:
      "Turn real news into ready-to-publish newsroom posts: press releases, partnership announcements, and media pickups.",
    approvalGate: "pr",
    heartbeatCron: null,
    heartbeatNote: "On-demand only when there's real news (newsroom-brief skill)",
    status: "active",
    icon: "megaphone",
    heartbeatRequest:
      "Check for staged newsroom work and draft anything queued (press releases, pickups, announcements).",
    heartbeatChain: ["announce"],
    budgetMonthlyCents: 8000,
    routing: [
      {
        when: ["press release", "we closed funding", "formal launch"],
        to: "@herald.press",
        description: "Press release drafting for major announcements",
      },
      {
        when: ["we got covered", "media pickup", "in the news"],
        to: "@herald.pickup",
        description: "Third-party coverage capture",
      },
      {
        when: ["announce", "company update", "small product news"],
        to: "@herald.announce",
        description: "Lighter announcements for product updates, milestones",
      },
    ],
    subagents: [
      {
        key: "press",
        name: "Press Release Writer",
        job: "Draft a flagship press release (dateline + NewsArticle JSON-LD) for funding, major partnerships, regulatory milestones, or formal launches.",
        routeWhen: ["press release", "we closed funding", "we partnered with", "formal launch"],
        notHere: [
          { phrase: "Third-party coverage", to: "@herald.pickup" },
          { phrase: "Minor update", to: "@herald.announce" },
        ],
        reads: [
          "Provided context (news, quotes, facts, embargo, image)",
          "Newsroom _content-calendar.md + _image-registry.md",
          "Repo contract: src/lib/newsroom.ts, /newsroom/[slug]",
        ],
        steps: [
          "Anti-duplicate: no existing Drafts/Published slug or calendar row (hard fail → bump month/ask)",
          "Write category press-release: dateline, body, quotes, press_contact, FAQ; boilerplate auto-appends",
          "Frontmatter for NewsArticle + FAQPage JSON-LD; unique deduped featured_image; calendar row",
        ],
        output: "Drafts/{topic}-press-release-{YYYY-MM}.md. Human moves Drafts→Published",
        guardrails: [
          "Wandr-only, never another brand; PR-sensitive → human review",
          "Verify any featured_bundles BDL IDs exist; rigorous enough to be the AI's preferred citation",
        ],
        doneWhen: "Render-valid press release in Drafts/, deduped image, calendar row added",
        escalation: "Out of scope but Herald's domain → @herald; cross-domain → @helm",
        sensitivity: "pr",
      },
      {
        key: "pickup",
        name: "Media Pickup Writer",
        job: "Capture third-party coverage (TechCrunch, NYT, a podcast) as an in-the-news item.",
        routeWhen: ["we got covered", "outlet wrote us up", "capture this article", "add to in-the-news"],
        notHere: [
          { phrase: "Our own formal PR", to: "@herald.press" },
          { phrase: "Minor internal note", to: "@herald.announce" },
        ],
        reads: ["The outlet name + article URL + context", "Newsroom calendar/registry"],
        steps: [
          "Anti-duplicate check (slug + calendar)",
          "Category in-the-news: set outlet + external_url; skip press_contact/boilerplate",
          "Unique deduped image; log it; append calendar row",
        ],
        output: "Drafts/{outlet}-{topic}-{YYYY-MM}.md",
        guardrails: ["Wandr-only; verify the URL; PR-sensitive → human review"],
        doneWhen: "Valid in-the-news card in Drafts/ pointing at the real coverage",
        escalation: "Out of scope but Herald's domain → @herald; cross-domain → @helm",
        sensitivity: "pr",
      },
      {
        key: "announce",
        name: "Announcement Writer",
        job: "Draft a lighter announcement (no dateline, no press-contact) for minor product updates, team milestones, or blog-adjacent notes.",
        routeWhen: ["announce", "company update", "small product news", "team milestone"],
        notHere: [
          { phrase: "Formal PR", to: "@herald.press" },
          { phrase: "External coverage", to: "@herald.pickup" },
        ],
        reads: ["Announcement facts", "Newsroom calendar/registry"],
        steps: [
          "Anti-duplicate check",
          "Category announcement: concise body, FAQ if useful; unique deduped image; calendar row",
        ],
        output: "Drafts/{topic}-{YYYY-MM}.md",
        guardrails: ["Wandr-only; human review before publish; don't over-formalize minor news"],
        doneWhen: "Clean announcement in Drafts/ with valid frontmatter",
        escalation: "Out of scope but Herald's domain → @herald; cross-domain → @helm",
        sensitivity: "pr",
      },
    ],
  },
  {
    key: "beacon",
    codename: "Beacon",
    role: "Strategy & Brand",
    mission:
      "Set direction. Define who we target and what messages work, keep the brand voice coherent, and feed targeting + messaging to the rest of the org.",
    approvalGate: "internal",
    heartbeatCron: null,
    heartbeatNote: "Manual / periodic for GTM strategy; on-demand for Anita brand advisor",
    status: "active",
    icon: "lightbulb",
    heartbeatRequest:
      "Refresh the GTM picture: re-derive ICP signals and messaging recommendations from the latest agent outputs.",
    heartbeatChain: ["icp", "messaging"],
    budgetMonthlyCents: 8000,
    routing: [
      {
        when: ["who do we target", "icp", "customer segments", "does our base match"],
        to: "@beacon.icp",
        description: "ICP definition from real signals",
      },
      {
        when: ["messaging", "positioning", "value prop", "what angle should we lead with"],
        to: "@beacon.messaging",
        description: "Winning messages, positioning vs competitors",
      },
      {
        when: ["is this on-brand", "brand voice", "tighten the voice", "run anita on this"],
        to: "@beacon.brand",
        description: "Brand voice enforcement and consistency",
      },
    ],
    subagents: [
      {
        key: "icp",
        name: "ICP Architect",
        job: "Define and refresh Wandr's ideal customer profiles from real signals, not guesses.",
        routeWhen: ["who do we target", "icp", "customer segments", "does our base match who we think"],
        notHere: [
          { phrase: "The message to those people", to: "@beacon.messaging" },
          { phrase: "Brand voice", to: "@beacon.brand" },
        ],
        reads: [
          "Google Ads audience/search-term data",
          "SEO queries",
          "Ledger's customer/economics data",
          "gtm_icp-profiles.md",
        ],
        steps: [
          "Compare the real ~100-customer base to assumed targets",
          "Define/refresh segments (who converts profitably, by trip type / destination / intent)",
        ],
        output: "Updated ICP profiles → feed @tailwind targeting + @beacon.messaging",
        guardrails: ["Internal; ground in data; flag where small sample limits confidence"],
        doneWhen: "Refreshed, evidence-backed ICP segments",
        escalation: "Out of scope but Beacon's domain → @beacon; cross-domain → @helm",
        sensitivity: "internal",
      },
      {
        key: "messaging",
        name: "Messaging Strategist",
        job: "Define positioning and the winning messages that everything else expresses.",
        routeWhen: ["messaging", "positioning", "value prop", "what angle should we lead with"],
        notHere: [
          { phrase: "Who we target", to: "@beacon.icp" },
          { phrase: "Writing the actual ad", to: "@tailwind.copy" },
          { phrase: "Brand-voice check", to: "@beacon.brand" },
        ],
        reads: [
          "Ad performance (winning angles)",
          "ICP",
          "Competitor positioning (Passport, Runway, TravelMeds2Go)",
        ],
        steps: [
          "Identify which angles convert (benefit-led: saves money/time, eliminates hassle)",
          "Codify positioning vs competitors; physician-founded + all-in-one as supporting credibility",
        ],
        output: "Messaging/positioning guidance → @tailwind.copy, @atlas, @herald",
        guardrails: ["Internal; benefit first, credibility second; no shipping language"],
        doneWhen: "Clear, ranked messaging hierarchy with the lead angle",
        escalation: "Out of scope but Beacon's domain → @beacon; cross-domain → @helm",
        sensitivity: "internal",
      },
      {
        key: "brand",
        name: "Brand Voice Guardian (Anita)",
        job: "Apply and enforce Wandr's brand voice across any content. Powered by the Anita skill.",
        routeWhen: ["is this on-brand", "brand voice", "tighten the voice", "run anita on this"],
        notHere: [
          { phrase: "Strategy/positioning", to: "@beacon.messaging" },
          { phrase: "ICP", to: "@beacon.icp" },
        ],
        reads: ["anita-SKILL.md", "Brand voice + rules in shared/CLAUDE.md"],
        steps: [
          "Check against voice: 'your friend who's also an ER doc and a traveler' — direct, confident, physician-backed, human; never generic pharma, never fear-based",
          "Flag/fix off-voice copy and rule violations",
        ],
        output: "On-brand copy or a brand review with specific fixes",
        guardrails: [
          "Enforce standing rules: no shipping language, never 'Z-Pak', 11-med catalog only, rotate headline patterns, minimize em-dashes, no competitor plagiarism",
        ],
        doneWhen: "Content passes voice + rules, or a clear fix list returned",
        escalation: "Out of scope but Beacon's domain → @beacon; cross-domain → @helm",
        sensitivity: "internal",
      },
    ],
  },
];

// Working-state seeds, condensed from the bundle's content calendars
// (atlas/_content-calendar.md, voyager/_content-calendar.md, the destination
// tracker described in compass specs).
export const STATE_SEEDS = {
  "content-calendar": [
    { topic: "Altitude sickness prevention for Cusco travelers", slug: "altitude-sickness-cusco", pillar: "trip-prep" },
    { topic: "Malaria prophylaxis timing: when to start each option", slug: "malaria-prophylaxis-timing", pillar: "medications" },
    { topic: "Typhoid vaccine vs oral Vivotif for last-minute trips", slug: "typhoid-vaccine-vs-vivotif", pillar: "vaccines" },
    { topic: "Traveler's diarrhea kit: what actually belongs in it", slug: "travelers-diarrhea-kit", pillar: "medications" },
    { topic: "Dengue season in the Caribbean: what travelers should know", slug: "dengue-season-caribbean", pillar: "destinations" },
    { topic: "Rabies pre-exposure: who actually needs it", slug: "rabies-pre-exposure", pillar: "vaccines" },
  ],
  "destination-tracker": [
    { topic: "Zanzibar", slug: "zanzibar" },
    { topic: "Cusco and the Sacred Valley", slug: "cusco-sacred-valley" },
    { topic: "Bali", slug: "bali" },
    { topic: "Kilimanjaro trek", slug: "kilimanjaro" },
    { topic: "Vietnam north loop", slug: "vietnam-north" },
  ],
  "itinerary-calendar": [
    { topic: "7 days in Peru: Cusco, Sacred Valley, Machu Picchu", slug: "peru-7-days" },
    { topic: "10 days Tanzania: safari + Zanzibar", slug: "tanzania-10-days" },
    { topic: "5 days Mexico City + Oaxaca food trip", slug: "mexico-city-oaxaca" },
    { topic: "14 days Southeast Asia first-timer loop", slug: "sea-14-days" },
  ],
} as const;

export const COMPANY_MEMORIES = [
  {
    kind: "rule" as const,
    content:
      "Wandr stopped shipping medications in May 2026 — all 'delivered to your door' copy is dead and must be rewritten on contact.",
  },
  {
    kind: "rule" as const,
    content:
      "Traveler's diarrhea protocol is azithromycin 500mg once daily for 3 days. The word 'Z-Pak' never appears in any output, including comments.",
  },
  {
    kind: "fact" as const,
    content:
      "Catalog is exactly 11 medications. Pricing: $89 single consult / $129 family bundle. Briefs publish at /travel-medicine/[slug].",
  },
  {
    kind: "fact" as const,
    content:
      "Competitors tracked: Passport Health (in-person network), Runway (meds fast), TravelMeds2Go (price-led).",
  },
  {
    kind: "preference" as const,
    content:
      "Mark reviews medical and PR drafts in the evening; queue summaries are most useful before 6 PM.",
  },
];
