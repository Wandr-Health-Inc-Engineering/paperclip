import type {
  AgenticToolEvent,
  ClassifyInput,
  ClassifyResult,
  GenerateInput,
  GenerateResult,
  LLMProvider,
  LLMUsage,
  PlanInput,
  PlanResult,
  RunAgenticInput,
  RunAgenticResult,
} from "./types.js";

// Deterministic local provider. Classification is keyword scoring over each
// option's `when` phrases; generation is a library of realistically-shaped
// templates per output kind. No randomness: the same input always produces
// the same output, which keeps the demo loop and the tests stable offline.

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function approxUsage(input: string, output: string): LLMUsage {
  return {
    inputTokens: Math.max(1, Math.ceil(input.length / 4)),
    outputTokens: Math.max(1, Math.ceil(output.length / 4)),
  };
}

function scoreOption(requestTokens: string[], request: string, when: string[]): number {
  let score = 0;
  const lowerRequest = request.toLowerCase();
  for (const phrase of when) {
    const lowerPhrase = phrase.toLowerCase();
    if (lowerRequest.includes(lowerPhrase)) {
      score += 6 * Math.max(1, lowerPhrase.split(" ").length);
      continue;
    }
    for (const token of tokenize(lowerPhrase)) {
      if (requestTokens.includes(token)) score += 1;
    }
  }
  return score;
}

export class MockProvider implements LLMProvider {
  readonly id = "mock" as const;
  readonly model = "tethr-mock-1";

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const requestTokens = tokenize(input.request);
    let best = input.options[0];
    let bestScore = -1;
    for (const option of input.options) {
      const score =
        scoreOption(requestTokens, input.request, option.when) +
        scoreOption(requestTokens, input.request, [option.description]) * 0.5;
      if (score > bestScore) {
        best = option;
        bestScore = score;
      }
    }
    const reason =
      bestScore <= 0
        ? `No strong signal in the request; defaulting to closest match ${best?.tag ?? "none"}.`
        : `Matched ${best.tag}: ${best.description.slice(0, 120)}`;
    return {
      choiceTag: best?.tag ?? "",
      reason,
      usage: approxUsage(input.request, reason),
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const topic = extractTopic(input.prompt, input.kind);
    const build = TEMPLATES[input.kind] ?? TEMPLATES.document;
    const { title, body } = build(topic, input.prompt);
    return { title, body, usage: approxUsage(input.system + input.prompt, body) };
  }

  /**
   * Deterministic plans for the three cross-domain sequences the routing
   * model documents (ROUTING-MODEL.md "Multi-Agent Sequences"). Anything
   * else falls back to single-agent routing.
   */
  async plan(input: PlanInput): Promise<PlanResult | null> {
    const text = input.request.toLowerCase();
    const usage = approxUsage(input.request, "plan");
    const subject = extractTopic(input.request, "document");

    if (/launch|kick off/.test(text) && /campaign/.test(text)) {
      return {
        steps: [
          { agentTag: "@beacon", request: `Define the ICP and lead messaging for: ${subject}` },
          { agentTag: "@ledger", request: `What can we afford for ${subject}? Max CAC, ideal CPC/ROAS, budget recommendation.` },
          { agentTag: "@tailwind", request: `Propose the campaign structure and bid plan for ${subject} within Ledger's guardrails (recommendation only).` },
          { agentTag: "@atlas", request: `Plan supporting content for ${subject} from the calendar.` },
        ],
        reason:
          "Campaign launch is cross-domain: strategy defines the audience, economics sets the limits, ads builds inside them (gated), content supports.",
        usage,
      };
    }
    if (/profitable|afford/.test(text) && /(scale|more on).*(ads|campaign)|ads.*scale/.test(text)) {
      return {
        steps: [
          { agentTag: "@ledger", request: `Are the unit economics strong enough to scale spend? ${input.request}` },
          { agentTag: "@tailwind", request: `If Ledger's guardrails allow, propose the scaled bid/budget change set (human-gated).` },
        ],
        reason: "Economics first, then the gated spend recommendation.",
        usage,
      };
    }
    if (/partnership|partnered/.test(text) && /(closed|signed|announce)/.test(text)) {
      return {
        steps: [
          { agentTag: "@herald", request: `Draft the announcement: ${input.request}` },
          { agentTag: "@atlas", request: `Plan a supporting blog post for the partnership: ${subject}` },
          { agentTag: "@sonar", request: `Scan for community threads where this partnership is relevant: ${subject}` },
        ],
        reason: "News goes out through Herald, content amplifies, Sonar finds where it lands.",
        usage,
      };
    }
    return null;
  }

  /**
   * Deterministic scripted tool loop: recall memory, then use the subagent's
   * most characteristic tool (tracker claim → reddit/cdc scan → web fetch),
   * then produce the shaped template incorporating what the tools returned.
   * Same inputs always produce the same calls in the same order.
   */
  async runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
    const available = new Set(input.tools.map((t) => t.name));
    const toolCalls: AgenticToolEvent[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    let claimedTopic: string | null = null;
    let toolContext = "";

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await input.callTool(name, args);
      const event = { name, input: args, summary: result.summary };
      toolCalls.push(event);
      await input.onToolEvent?.(event);
      usage = {
        inputTokens: usage.inputTokens + Math.ceil(result.output.length / 4),
        outputTokens: usage.outputTokens + 20,
      };
      return result;
    };

    if (available.has("recall_memory")) {
      const memory = await call("recall_memory", { query: extractTopic(input.prompt, input.kind).split(" ")[0] });
      toolContext += `\nRecall:\n${memory.output.slice(0, 400)}`;
    }

    // Raise a hand when the request explicitly needs a human decision. Keeps the
    // escalation path deterministic offline (real Claude decides on its own).
    if (available.has("escalate") && /\bescalat|ask (mark|a human|the team)|need.*(your call|sign-?off|a human|approval to decide)/i.test(input.prompt)) {
      await call("escalate", {
        question: input.prompt.trim().slice(0, 200),
        urgency: /urgent|asap|high priority/i.test(input.prompt) ? "high" : "normal",
      });
    }

    const trackerByAgent: Record<string, string> = {
      "@atlas": "content-calendar",
      "@compass": "destination-tracker",
      "@voyager": "itinerary-calendar",
    };
    const agentTag = String(input.context?.agentTag ?? "");
    const trackerName = trackerByAgent[agentTag];

    if (available.has("advance_tracker") && trackerName) {
      await call("read_tracker", { name: "published-log" });
      const claimed = await call("advance_tracker", { name: trackerName, action: "claim_next" });
      const match = claimed.output.match(/Claimed: "([^"]+)"/);
      if (match) claimedTopic = match[1];
      toolContext += `\nTracker:\n${claimed.output.slice(0, 200)}`;
    } else if (available.has("reddit_scan")) {
      const scan = await call("reddit_scan", { subreddit: "travel", query: "" });
      toolContext += `\nScan:\n${scan.output.slice(0, 600)}`;
    } else if (available.has("cdc_scan")) {
      const scan = await call("cdc_scan", {});
      toolContext += `\nNotices:\n${scan.output.slice(0, 600)}`;
    } else if (available.has("web_fetch")) {
      const fetched = await call("web_fetch", {
        url: "https://wwwnc.cdc.gov/travel/notices",
      });
      toolContext += `\nFetched:\n${fetched.output.slice(0, 400)}`;
    }

    const topic = claimedTopic ?? extractTopic(input.prompt, input.kind);
    const build = TEMPLATES[input.kind] ?? TEMPLATES.document;
    const { title, body } = build(topic, input.prompt);
    // The mock can't see images — acknowledge them so the pipeline is verifiable
    // offline; real vision analysis happens in live mode.
    const imageNote = input.attachments?.length
      ? `\n\nReceived ${input.attachments.length} image${input.attachments.length > 1 ? "s" : ""} (${input.attachments
          .map((a) => a.name ?? "screenshot")
          .join(", ")}). I can read screenshots in live mode; on the local mock I can't analyze the pixels yet.`
      : "";
    const bodyWithTrail =
      (toolCalls.length
        ? `${body}\n\n---\n*Worked with: ${toolCalls.map((t) => t.summary).join(" · ")}*`
        : body) + imageNote;
    const generated = approxUsage(input.system + input.prompt + toolContext, bodyWithTrail);
    return {
      title,
      body: bodyWithTrail,
      usage: {
        inputTokens: usage.inputTokens + generated.inputTokens,
        outputTokens: usage.outputTokens + generated.outputTokens,
      },
      toolCalls,
    };
  }
}

const TOPIC_FALLBACKS: Record<string, string> = {
  blog_draft: "altitude sickness prevention for Cusco travelers",
  brief: "Zanzibar",
  itinerary: "7 days in Peru — Cusco and the Sacred Valley",
  press_release: "Wandr Health expands travel-medicine coverage",
  reply_draft: "r/travel typhoid + malaria prep thread",
  ads_recommendation: "Travel Consult — Search campaign",
};

function extractTopic(prompt: string, kind: string): string {
  let cleaned = prompt
    .replace(/^\s*(helm|@[a-z.]+)[,:]?\s+/i, "")
    .replace(/^[^:]*:\s*/, "")
    .replace(/[.?!].*$/s, "")
    .trim();
  // Strip instruction-style lead-ins so titles read like topics, not orders.
  const instruction =
    /^(please\s+)?(write|draft|run|create|make|generate|produce|review|check|scan|refresh|adjust|advance|pull|who|what|when|where|how|can|could|should|would|do|does|is|are)\b/i;
  if (instruction.test(cleaned)) {
    const aboutMatch = cleaned.match(/\b(?:on|about|for|covering)\s+(.{6,80})/i);
    if (aboutMatch) {
      cleaned = aboutMatch[1];
    } else {
      return TOPIC_FALLBACKS[kind] ?? "travel health prep";
    }
  }
  const words = cleaned.split(/\s+/).slice(0, 9).join(" ");
  return words.length > 4 ? words : (TOPIC_FALLBACKS[kind] ?? "travel health");
}

type Template = (topic: string, prompt: string) => { title: string; body: string };

const TEMPLATES: Record<string, Template> = {
  lead_digest: (topic) => ({
    title: `Lead scan — ${new Date().toISOString().slice(0, 10)}`,
    body: `## Ranked leads (last 6 hours)

1. **r/travel — "Typhoid + malaria prep for 3 weeks in ${topic.includes("travel") ? "Tanzania" : topic}?"**
   Fresh thread, 14 comments, OP undecided. Asking exactly what a travel-health consult answers.
   Why it qualifies: genuine pre-trip medication question, no clinician in thread yet.
   Link: reddit.com/r/travel/comments/mock1

2. **r/solotravel — "Altitude meds for Cusco — do I really need them?"**
   2 hours old, rising. Multiple wrong answers being upvoted.
   Why it qualifies: altitude prophylaxis is a core Wandr pillar; correction adds real value.
   Link: reddit.com/r/solotravel/comments/mock2

3. **Tripadvisor forum — "Passport Health quoted $280 for a consult, alternatives?"**
   Competitor-comparison thread, active today.
   Why it qualifies: direct competitor chatter, price-sensitive traveler.
   Link: tripadvisor.com/ShowTopic-mock3

Quality over quantity: 3 strong leads kept, 11 stale threads dropped.
Handing the top thread to @sonar.reply for a draft.`,
  }),
  reply_draft: (topic) => ({
    title: `Reply draft — ${topic}`,
    body: `For the r/travel thread on typhoid + malaria prep:

> For a 3-week trip like that, the usual checklist is: typhoid (oral Vivotif needs to be
> finished ~1 week before departure, the injectable works to ~2 weeks out), malaria
> prophylaxis depending on region (atovaquone-proguanil is the most common for short
> trips because you only continue it 7 days after leaving), and making sure routine
> vaccines are current. Rabies pre-exposure is worth discussing if you'll be remote or
> around animals. A travel-medicine consult 4–6 weeks before departure is the safest
> way to get region-specific guidance — bring your itinerary.

Notes for the human sender:
- Zero promotion: no mention of Wandr, the domain, or any product (account-ban risk).
- Clinically conservative: no dosing specifics beyond standard public guidance.
- Posts as a knowledgeable traveler, not a brand.

A human posts this. It is never auto-posted.`,
  }),
  news_digest: () => ({
    title: `Travel-health news scan — ${new Date().toISOString().slice(0, 10)}`,
    body: `## Ranked content opportunities

1. **CDC: dengue advisory expanded for the Caribbean** — relevance: high.
   Pillar: mosquito-borne illness. Timely angle: winter-break planning starts now.
2. **WHO: cholera cluster update, East Africa** — relevance: medium.
   Pillar: food & water safety. Angle: refresh the safari prep guide.
3. **State Dept: level-2 advisory revision, Peru** — relevance: medium.
   Pillar: altitude + itinerary safety. Angle: Cusco/Machu Picchu pages.

Research only — no files modified, no trackers touched. Sources cited inline.`,
  }),
  blog_draft: (topic) => ({
    title: `Draft: ${capitalize(topic)} — what travelers actually need to know`,
    body: `---
title: "${capitalize(topic)} — what travelers actually need to know"
status: draft
pillar: trip-prep
---

**Answer capsule (78 words).** ${capitalize(topic)} planning comes down to timing:
see a travel-medicine clinician 4–6 weeks before departure, confirm routine vaccines,
and match prophylaxis to your exact route. Regional risk varies more than most
travelers expect, and several vaccines need lead time to take effect. The checklist
below covers the evidence-based essentials, with citations to CDC and WHO guidance
throughout.

## The 4–6 week rule
…draft body continues with two cited sources and three statistics per the GEO
checklist (Princeton method)…

## FAQ
**Do I need this for a short trip?** Risk is exposure-based, not duration-based…

> Medical-sensitive: this draft is gated for human clinical review before publish.`,
  }),
  brief: (topic) => ({
    title: `Destination brief: ${capitalize(topic)}`,
    body: `# ${capitalize(topic)} — travel-medicine brief

**Route:** /travel-medicine/${slugify(topic)}
**Pricing:** $89 consult / $129 family

## Health snapshot
- Required + recommended vaccinations with timing windows
- Malaria map by region, seasonal variation noted
- Food & water risk tier, altitude considerations where relevant

## The 11-medication catalog check
Only catalog medications referenced. Azithromycin 500mg ×3 for traveler's diarrhea
(never "Z-Pak").

> Medical-sensitive: gated for human clinical review. Tracker row queued atomically.`,
  }),
  itinerary: (topic) => ({
    title: `Itinerary draft: ${capitalize(topic)}`,
    body: `---
destination: ${capitalize(topic)}
days: 7
cta_variant: consult
health_prep_timeline:
  - "T-6 weeks: travel consult"
  - "T-4 weeks: vaccines complete"
  - "T-1 week: prophylaxis start (route-dependent)"
---

## Day 1 — arrival + acclimatization
Light schedule on purpose: altitude pacing per @voyager.health guidance…

## Day 2 — …

(Full render contract: frontmatter, days[], rails, unique deduped hero image.)

> Medical-sensitive: gated for human review before the calendar row advances.`,
  }),
  press_release: (topic) => ({
    title: `Press release: ${capitalize(topic)}`,
    body: `FOR REVIEW — NOT RELEASED

**${capitalize(topic)}**

NEW YORK — Wandr Health today announced… (dateline + NewsArticle JSON-LD on publish).

"Quote from founder goes here, verified verbatim," said the founder.

*About Wandr Health* — boilerplate auto-appended.

> PR-sensitive: gated for human review. Anti-duplicate slug check passed.`,
  }),
  ads_recommendation: (topic) => ({
    title: `Ads recommendation: ${capitalize(topic)}`,
    body: `## Recommendation (no spend executed)

- Campaign: Travel Consult — Search
- Observation: CPC trending 12% above Ledger's ideal-CPC guardrail
- Proposal: shift $18/day from broad-match "travel shots" ad group to exact-match
  "travel medicine consult"; add 7 negatives (wasted-spend terms attached)
- Projected: CAC −9% against the max-CAC guardrail

**Execution requires human approval. This recommendation changes no live campaign.**`,
  }),
  analytics_report: () => ({
    title: `Weekly growth dashboard — GA4`,
    body: `## Week in numbers (GA4 property 462397403)

| Metric | This week | Δ |
|---|---|---|
| Sessions | 4,182 | +6.4% |
| Consult starts | 96 | +11% |
| Blended CAC | $42.10 | −3% |

Low-confidence flag: ~100-customer revenue sample — directional, not definitive.
Free pre-trip health check excluded from revenue per standing rule.`,
  }),
  icp_profile: () => ({
    title: `ICP refresh — signals-based`,
    body: `## Primary ICP: the prepared first-timer
30–45, planning a 1–3 week trip to a destination with real health prep (altitude,
malaria zone, or multi-vaccine), researches 4–8 weeks out, price-compares against
in-person clinics. Signals: search terms, r/travel threads, consult-form geography.

## Secondary: the family organizer
Books for 3+ travelers; values one consolidated consult.`,
  }),
  messaging: () => ({
    title: `Messaging house — vs Passport Health / Runway / TravelMeds2Go`,
    body: `**Lead benefit:** "Trip-specific medical prep, without the clinic visit."
Physician-founded is *support*, never the lead. Benefit-first per Beacon's rules.

| vs | Their lead | Our wedge |
|---|---|---|
| Passport Health | in-person network | price + convenience, same clinical rigor |
| Runway | meds fast | depth: full trip prep, not just scripts |
| TravelMeds2Go | price | clinician consult + itinerary-aware guidance |`,
  }),
  document: (topic, prompt) => ({
    title: capitalize(topic),
    body: `## ${capitalize(topic)}

${prompt.trim()}

Result prepared by the assigned subagent with standing guardrails applied.`,
  }),
  // A direct coordinator reply — reads like a chat answer, not a document.
  answer: (topic, prompt) => ({
    title: `Re: ${capitalize(topic)}`,
    body: `Here's where things stand on "${prompt.trim().slice(0, 120)}":

Right now the org is just me (Tethr) — I answer directly and draft plans; the specialist agents get re-added one at a time. For "${topic}", I can give you the coordinator's read now, or draft a full plan to the Drive if you want something you can act on. Say the word.`,
  }),
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
