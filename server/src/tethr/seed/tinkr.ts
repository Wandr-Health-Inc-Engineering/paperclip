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

// Tinkr — the org mechanic (Mark's spec, 2026-07-13). Modifies existing agents
// (rename, mission/budget/subagent/status/schedule) with two hard properties:
// every change waits for a human approval in the Queue, and every applied
// change lands in a revertible log (git-revert style). Reached ONLY through
// @tethr routing — there is no Tinkr Slack bot; @tinkr is an internal org tag.
//
// Additive + idempotent, like seed/ceo.ts: fills into the live org on boot.

export const TINKR_AGENT = {
  tag: "@tinkr",
  codename: "Tinkr",
  title: "Org Mechanic — modifies agents, with your approval",
  mission:
    "Change the organization safely: rename agents, update missions and budgets, tune subagent specs, pause/resume, and adjust schedules. Stage exactly what was asked, never apply anything without a human approval, and keep every change in the revertible log.",
  budgetMonthlyCents: 1000, // $10/mo, hard-stop on — staging changes is cheap
};

const TINKR_ROUTING_ROW = {
  when: [
    "rename",
    "change agent",
    "update agent",
    "modify",
    "adjust budget",
    "pause agent",
    "resume agent",
    "reschedule",
    "change schedule",
  ],
  to: "@tinkr",
  description:
    "Agent modifications — rename, mission/title, budget, subagent specs, pause/resume, schedules. Every change is staged for human approval and logged revertibly.",
};

const TINKR_SUBAGENT = {
  key: "change",
  name: "Change",
  job: "Turn a plain-language request into exactly one staged org change (via stage_org_change) that waits for human approval.",
  routeWhen: ["rename", "update", "modify", "budget", "pause", "resume", "schedule"],
  notHere: [
    { phrase: "create a brand-new agent", to: "@ceo" },
    { phrase: "just a question about an agent", to: "@tethr.chat" },
  ],
  reads: ["The org (agents, subagents, budgets, schedules)", "memory"],
  steps: [
    "Identify the target agent (and subagent, if any) from the request",
    "Stage the change with stage_org_change — exactly what was asked, nothing more",
    "If the tool refuses (protected agent, over-budget, no such target), relay the reason plainly",
    "Confirm to the requester that the change is staged and waits for approval in the Queue",
  ],
  output: "One staged org change awaiting human approval — never an applied one.",
  guardrails: [
    "Stage exactly what was asked; never invent or bundle extra changes",
    "Nothing applies without a human approval — say so in every confirmation",
    "@tethr, @ceo, and @tinkr are protected: never rename or pause them",
    "If the ask is ambiguous, say what you would change and ask — don't guess",
  ],
  doneWhen: "The change is staged and the requester knows it awaits approval (or why it can't be staged).",
  escalation: "Ambiguity about intent → ask in the thread; policy questions → @tethr routes to a human.",
  sensitivity: "org" as const,
};

export interface TinkrSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure Tinkr exists, reporting to the CEO, routed from @tethr. */
export async function seedTinkrAgent(db: Db, companyId: string): Promise<TinkrSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, TINKR_AGENT.tag)),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding Tinkr (@tinkr), the org mechanic");

  // System/admin agents sit BESIDE the org under @tethr (the conductor/system
  // hub) — not inside the CEO's command chain. @ceo branches down to the org
  // roles; @tinkr/@patch/@filer are infrastructure that complements it.
  const [parent] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
    .limit(1);

  const [tinkr] = await db
    .insert(agents)
    .values({
      companyId,
      name: TINKR_AGENT.codename,
      role: "general",
      title: TINKR_AGENT.title,
      icon: "wrench",
      status: "idle",
      reportsTo: parent?.agentId ?? null,
      capabilities: TINKR_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: TINKR_AGENT.tag, subagentChain: ["change"] },
      budgetMonthlyCents: TINKR_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: tinkr.id,
    divisionId: null,
    tag: TINKR_AGENT.tag,
    codename: TINKR_AGENT.codename,
    mission: TINKR_AGENT.mission,
    approvalGate: "none", // its outputs carry the `org` sensitivity — always gated
    heartbeatNote: "On request — no schedule; the mechanic works when asked.",
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: tinkr.id,
    key: TINKR_SUBAGENT.key,
    tag: `${TINKR_AGENT.tag}.${TINKR_SUBAGENT.key}`,
    name: TINKR_SUBAGENT.name,
    job: TINKR_SUBAGENT.job,
    routeWhen: TINKR_SUBAGENT.routeWhen,
    notHere: TINKR_SUBAGENT.notHere,
    reads: TINKR_SUBAGENT.reads,
    steps: TINKR_SUBAGENT.steps,
    output: TINKR_SUBAGENT.output,
    guardrails: TINKR_SUBAGENT.guardrails,
    doneWhen: TINKR_SUBAGENT.doneWhen,
    escalation: TINKR_SUBAGENT.escalation,
    sensitivity: TINKR_SUBAGENT.sensitivity,
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: tinkr.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: TINKR_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  await addTethrRoutingRow(db, companyId, TINKR_ROUTING_ROW);

  logger.info({ companyId, agentId: tinkr.id }, "[tethr] Tinkr seeded (on-request, no heartbeat)");
  return { created: true, agentId: tinkr.id };
}
