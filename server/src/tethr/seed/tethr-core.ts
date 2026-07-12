import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  budgetPolicies,
  companies,
  tethrAgentProfiles,
  tethrDivisions,
  tethrSubagents,
} from "@paperclipai/db";
import { TETHR_ADAPTER_TYPE } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { driveService } from "../drive.js";

// Phase 11 — the clean-slate seed. ONE agent: Tethr, the orchestrator/coordinator.
//
// Mark's direction: gut the 12-agent Wandr Growth org (it was overwhelming to
// manage) and start over with a single front door. Tag @tethr on Slack, DM it,
// or type into the Console chat — every request lands here. Tethr answers
// directly today; specialist agents get re-added one at a time, each becoming
// a new row in Tethr's routing table.
//
// Gutting is NON-destructive: if the old "Wandr Growth" company exists it is
// archived (status flip, reversible), never deleted. `seedWandrGrowth` stays
// in the repo as the parts bin for re-adding specialists later.

export const CORE_COMPANY = {
  name: "Wandr",
  issuePrefix: "WD",
  goal: "Wandr Health's marketing & distribution operations, coordinated by Tethr — one front door that absorbs any request, answers directly, and routes to specialist agents as they come online.",
  budgetMonthlyCents: 10000, // $100/mo company line while the org is one agent
};

export const TETHR_AGENT = {
  tag: "@tethr",
  codename: "Tethr",
  role: "Coordinator",
  title: "Coordinator — the front door for every request",
  mission:
    "Absorb any request from Slack (@tethr / DM) or the Console chat, understand it, and get it done: answer directly, draft the plan, or — as specialists are added — route to the right agent. Keep every action inside budget caps and approval gates.",
  budgetMonthlyCents: 2500, // $25/mo, hard-stop on
  routing: [
    {
      when: ["everything"],
      to: "@tethr",
      description:
        "Everything — no specialist agents exist yet. Tethr handles requests directly (answer or plan).",
    },
  ],
};

export const CORE_STANDING_RULES = [
  "Nothing publishes externally without a human approval (medical/public/spend/pr gates stay hard)",
  "Never make or imply medical-content decisions — structural/marketing work only",
  "Stay inside the monthly budget cap; stop and surface when close",
  "When a request needs a specialist that doesn't exist yet, say so and draft the plan instead",
];

const SUBAGENTS = [
  {
    key: "chat",
    name: "Chat",
    job: "Answer the request directly: questions, status, summaries, quick analysis.",
    routeWhen: [
      "question",
      "what",
      "how",
      "status",
      "summary",
      "explain",
      "look up",
      "check",
    ],
    notHere: [{ phrase: "write a full plan or brief", to: "@tethr.plan" }],
    reads: ["Tethr Drive", "memory", "Google Ads (read-only)"],
    steps: [
      "Read the request and any conversation context",
      "Pull what's needed (Drive, memory, read-only reports)",
      "Answer plainly and concretely",
    ],
    output: "A direct answer in the thread/console.",
    guardrails: [
      "Read-only — never publishes or spends",
      "Lead with the answer. Keep it Slack-ready and concise (~250 words) unless asked for depth",
      "Use earlier context in the thread without restating it; say 'I don't know' plainly when you don't",
      "If the honest answer is 'a specialist should own this', say that",
      "Use the escalate tool only when a human decision or info you lack is truly required — it tags your overseer in the thread",
    ],
    doneWhen: "The question is answered or explicitly deferred to a plan.",
    escalation: "Call escalate to tag the overseer when a human decision is genuinely needed; gated work (medical/public/spend/pr) still goes to the Queue.",
    sensitivity: "safe" as const,
  },
  {
    key: "plan",
    name: "Plan",
    job: "Turn a request into a concrete plan or brief, saved to the Tethr Drive for review.",
    routeWhen: ["plan", "brief", "draft", "propose", "outline", "strategy", "how should we"],
    notHere: [{ phrase: "just answer a question", to: "@tethr.chat" }],
    reads: ["Tethr Drive", "memory", "keyword ideas (read-only)"],
    steps: [
      "Restate the goal and constraints",
      "Lay out steps, owners (human vs future agent), and what it costs",
      "Save the doc to the Drive as an internal deliverable",
    ],
    output: "A markdown plan/brief in the Tethr Drive.",
    guardrails: [
      "Internal-only output — publishing anything external stays human-gated",
      "No spend commitments; recommendations only",
    ],
    doneWhen: "The plan doc exists in the Drive and is linked in the reply.",
    escalation: "Anything gated (medical/public/spend/pr) goes to the queue for Mark.",
    sensitivity: "internal" as const,
  },
];

export interface CoreSeedResult {
  companyId: string;
  created: boolean;
  archivedOldCompany: boolean;
}

/** Archive (never delete) the old Wandr Growth org so the slate reads clean. */
async function archiveWandrGrowth(db: Db): Promise<boolean> {
  const [old] = await db
    .select()
    .from(companies)
    .where(eq(companies.name, "Wandr Growth"))
    .limit(1);
  if (!old || old.status === "archived") return false;
  await db
    .update(companies)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(companies.id, old.id));
  logger.info({ companyId: old.id }, "[tethr] archived the old Wandr Growth org (recoverable)");
  return true;
}

export async function seedTethrCore(
  db: Db,
  opts: { force?: boolean } = {},
): Promise<CoreSeedResult> {
  const archivedOldCompany = await archiveWandrGrowth(db);

  const [existing] = await db
    .select()
    .from(companies)
    .where(eq(companies.name, CORE_COMPANY.name))
    .limit(1);
  if (existing && !opts.force) {
    return { companyId: existing.id, created: false, archivedOldCompany };
  }

  logger.info("[tethr] seeding the clean-slate org: Wandr + @tethr");
  const [company] = existing
    ? [existing]
    : await db
        .insert(companies)
        .values({
          name: CORE_COMPANY.name,
          description: CORE_COMPANY.goal,
          status: "active",
          issuePrefix: CORE_COMPANY.issuePrefix,
          budgetMonthlyCents: CORE_COMPANY.budgetMonthlyCents,
        })
        .returning();
  const companyId = company.id;

  const [division] = await db
    .insert(tethrDivisions)
    .values({
      companyId,
      key: "operations",
      name: "Operations",
      description: "Coordination — where Tethr lives. Specialist divisions return as agents are re-added.",
      status: "active",
      icon: "target",
      sortOrder: 0,
    })
    .onConflictDoNothing()
    .returning();

  const [tethr] = await db
    .insert(agents)
    .values({
      companyId,
      name: TETHR_AGENT.codename,
      role: "executive",
      title: TETHR_AGENT.title,
      icon: "target",
      status: "idle",
      reportsTo: null,
      capabilities: TETHR_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: TETHR_AGENT.tag, heartbeatMode: "digest" },
      budgetMonthlyCents: TETHR_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: tethr.id,
    divisionId: division?.id ?? null,
    tag: TETHR_AGENT.tag,
    codename: TETHR_AGENT.codename,
    mission: TETHR_AGENT.mission,
    approvalGate: "none",
    heartbeatNote: "On request — the front door runs when spoken to, not on a clock.",
    routingTable: TETHR_AGENT.routing,
    standingRules: CORE_STANDING_RULES,
  });
  if (division) {
    await db
      .update(tethrDivisions)
      .set({ headAgentId: tethr.id, updatedAt: new Date() })
      .where(eq(tethrDivisions.id, division.id));
  }

  let order = 0;
  for (const sub of SUBAGENTS) {
    await db.insert(tethrSubagents).values({
      companyId,
      agentId: tethr.id,
      key: sub.key,
      tag: `@tethr.${sub.key}`,
      name: sub.name,
      job: sub.job,
      routeWhen: sub.routeWhen,
      notHere: sub.notHere,
      reads: sub.reads,
      steps: sub.steps,
      output: sub.output,
      guardrails: sub.guardrails,
      doneWhen: sub.doneWhen,
      escalation: sub.escalation,
      sensitivity: sub.sensitivity,
      sortOrder: order++,
    });
  }

  // Budgets are real: company line + Tethr's own cap, hard-stop on (Phase 3 rule —
  // every autonomous agent keeps its stated cap enforced by core budget_policies).
  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "company",
    scopeId: companyId,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: CORE_COMPANY.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: false,
    createdByUserId: "tethr-seed",
  });
  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: tethr.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: TETHR_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  // One Drive doc so the org isn't a blank page.
  const drive = driveService(db);
  await drive.ensureFolder(companyId, "/tethr", "tethr-seed");
  await drive.putFile({
    companyId,
    path: "/tethr/README.md",
    content: [
      "# Tethr — the coordinator",
      "",
      TETHR_AGENT.mission,
      "",
      "## How to reach it",
      "- Slack: tag @tethr or DM the bot",
      "- Console: type into the chat",
      "",
      "## Standing rules",
      ...CORE_STANDING_RULES.map((r) => `- ${r}`),
      "",
      "## Growing the org",
      "Specialists are re-added one at a time, each as a new row in Tethr's routing table.",
      "The old 12-agent Wandr Growth org is archived (not deleted) and can be studied or",
      "re-seeded via POST /api/tethr/seed {\"org\":\"growth\"}.",
    ].join("\n"),
    tags: ["spec", "generated"],
    createdByTag: "tethr-seed",
    note: "Seeded at company creation",
    permissions: { owner: "mark", read: ["*"], write: ["mark", "@tethr"] },
  });

  logger.info({ companyId, agents: 1, subagents: SUBAGENTS.length }, "[tethr] clean-slate org seeded");
  return { companyId, created: true, archivedOldCompany };
}
