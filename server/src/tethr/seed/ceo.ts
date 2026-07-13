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
import { routineService } from "../../services/routines.js";
import { CORE_STANDING_RULES } from "./tethr-core.js";

// The AI CEO — head of the agent organization (Mark's call, 2026-07-12).
//
// Org shape: @tethr is the CONDUCTOR (Jarvis) — the interface between the human
// team and the agents, reporting to no one. The CEO is a SEPARATE root: it holds
// the mission, sets priorities, and the specialists (Journal the blog writer,
// etc.) report up to IT. So there are two reportsTo:null roots — @tethr off to
// the side as the hub, and @ceo at the top of the agent org.
//
// This seed is additive + idempotent: it fills the CEO into the existing live
// org on boot (seedTethrCore is idempotent and won't, hence this runs after it).
// Heartbeat is seeded PAUSED — enabling any heartbeat is Mark's explicit gate.

export const CEO_AGENT = {
  tag: "@ceo",
  codename: "CEO",
  title: "Chief Executive — heads the agent organization",
  mission:
    "Hold Wandr's marketing & distribution mission and set the organization's priorities. Review what the agents produce, decide what to focus on next, and delegate to specialists. Never publish or spend past the human approval and budget gates.",
  budgetMonthlyCents: 2500, // $25/mo, hard-stop on
  heartbeatCron: "0 8 * * *", // 8:00 AM ET — a morning priorities brief (seeded paused)
  heartbeatNote: "Daily 8:00 AM — sets the day's priorities (seeded paused until enabled)",
  heartbeatRequest:
    "Set today's priorities: review the mission, recent work in the Drive, and what's queued, then write a short priorities brief.",
};

// When @tethr is asked about strategy/direction, it routes to the CEO.
const CEO_ROUTING_ROW = {
  when: ["strategy", "priorities", "goals", "roadmap", "direction", "what should we focus on"],
  to: "@ceo",
  description: "Strategy, priorities, goals, roadmap — the CEO holds the mission and sets direction.",
};

// The CEO's one subagent. key "plan" reuses the existing "brief" output kind
// (internal → saved to the Drive, no external publish), so no new plumbing.
const CEO_SUBAGENT = {
  key: "plan",
  name: "Planning",
  job: "Set the organization's near-term priorities and delegate — a short strategic brief, not specialist work.",
  routeWhen: [
    "priorities",
    "strategy",
    "goals",
    "roadmap",
    "direction",
    "what should we focus on",
    "plan our",
  ],
  notHere: [{ phrase: "write the actual blog post / deliverable", to: "@tethr" }],
  reads: ["Tethr Drive", "memory"],
  steps: [
    "Restate the mission and the current objectives",
    "Review recent drafts/briefs in the Drive and any open work",
    "Name the top 3–5 priorities with rationale and an owner (which agent or human) each",
    "Save the brief to the Drive",
  ],
  output: "A short, dated priorities brief in the Drive.",
  guardrails: [
    "Internal-only — sets direction, never publishes or spends",
    "Delegate by naming owners; don't do the specialists' work",
    "Keep it short and decisive",
  ],
  doneWhen: "A dated priorities brief exists in the Drive.",
  escalation: "Escalate cross-cutting or budget decisions to Mark via @tethr.",
  sensitivity: "internal" as const,
};

// @tethr's role, reframed to Mark's "conductor / Jarvis" model.
const TETHR_CONDUCTOR_TITLE = "Conductor — the interface between the team and the agents";
const TETHR_CONDUCTOR_MISSION =
  "Tethr is the conductor: the communicator and manager between the human team and the AI agents, reporting to no one. Absorb any request (Slack @tethr / DM or the Console), understand it, and get it done — answer directly, route strategy to the CEO, route work to the specialists — then relay results back to the team.";

export interface CeoSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure the CEO agent exists in the given company. */
export async function seedCeoAgent(db: Db, companyId: string): Promise<CeoSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(
        eq(tethrAgentProfiles.companyId, companyId),
        eq(tethrAgentProfiles.tag, CEO_AGENT.tag),
      ),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding the AI CEO (@ceo)");

  const [ceo] = await db
    .insert(agents)
    .values({
      companyId,
      name: CEO_AGENT.codename,
      role: "ceo",
      title: CEO_AGENT.title,
      icon: "star",
      status: "idle",
      reportsTo: null, // a second root: head of the agent org, beside @tethr
      capabilities: CEO_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: {
        agentTag: CEO_AGENT.tag,
        heartbeatRequest: CEO_AGENT.heartbeatRequest,
        subagentChain: ["plan"],
      },
      budgetMonthlyCents: CEO_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: ceo.id,
    divisionId: null, // above divisions — rendered in the tier-0 banner, not a member
    tag: CEO_AGENT.tag,
    codename: CEO_AGENT.codename,
    mission: CEO_AGENT.mission,
    approvalGate: "none",
    heartbeatNote: CEO_AGENT.heartbeatNote,
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: ceo.id,
    key: CEO_SUBAGENT.key,
    tag: `@ceo.${CEO_SUBAGENT.key}`,
    name: CEO_SUBAGENT.name,
    job: CEO_SUBAGENT.job,
    routeWhen: CEO_SUBAGENT.routeWhen,
    notHere: CEO_SUBAGENT.notHere,
    reads: CEO_SUBAGENT.reads,
    steps: CEO_SUBAGENT.steps,
    output: CEO_SUBAGENT.output,
    guardrails: CEO_SUBAGENT.guardrails,
    doneWhen: CEO_SUBAGENT.doneWhen,
    escalation: CEO_SUBAGENT.escalation,
    sensitivity: CEO_SUBAGENT.sensitivity,
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: ceo.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: CEO_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  // Daily planning heartbeat — seeded PAUSED (Mark enables heartbeats explicitly).
  const routines = routineService(db);
  const routine = await routines.create(
    companyId,
    {
      title: "CEO heartbeat",
      description: `${CEO_AGENT.heartbeatNote}. Request: ${CEO_AGENT.heartbeatRequest}`,
      assigneeAgentId: ceo.id,
      priority: "medium",
      status: "paused",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    },
    { userId: "tethr-seed" },
  );
  await routines.createTrigger(
    routine.id,
    {
      kind: "schedule",
      cronExpression: CEO_AGENT.heartbeatCron,
      timezone: "America/New_York",
      enabled: false,
      label: CEO_AGENT.heartbeatNote,
    } as never,
    { userId: "tethr-seed" },
  );

  await linkTethrToCeo(db, companyId);

  logger.info({ companyId, agentId: ceo.id }, "[tethr] AI CEO seeded (heartbeat paused)");
  return { created: true, agentId: ceo.id };
}

/**
 * Point @tethr at the CEO: add the strategy routing row and refresh @tethr's
 * role text to the conductor framing. Idempotent — safe to call repeatedly.
 */
async function linkTethrToCeo(db: Db, companyId: string): Promise<void> {
  const [tethrProfile] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")),
    )
    .limit(1);
  if (!tethrProfile) return;

  const rows = Array.isArray(tethrProfile.routingTable)
    ? (tethrProfile.routingTable as Array<{ when: string[]; to: string; description?: string }>)
    : [];
  if (!rows.some((r) => r.to === CEO_AGENT.tag)) {
    await db
      .update(tethrAgentProfiles)
      .set({
        routingTable: [CEO_ROUTING_ROW, ...rows],
        mission: TETHR_CONDUCTOR_MISSION,
      })
      .where(eq(tethrAgentProfiles.id, tethrProfile.id));
    await db
      .update(agents)
      .set({
        title: TETHR_CONDUCTOR_TITLE,
        capabilities: TETHR_CONDUCTOR_MISSION,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, tethrProfile.agentId));
  }
}
