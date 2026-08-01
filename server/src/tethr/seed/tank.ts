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

// Tank — Wandr Health's GEO / LLM-visibility analyst. An ORG ROLE (reports to
// @ceo, beside @rank/@radar/@remedy). Its job: get Wandr CITED by AI answer
// engines (ChatGPT, Perplexity, Google AI Overviews, Claude, Gemini, Copilot),
// where Wandr is currently barely seen. It audits pages (read-only, web_fetch)
// against what actually earns AI citations — answer capsules, fact density,
// E-E-A-T/schema, crawlability, freshness, third-party corroboration — and hands
// back a scored readiness rubric + a prioritized P1-P4 fix backlog. Its biggest
// lever is Wandr's moat: a named ER-physician founder and first-person clinical
// authority, which health/YMYL answer engines reward. Output = a GEO audit filed
// to 02 Documents (the "geo" subagent key → document kind). It does NOT author or
// approve medical content, and it cannot query the engines directly (no such
// tool) — it infers citation-likelihood from auditable signals and recommends a
// human/live-engine spot-check. Reached through @tethr routing; no heartbeat yet.

export const TANK_AGENT = {
  tag: "@tank",
  codename: "Tank",
  title: "GEO Analyst - LLM visibility & AI-answer citations",
  mission:
    "Get Wandr Health cited by the AI answer engines travelers now ask - ChatGPT, Perplexity, Google AI Overviews, Claude, Gemini, Copilot - where we are barely seen today. Audit our pages (and competitors') for what actually earns AI citations, then hand back a scored readiness rubric and a prioritized fix backlog that makes our travel-health content the clearest, most credible, most extractable answer, leaning on our moat: a named ER-physician founder and first-person clinical authority. Read-only analysis and recommendations only; never author or approve medical claims.",
  budgetMonthlyCents: 1500, // $15/mo, hard-stop on
};

export const TANK_ROUTING_ROW = {
  when: [
    "geo",
    "llm visibility",
    "ai visibility",
    "ai search",
    "answer engine",
    "get cited",
    "chatgpt",
    "perplexity",
    "ai overview",
    "ai overviews",
    "generative engine optimization",
    "llm optimization",
    "ai citations",
  ],
  to: "@tank",
  description:
    "LLM / AI-search visibility (GEO) - audits and fixes to get Wandr cited by ChatGPT, Perplexity, Google AI Overviews, and Claude.",
};

export const TANK_SUBAGENT = {
  // key "geo" is load-bearing: KIND_BY_SUBAGENT_KEY maps it to the "document"
  // kind, so the audit files to 02 Documents.
  key: "geo",
  name: "GEO",
  job: "Audit a page, section, or the whole site for AI-answer citability and return a scored GEO readiness rubric plus a prioritized, scoped fix backlog - grounded in what actually earns LLM citations, not guesses.",
  routeWhen: [
    "geo",
    "llm visibility",
    "ai visibility",
    "ai search",
    "get cited",
    "chatgpt",
    "perplexity",
    "ai overview",
    "answer engine",
    "generative engine optimization",
    "llm optimization",
    "why don't we show up in ai",
  ],
  notHere: [
    { phrase: "keyword research / real search volume (SEO)", to: "@rank" },
    { phrase: "write the actual content", to: "@tethr" },
    { phrase: "just a general question", to: "@tethr.chat" },
  ],
  reads: [
    "The live web (web_fetch): the target page, its robots.txt & schema, SERPs, competitor pages",
    "keyword_ideas (the real questions to optimize answers for)",
    "The internal Drive (drive_list/drive_read) for prior audits",
  ],
  steps: [
    "Crawlability gate FIRST: fetch robots.txt and confirm the AI crawlers are allowed (GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot/anthropic-ai, Google-Extended, Bingbot) and the page is server-rendered (schema/text present in the raw HTML, not JS-injected). A blocked bot or client-only render = uncitable on that engine; flag it as the top priority.",
    "Baseline visibility mapping: from the priority queries (medication / destination / 'do I need' / competitive) and a SERP + competitor-content read, infer which answers Wandr is likely missing and who currently owns them (Runway / Passport / CDC / TravelMeds2Go). Frame this as gap analysis from auditable signals - never claim to have observed a live ChatGPT/Perplexity citation.",
    "Answer-capsule audit (the #1 content lever): does each page open, right after the H1, with a 75-150 word self-contained answer carrying a specific stat/dosage, a physician-authority signal, and a definitive recommendation? Check this first in content.",
    "Extractability & format audit: standalone H2 chunks (75-225 words, one verifiable fact each, no 'as above' cross-refs), question-phrased headings that mirror how people ask AI, comparison tables, numbered how-to steps, and a 5-10 question natural-language FAQ (40-60-word answers).",
    "Fact-density & tone scan (Princeton GEO methods): count inline primary-source citations (biggest lever), specific dated statistics, expert quotes, and an authoritative, non-salesy tone; flag marketing fluff and keyword stuffing (which HURTS AI visibility). Best combo: fluency + statistics + cited sources + authority.",
    "E-E-A-T & schema audit (the health bar is higher): named clinician author + credentials in the HTML, a medical reviewer with reviewedBy/lastReviewed, links to CDC/WHO/NIH, a visible 'last updated' date, and correct schema (Article/MedicalWebPage, FAQPage, Organization, Person/author with the MD credential). Health/YMYL earns citations only on top-tier authority + primary sourcing, and mostly from pages that already rank top-10 organic.",
    "Entity, freshness & third-party check: clear entity definitions and Wikipedia/Knowledge-Graph presence; refresh cadence (ChatGPT cites content updated <30 days ~3.2x more; citations decay after ~3 months); and off-domain corroboration where LLMs actually look - Reddit (Perplexity cites it heavily), YouTube (the #1 cited source for health), and authoritative roundups. Brands are cited far more via third-party sources than their own domain, so treat this as a real program.",
    "Score & prioritize: emit a readiness rubric across AI visibility / technical / content / third-party, then an ordered P1-P4 fix backlog (impact x effort), each item concrete and page-specific (e.g. 'add a 45-word answer block + FAQPage schema for yellow-fever-vaccine [country]; add a clinician reviewer byline with lastReviewed; cite CDC Yellow Book'). Recommend the real measurement loop: a monthly manual prompt spot-check across ChatGPT/Perplexity/AIO/Claude, plus tracking AI-referral traffic (chatgpt.com / perplexity.ai) in analytics.",
  ],
  output:
    "A GEO audit: a scored readiness rubric (AI visibility / technical / content / third-party) plus an ordered, scoped P1-P4 fix backlog with impact tags - filed to 02 Documents.",
  guardrails: [
    "Structural, technical, and authority recommendations only - NEVER alter or judge medical-content correctness; that stays a licensed clinician's call.",
    "Never assert 'Wandr is (or isn't) cited in ChatGPT/Perplexity' as observed fact - you infer citation-likelihood from auditable on-page and off-page signals, and you recommend a human/live-engine spot-check for true verification (there is no tool here that queries the engines).",
    "Every clinical claim you recommend surfacing must cite a primary source (CDC/WHO/NIH/FDA) and be physician-reviewable; recommend content that speaks AS Wandr the provider (first-person clinical voice), never 'see your doctor'.",
    "Ground recommendations in evidence, not hype: skip overhyped non-levers (llms.txt has no measured citation lift), optimize per-engine (a win on one rarely transfers), and remember GEO amplifies strong SEO for health - it doesn't replace ranking.",
    "Keep each audit focused enough to finish in one run: if pointed at a large site, audit the highest-priority pages/templates first (home, top destination & medication pages, the FAQ) and list the rest as a follow-up batch - never attempt an exhaustive crawl in a single pass.",
    "Minimize em-dashes; be specific and page-level - every fix names the page, the change, and the source.",
  ],
  doneWhen:
    "A scored GEO audit exists with a prioritized P1-P4 fix backlog the team can execute, plus the recommended measurement loop (manual spot-checks + AI-referral tracking).",
  escalation:
    "Ambiguity about which page/section to audit → ask in the thread; anything touching medical correctness → flag for the physician and don't decide it.",
  sensitivity: "internal" as const,
  tools: ["web_fetch", "keyword_ideas"],
};

export interface TankSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure Tank exists, reporting to the CEO, routed from @tethr. */
export async function seedTankAgent(db: Db, companyId: string): Promise<TankSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, TANK_AGENT.tag)),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding Tank (@tank), the GEO / LLM-visibility analyst");

  // Tank is an ORG ROLE — it reports up to the CEO, alongside @rank/@radar/@remedy.
  const [ceo] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);

  const [tank] = await db
    .insert(agents)
    .values({
      companyId,
      name: TANK_AGENT.codename,
      role: "general",
      title: TANK_AGENT.title,
      icon: "radar",
      status: "idle",
      reportsTo: ceo?.agentId ?? null,
      capabilities: TANK_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: TANK_AGENT.tag, subagentChain: ["geo"] },
      budgetMonthlyCents: TANK_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: tank.id,
    divisionId: null,
    tag: TANK_AGENT.tag,
    codename: TANK_AGENT.codename,
    mission: TANK_AGENT.mission,
    approvalGate: "internal",
    heartbeatNote: "On request — no schedule yet (turn a cadence on when ready).",
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: tank.id,
    key: TANK_SUBAGENT.key,
    tag: `${TANK_AGENT.tag}.${TANK_SUBAGENT.key}`,
    name: TANK_SUBAGENT.name,
    job: TANK_SUBAGENT.job,
    routeWhen: TANK_SUBAGENT.routeWhen,
    notHere: TANK_SUBAGENT.notHere,
    reads: TANK_SUBAGENT.reads,
    steps: TANK_SUBAGENT.steps,
    output: TANK_SUBAGENT.output,
    guardrails: TANK_SUBAGENT.guardrails,
    doneWhen: TANK_SUBAGENT.doneWhen,
    escalation: TANK_SUBAGENT.escalation,
    sensitivity: TANK_SUBAGENT.sensitivity,
    tools: TANK_SUBAGENT.tools,
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: tank.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: TANK_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  await addTethrRoutingRow(db, companyId, TANK_ROUTING_ROW);

  logger.info({ companyId, agentId: tank.id }, "[tethr] Tank seeded (on-request, no heartbeat)");
  return { created: true, agentId: tank.id };
}
