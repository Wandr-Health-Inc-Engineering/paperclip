import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  budgetPolicies,
  tethrAgentProfiles,
  tethrSubagents,
} from "@paperclipai/db";
import {
  TETHR_ADAPTER_TYPE,
  type TethrAgentSpec,
  type TethrProposedSubagent,
  type TethrSensitivity,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { routineService } from "../services/routines.js";

// The agent factory: turn a validated agent spec (proposed by the CEO, approved
// by a human) into a real, working agent — reporting to the CEO, seeded PAUSED,
// with a hard-stop budget. Nothing here can hand a newborn agent spend/publish
// power: the proposable tool menu is read-only research only, and its heartbeat
// is always paused until a human enables it.

// Read-only research tools the CEO may grant. Baseline tools
// (drive_list/drive_read/recall_memory/escalate) are auto-granted to every
// subagent, so they need not be listed. Write / publish-adjacent tools
// (drive_write, advance_tracker, notify) are deliberately NOT proposable.
export const PROPOSABLE_TOOLS = [
  "web_fetch",
  "reddit_scan",
  "cdc_scan",
  "keyword_ideas",
  "google_ads_report",
  "read_tracker",
] as const;

export const MAX_PROPOSAL_BUDGET_CENTS = 10000; // $100/mo ceiling per proposed agent

// A newborn agent's subagents are internal/safe; anything that would publish
// externally still goes through the gate at run time, not at creation.
const PROPOSABLE_SENSITIVITIES: TethrSensitivity[] = ["internal", "safe"];

export interface SpecValidation {
  ok: boolean;
  errors: string[];
  spec?: TethrAgentSpec;
}

function tagFor(codename: string): string {
  return `@${codename.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** Validate + normalize an LLM-proposed spec. Rejects anything unbuildable. */
export function validateAgentSpec(
  raw: unknown,
  opts: { existingTags: Set<string> },
): SpecValidation {
  const errors: string[] = [];
  const s = (raw ?? {}) as Record<string, unknown>;

  const codename = String(s.codename ?? "").trim();
  if (!/^[A-Za-z][A-Za-z0-9 ]{1,24}$/.test(codename)) {
    errors.push("codename must be 2–25 letters/digits/spaces, starting with a letter");
  }
  const tag = tagFor(codename);
  if (codename && opts.existingTags.has(tag)) errors.push(`an agent ${tag} already exists`);

  const role = String(s.role ?? "").trim();
  const mission = String(s.mission ?? "").trim();
  const rationale = String(s.rationale ?? "").trim();
  if (!role) errors.push("role is required");
  if (!mission) errors.push("mission is required");

  const tools = Array.isArray(s.tools) ? s.tools.map(String) : [];
  const badTools = tools.filter((t) => !(PROPOSABLE_TOOLS as readonly string[]).includes(t));
  if (badTools.length) errors.push(`tools not proposable: ${badTools.join(", ")}`);

  let budget = Number(s.budgetMonthlyCents ?? 0);
  if (!Number.isFinite(budget) || budget < 0) budget = 0;
  if (budget > MAX_PROPOSAL_BUDGET_CENTS) {
    errors.push(`budget exceeds the $${MAX_PROPOSAL_BUDGET_CENTS / 100}/mo cap`);
  }

  const subsRaw = Array.isArray(s.subagents) ? s.subagents : [];
  if (subsRaw.length < 1 || subsRaw.length > 4) errors.push("provide 1–4 subagents");
  const seenKeys = new Set<string>();
  const subagents: TethrProposedSubagent[] = subsRaw.slice(0, 4).map((subRaw, i) => {
    const sub = (subRaw ?? {}) as Record<string, unknown>;
    let key =
      String(sub.key ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "") || `job${i + 1}`;
    while (seenKeys.has(key)) key = `${key}${i + 1}`;
    seenKeys.add(key);
    const sensitivity = String(sub.sensitivity ?? "internal") as TethrSensitivity;
    return {
      key,
      name: String(sub.name ?? "Task").trim() || "Task",
      job: String(sub.job ?? "").trim(),
      routeWhen: Array.isArray(sub.routeWhen) ? sub.routeWhen.map(String) : [],
      steps: Array.isArray(sub.steps) ? sub.steps.map(String) : [],
      output: String(sub.output ?? "").trim(),
      guardrails: Array.isArray(sub.guardrails) ? sub.guardrails.map(String) : [],
      sensitivity: PROPOSABLE_SENSITIVITIES.includes(sensitivity) ? sensitivity : "internal",
    };
  });
  if (subagents.some((sub) => !sub.job)) errors.push("every subagent needs a job");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    spec: {
      codename,
      role,
      mission,
      rationale,
      tools,
      budgetMonthlyCents: Math.round(budget),
      heartbeatCron: typeof s.heartbeatCron === "string" ? s.heartbeatCron : null,
      heartbeatNote: typeof s.heartbeatNote === "string" ? s.heartbeatNote : undefined,
      subagents,
    },
  };
}

/** Add a routing row to @tethr so it can hand requests to the new agent (idempotent). */
async function addTethrRoutingRow(
  db: Db,
  companyId: string,
  row: { when: string[]; to: string; description: string },
): Promise<void> {
  const [tethr] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
    .limit(1);
  if (!tethr) return;
  const rows = Array.isArray(tethr.routingTable)
    ? (tethr.routingTable as Array<{ when: string[]; to: string; description?: string }>)
    : [];
  if (rows.some((r) => r.to === row.to)) return;
  await db
    .update(tethrAgentProfiles)
    .set({ routingTable: [...rows, row] })
    .where(eq(tethrAgentProfiles.id, tethr.id));
}

export interface InstantiateResult {
  agentId: string;
  tag: string;
}

/**
 * Bring a spec to life: agent + profile + subagents + hard-stop budget + a
 * PAUSED heartbeat (if the spec asked for one). Reports to `reportsTo` (the CEO).
 */
export async function instantiateAgentFromSpec(
  db: Db,
  companyId: string,
  spec: TethrAgentSpec,
  opts: { reportsTo: string | null; divisionId?: string | null },
): Promise<InstantiateResult> {
  const tag = tagFor(spec.codename);
  const firstKey = spec.subagents[0]?.key ?? "work";

  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      name: spec.codename,
      role: "general",
      title: spec.role,
      icon: "bot",
      status: "idle",
      reportsTo: opts.reportsTo,
      capabilities: spec.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: {
        agentTag: tag,
        subagentChain: [firstKey],
        heartbeatRequest: spec.heartbeatNote ?? spec.mission,
      },
      budgetMonthlyCents: spec.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: agent.id,
    divisionId: opts.divisionId ?? null,
    tag,
    codename: spec.codename,
    mission: spec.mission,
    approvalGate: "internal",
    heartbeatNote: spec.heartbeatCron
      ? `${spec.heartbeatNote ?? "Scheduled"} (seeded paused until enabled)`
      : "On request",
    routingTable: [],
    standingRules: [],
  });

  let order = 0;
  for (const sub of spec.subagents) {
    await db.insert(tethrSubagents).values({
      companyId,
      agentId: agent.id,
      key: sub.key,
      tag: `${tag}.${sub.key}`,
      name: sub.name,
      job: sub.job,
      routeWhen: sub.routeWhen.length ? sub.routeWhen : [sub.key],
      reads: [],
      steps: sub.steps,
      output: sub.output || null,
      guardrails: sub.guardrails,
      sensitivity: sub.sensitivity,
      sortOrder: order++,
    });
  }

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: agent.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: spec.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-factory",
  });

  // A heartbeat — always seeded PAUSED (enabling it is a human's separate call).
  if (spec.heartbeatCron) {
    const routines = routineService(db);
    const routine = await routines.create(
      companyId,
      {
        title: `${spec.codename} heartbeat`,
        description: `${spec.heartbeatNote ?? spec.mission}`,
        assigneeAgentId: agent.id,
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      { userId: "tethr-factory" },
    );
    await routines.createTrigger(
      routine.id,
      {
        kind: "schedule",
        cronExpression: spec.heartbeatCron,
        timezone: "America/New_York",
        enabled: false,
        label: spec.heartbeatNote ?? "scheduled",
      } as never,
      { userId: "tethr-factory" },
    );
  }

  const when = Array.from(
    new Set(spec.subagents.flatMap((s) => s.routeWhen).filter(Boolean)),
  ).slice(0, 8);
  await addTethrRoutingRow(db, companyId, {
    when: when.length ? when : [spec.role.toLowerCase()],
    to: tag,
    description: `${spec.role} — ${spec.mission}`.slice(0, 200),
  });

  logger.info({ companyId, agentId: agent.id, tag }, "[tethr] instantiated a proposed agent (paused)");
  return { agentId: agent.id, tag };
}
