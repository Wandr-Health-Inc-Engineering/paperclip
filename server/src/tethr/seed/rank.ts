import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  budgetPolicies,
  tethrAgentProfiles,
  tethrSubagents,
} from "@paperclipai/db";
import { TETHR_ADAPTER_TYPE } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { addTethrRoutingRow } from "../factory.js";
import { CORE_STANDING_RULES } from "./tethr-core.js";

// Rank — Wandr Health's SEO / search-demand strategist. An ORG ROLE (reports to
// @ceo, beside @radar/@remedy/@tank), grounded in Wandr's real operating method:
// a pillar-cluster topical-authority model, the Princeton GEO methods, real
// search volume (keyword_ideas), a hard catalog-fit gate (only topics that route
// to something Wandr can actually prescribe), and the first-person clinical
// provider voice. Output = a GEO-ready keyword brief filed to 02 Documents (the
// "keywords" subagent key → document kind) that the content flow can execute.
// Reached through @tethr routing; no Slack bot, no heartbeat yet.

export const RANK_AGENT = {
  tag: "@rank",
  codename: "Rank",
  title: "SEO & search-demand strategist - real volume, GEO-ready briefs",
  mission:
    "Grow Wandr Health's organic and AI-search visibility by finding the travel-health demand we can own and turning it into physician-authored, CDC/WHO-cited, GEO-ready content briefs in a pillar-cluster architecture. Ground every number in real search volume, gate every topic to Wandr's real prescription catalog, write in our first-person clinical-provider voice, point the reader to a Wandr conversion, and never repeat work we've already published.",
  budgetMonthlyCents: 1500, // $15/mo, hard-stop on
};

const RANK_ROUTING_ROW = {
  when: ["keyword", "keywords", "search volume", "seo", "rank for", "search demand", "content brief"],
  to: "@rank",
  description:
    "SEO and search demand - keyword research with real Google volume, clustered by intent and turned into GEO-ready content briefs.",
};

const RANK_SUBAGENT = {
  // key "keywords" is load-bearing: KIND_BY_SUBAGENT_KEY maps it to the
  // "document" kind, so the brief files to 02 Documents.
  key: "keywords",
  name: "Keywords",
  job: "Turn a topic, page, or destination into a prioritized, GEO-ready keyword brief grounded in real search volume - clustered by intent, mapped to a Wandr pillar and page type, gated to what Wandr can actually prescribe.",
  routeWhen: [
    "keyword",
    "keywords",
    "search volume",
    "seo",
    "rank for",
    "search demand",
    "what should we write about",
    "content brief",
    "topic research",
  ],
  notHere: [
    { phrase: "AI / LLM visibility, get cited by ChatGPT / Perplexity (GEO)", to: "@tank" },
    { phrase: "write the actual blog post or content", to: "@tethr" },
    { phrase: "just a general question", to: "@tethr.chat" },
  ],
  reads: [
    "The internal Drive (drive_list/drive_read) - /documents and /content/blog for existing coverage",
    "keyword_ideas (real Google search volume)",
    "web_fetch (competitor pages / SERPs, read-only)",
  ],
  steps: [
    "Catalog-fit gate FIRST: only pursue topics that route to something Wandr actually treats or sells - antimalarials (e.g. Malarone), traveler's-diarrhea antibiotics (Azithromycin/Cipro), Acetazolamide for altitude, Scopolamine/Meclizine/Ondansetron for motion & nausea, plus vaccines and insurance. If clicking the CTA wouldn't land the reader on a real Wandr offering, drop the topic no matter the search volume. Verify against the current catalog; never invent an offering (Doxycycline/Mefloquine are comparison-only, not offered).",
    "Check existing coverage: drive_list /documents and /content/blog and read anything relevant, so you never re-pitch a keyword we already own; note internal-link targets using only verified Wandr URLs (never guess a path).",
    "Pull real volume with keyword_ideas on 5-15 seed phrases; classify each by intent and funnel stage - transactional 'how to get [X] online' and commercial comparison / 'do I need [X] for [country]' are highest-value; top-of-funnel is lowest.",
    "Cluster by intent (symptom, destination, medication, comparison, logistics) and score each cluster by opportunity = demand x low difficulty x relevance to a Wandr product/margin; hunt the white space we can own ('how to get [med] online', 'travel clinic vs online', physician-authored authority).",
    "Map each cluster to one of the 5 pillars (malaria & antimalarials, traveler's diarrhea & GI, destination health guides, travel vaccines, planning & checklists) and the right page type (blog / destination / medication / vaccine), with hub-and-spoke internal links up to the pillar and down to the product.",
    "For each cluster give: real volume, competition, CPC, intent, recommended page type, coverage status (ALREADY COVERED / GAP / STRETCH), the competitor who currently owns it (Runway / Passport / TravelMeds2Go / CDC) and the physician angle Wandr adds.",
    "Attach a GEO-ready brief spec per priority cluster: an answer-capsule requirement (a 75-150 word self-contained answer with a stat + our physician-authority signal), >=3 CDC/WHO citations and >=5 specific stats, an FAQ / People-Also-Ask set, the schema to use, and a benefit-first CTA to a Wandr conversion.",
    "Add a per-engine note where it matters: ChatGPT favors fresh (<30-day) branded content; Perplexity favors FAQ schema + Reddit corroboration; Google AI Overviews track top-10 organic (so classic SEO + GEO together); Claude uses Brave + high factual density.",
  ],
  output:
    "A GEO-ready keyword brief: clusters ranked by opportunity, each with real volume/competition/CPC, intent, recommended page type, coverage status, competitor-gap + physician angle, and a content spec (answer capsule, citations, FAQ, schema, benefit-first CTA) - filed to 02 Documents for the content flow.",
  guardrails: [
    "Never invent or estimate search volume - every number comes from keyword_ideas. If it returns nothing, say so plainly.",
    "If keyword_ideas reports it needs a Basic/Standard developer token, state that clearly at the top of your output.",
    "Catalog-fit is non-negotiable: skip any topic that can't route to a real Wandr offering, regardless of search volume.",
    "Voice is first-person clinical provider ('we', 'our clinical team') - recommend content that speaks AS Wandr the provider, and never advises the reader to 'see a doctor' or go elsewhere.",
    "Marketing and structure only - never make or approve medical claims. Require every clinical claim in a brief to cite a primary source (CDC/WHO/StatPearls/FDA) and be physician-reviewable; flag anything needing a licensed clinician's sign-off instead of writing it.",
    "Never guess a URL (internal links use only verified Wandr paths), and never fabricate credentials, bios, or data.",
  ],
  doneWhen:
    "A GEO-ready keyword brief exists with clusters ranked by opportunity, every keyword catalog-fit-checked and marked covered/gap/stretch, all volumes sourced from keyword_ideas, and a content spec the writer flow can execute.",
  escalation:
    "Ambiguity about the topic, target page, or whether something is in-catalog → ask in the thread; anything needing clinical sign-off → flag for a human and don't write it.",
  sensitivity: "internal" as const,
  tools: ["keyword_ideas", "web_fetch"],
};

export interface RankSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure Rank exists, reporting to the CEO, routed from @tethr. */
export async function seedRankAgent(db: Db, companyId: string): Promise<RankSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, RANK_AGENT.tag)),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding Rank (@rank), the SEO / search-demand strategist");

  // Rank is an ORG ROLE — it reports up to the CEO, alongside @radar/@remedy/@tank.
  const [ceo] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);

  const [rank] = await db
    .insert(agents)
    .values({
      companyId,
      name: RANK_AGENT.codename,
      role: "general",
      title: RANK_AGENT.title,
      icon: "search",
      status: "idle",
      reportsTo: ceo?.agentId ?? null,
      capabilities: RANK_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: RANK_AGENT.tag, subagentChain: ["keywords"] },
      budgetMonthlyCents: RANK_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: rank.id,
    divisionId: null,
    tag: RANK_AGENT.tag,
    codename: RANK_AGENT.codename,
    mission: RANK_AGENT.mission,
    approvalGate: "internal",
    heartbeatNote: "On request — no schedule yet (turn a daily cadence on when ready).",
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: rank.id,
    key: RANK_SUBAGENT.key,
    tag: `${RANK_AGENT.tag}.${RANK_SUBAGENT.key}`,
    name: RANK_SUBAGENT.name,
    job: RANK_SUBAGENT.job,
    routeWhen: RANK_SUBAGENT.routeWhen,
    notHere: RANK_SUBAGENT.notHere,
    reads: RANK_SUBAGENT.reads,
    steps: RANK_SUBAGENT.steps,
    output: RANK_SUBAGENT.output,
    guardrails: RANK_SUBAGENT.guardrails,
    doneWhen: RANK_SUBAGENT.doneWhen,
    escalation: RANK_SUBAGENT.escalation,
    sensitivity: RANK_SUBAGENT.sensitivity,
    tools: RANK_SUBAGENT.tools,
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: rank.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: RANK_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  await addTethrRoutingRow(db, companyId, RANK_ROUTING_ROW);

  logger.info({ companyId, agentId: rank.id }, "[tethr] Rank seeded (on-request, no heartbeat)");
  return { created: true, agentId: rank.id };
}
