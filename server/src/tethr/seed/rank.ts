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

// Rank — the SEO / search-demand analyst. An ORG ROLE (reports to @ceo, beside
// @radar/@remedy), not a system agent. Given a topic or page, it turns it into a
// prioritized keyword set grounded in REAL search volume (keyword_ideas), never
// recommending something we already cover. Output files to 02 Documents (the
// "keywords" subagent key → document kind) — a keyword brief the writer flow can
// read as fuel. Reached through @tethr routing; no Slack bot, no heartbeat yet.
//
// Additive + idempotent, like seed/filer.ts: fills into the live org on boot.

export const RANK_AGENT = {
  tag: "@rank",
  codename: "Rank",
  title: "SEO Analyst - keyword research with real search volume",
  mission:
    "Find the search demand we should own in travel health, ground every recommendation in real volume data, and never repeat work we've already published.",
  budgetMonthlyCents: 1500, // $15/mo, hard-stop on
};

const RANK_ROUTING_ROW = {
  when: ["keyword", "keywords", "search volume", "seo", "rank for", "search demand"],
  to: "@rank",
  description:
    "SEO and search demand - keyword research with real Google volume, clustered by intent.",
};

const RANK_SUBAGENT = {
  // key "keywords" is load-bearing: KIND_BY_SUBAGENT_KEY maps it to the
  // "document" kind, so the brief files to 02 Documents.
  key: "keywords",
  name: "Keywords",
  job: "Turn a topic or page into a prioritized keyword set with real search volume.",
  routeWhen: [
    "keyword",
    "keywords",
    "search volume",
    "seo",
    "rank for",
    "search demand",
    "what should we write about",
  ],
  notHere: [
    { phrase: "write the actual blog post or content", to: "@tethr" },
    { phrase: "just a general question", to: "@tethr.chat" },
  ],
  reads: [
    "The internal Drive (drive_list/drive_read) — /documents and /content/blog",
    "keyword_ideas (real Google search volume)",
    "web_fetch (read-only)",
  ],
  steps: [
    "Check what we already cover: drive_list \"/documents\" and \"/content/blog\", drive_read anything relevant, so you never recommend a keyword we already own.",
    "Run keyword_ideas on 5-15 seed phrases derived from the request.",
    "Group results into clusters by search intent: symptom, destination, medication, comparison, logistics.",
    "For each cluster give volume, competition, CPC, the intent, and the page type that should target it.",
    "Mark every keyword as ALREADY COVERED / GAP / STRETCH.",
  ],
  output:
    "A keyword brief: clusters ranked by opportunity, each with volume, competition, CPC, intent, recommended page type, and coverage status.",
  guardrails: [
    "Never invent or estimate search volume - every number comes from keyword_ideas. If the tool returns nothing, say so plainly.",
    "If keyword_ideas reports it needs a Basic/Standard developer token, state that clearly at the top of your output.",
    "Marketing and structure only - never make medical claims or clinical recommendations.",
    "Flag any keyword whose content would need a licensed clinician's sign-off, and say so instead of writing that content.",
  ],
  doneWhen:
    "A keyword brief exists in the Drive with clusters ranked by opportunity and every keyword marked covered/gap/stretch, all volumes sourced from keyword_ideas.",
  escalation:
    "Ambiguity about the topic or target page → ask in the thread; anything that would need clinical sign-off → flag for a human instead of writing it.",
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

  logger.info({ companyId }, "[tethr] seeding Rank (@rank), the SEO / search-demand analyst");

  // Rank is an ORG ROLE — it reports up to the CEO, alongside @radar/@remedy.
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
