import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  budgetPolicies,
  routines,
  routineTriggers,
  tethrAgentProfiles,
  tethrOrgChanges,
  tethrSubagents,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { MAX_PROPOSAL_BUDGET_CENTS } from "./factory.js";

// Tinkr's engine: validated, human-approved, revertible modifications to
// existing agents. A change is STAGED by the stage_org_change tool (gated
// `org_change` output), APPLIED here when a human approves it, and LOGGED with
// before/after snapshots. Revert is GitHub-style: it stages the inverse change
// through the same gate — history is append-only.

export const ORG_CHANGE_OPS = [
  "rename",
  "update_profile",
  "update_budget",
  "update_subagent",
  "set_status",
  "set_schedule",
] as const;
export type OrgChangeOp = (typeof ORG_CHANGE_OPS)[number];

// Load-bearing tags: the conductor, the CEO, and Tinkr itself can be
// re-missioned but never renamed or paused — routing and the factory resolve
// them by tag.
export const PROTECTED_TAGS = ["@tethr", "@ceo", "@tinkr"];

export interface OrgChangeSpec {
  op: OrgChangeOp;
  /** The target agent's CURRENT tag, e.g. "@radar". */
  targetTag: string;
  // rename
  newCodename?: string;
  // update_profile
  title?: string;
  mission?: string;
  // update_budget
  budgetMonthlyCents?: number;
  // update_subagent
  subagentTag?: string;
  job?: string;
  steps?: string[];
  guardrails?: string[];
  routeWhen?: string[];
  // set_status
  status?: "active" | "paused";
  reason?: string;
  // set_schedule
  cron?: string;
  scheduleEnabled?: boolean;
}

export interface OrgChangeValidation {
  ok: boolean;
  errors: string[];
  spec?: OrgChangeSpec;
  target?: { agentId: string; codename: string; tag: string };
}

function normalizeTag(tag: unknown): string {
  const t = String(tag ?? "").trim().toLowerCase();
  return t.startsWith("@") ? t : `@${t}`;
}

export function tagForCodename(codename: string): string {
  return `@${codename.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

/** Validate + normalize a raw change spec against the live org. */
export async function validateOrgChange(
  db: Db,
  companyId: string,
  raw: unknown,
): Promise<OrgChangeValidation> {
  const errors: string[] = [];
  const s = (raw ?? {}) as Record<string, unknown>;
  const op = String(s.op ?? "") as OrgChangeOp;
  if (!ORG_CHANGE_OPS.includes(op)) {
    return { ok: false, errors: [`unknown op "${s.op}" — one of: ${ORG_CHANGE_OPS.join(", ")}`] };
  }

  const targetTag = normalizeTag(s.targetTag ?? s.target ?? s.agentTag);
  const [profile] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, targetTag)))
    .limit(1);
  if (!profile) {
    return { ok: false, errors: [`no such agent ${targetTag} in this org`] };
  }
  const protectedTarget = PROTECTED_TAGS.includes(targetTag);

  const spec: OrgChangeSpec = { op, targetTag };

  if (op === "rename") {
    const codename = String(s.newCodename ?? s.newName ?? s.codename ?? "").trim();
    if (!/^[A-Za-z][A-Za-z0-9 ]{1,24}$/.test(codename)) {
      errors.push("newCodename must be 2–25 letters/digits/spaces, starting with a letter");
    }
    if (protectedTarget) errors.push(`${targetTag} is protected and cannot be renamed`);
    const newTag = tagForCodename(codename);
    if (newTag !== targetTag) {
      const [clash] = await db
        .select({ id: tethrAgentProfiles.id })
        .from(tethrAgentProfiles)
        .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, newTag)))
        .limit(1);
      if (clash) errors.push(`an agent ${newTag} already exists`);
    } else if (codename === profile.codename) {
      errors.push("that is already the agent's name");
    }
    spec.newCodename = codename;
  } else if (op === "update_profile") {
    const title = String(s.title ?? "").trim();
    const mission = String(s.mission ?? "").trim();
    if (!title && !mission) errors.push("provide a new title and/or mission");
    if (title) spec.title = title;
    if (mission) spec.mission = mission;
  } else if (op === "update_budget") {
    const cents = Math.round(Number(s.budgetMonthlyCents ?? (Number(s.budgetMonthlyUsd) * 100)));
    if (!Number.isFinite(cents) || cents < 0) errors.push("budgetMonthlyCents must be a non-negative integer");
    else if (cents > MAX_PROPOSAL_BUDGET_CENTS) {
      errors.push(`budget exceeds the $${MAX_PROPOSAL_BUDGET_CENTS / 100}/mo ceiling`);
    } else spec.budgetMonthlyCents = cents;
  } else if (op === "update_subagent") {
    const subTag = normalizeTag(s.subagentTag ?? s.subagent);
    const [sub] = await db
      .select({ id: tethrSubagents.id })
      .from(tethrSubagents)
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, subTag)))
      .limit(1);
    if (!sub) errors.push(`no such subagent ${subTag}`);
    spec.subagentTag = subTag;
    if (typeof s.job === "string" && s.job.trim()) spec.job = s.job.trim();
    if (Array.isArray(s.steps)) spec.steps = s.steps.map(String);
    if (Array.isArray(s.guardrails)) spec.guardrails = s.guardrails.map(String);
    if (Array.isArray(s.routeWhen)) spec.routeWhen = s.routeWhen.map(String);
    if (!spec.job && !spec.steps && !spec.guardrails && !spec.routeWhen) {
      errors.push("provide at least one of job/steps/guardrails/routeWhen");
    }
  } else if (op === "set_status") {
    const status = String(s.status ?? "");
    if (status !== "active" && status !== "paused") errors.push('status must be "active" or "paused"');
    if (protectedTarget) errors.push(`${targetTag} is protected and cannot be paused/resumed by Tinkr`);
    spec.status = status as "active" | "paused";
    if (typeof s.reason === "string" && s.reason.trim()) spec.reason = s.reason.trim();
  } else if (op === "set_schedule") {
    const [routine] = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, profile.agentId)))
      .limit(1);
    if (!routine) errors.push(`${targetTag} has no scheduled routine to change`);
    if (s.cron !== undefined) {
      const cron = String(s.cron).trim();
      if (!CRON_RE.test(cron)) errors.push(`"${s.cron}" is not a valid 5-field cron expression`);
      else spec.cron = cron;
    }
    if (s.scheduleEnabled !== undefined) spec.scheduleEnabled = Boolean(s.scheduleEnabled);
    if (spec.cron === undefined && spec.scheduleEnabled === undefined) {
      errors.push("provide cron and/or scheduleEnabled");
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    spec,
    target: { agentId: profile.agentId, codename: profile.codename, tag: profile.tag },
  };
}

// ---- snapshots + rendering ------------------------------------------------------

/** Snapshot the fields this op will touch — the revert source. */
export async function computeBefore(
  db: Db,
  companyId: string,
  spec: OrgChangeSpec,
): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ profile: tethrAgentProfiles, agent: agents })
    .from(tethrAgentProfiles)
    .innerJoin(agents, eq(agents.id, tethrAgentProfiles.agentId))
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, spec.targetTag)))
    .limit(1);
  if (!row) throw new Error(`no such agent ${spec.targetTag}`);

  switch (spec.op) {
    case "rename":
      return { codename: row.profile.codename, tag: row.profile.tag };
    case "update_profile":
      return {
        ...(spec.title !== undefined ? { title: row.agent.title } : {}),
        ...(spec.mission !== undefined ? { mission: row.profile.mission } : {}),
      };
    case "update_budget":
      return { budgetMonthlyCents: row.agent.budgetMonthlyCents };
    case "update_subagent": {
      const [sub] = await db
        .select()
        .from(tethrSubagents)
        .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, spec.subagentTag!)))
        .limit(1);
      if (!sub) throw new Error(`no such subagent ${spec.subagentTag}`);
      return {
        subagentTag: sub.tag,
        ...(spec.job !== undefined ? { job: sub.job } : {}),
        ...(spec.steps !== undefined ? { steps: sub.steps } : {}),
        ...(spec.guardrails !== undefined ? { guardrails: sub.guardrails } : {}),
        ...(spec.routeWhen !== undefined ? { routeWhen: sub.routeWhen } : {}),
      };
    }
    case "set_status":
      return { status: row.agent.status === "paused" ? "paused" : "active", reason: row.agent.pauseReason ?? null };
    case "set_schedule": {
      const sched = await findSchedule(db, companyId, row.agent.id);
      return {
        ...(spec.cron !== undefined ? { cron: sched?.trigger?.cronExpression ?? null } : {}),
        ...(spec.scheduleEnabled !== undefined ? { scheduleEnabled: sched?.trigger?.enabled ?? false } : {}),
      };
    }
  }
}

/** What the fields become. Mirrors computeBefore's keys. */
export function computeAfter(spec: OrgChangeSpec): Record<string, unknown> {
  switch (spec.op) {
    case "rename":
      return { codename: spec.newCodename, tag: tagForCodename(spec.newCodename!) };
    case "update_profile":
      return {
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        ...(spec.mission !== undefined ? { mission: spec.mission } : {}),
      };
    case "update_budget":
      return { budgetMonthlyCents: spec.budgetMonthlyCents };
    case "update_subagent":
      return {
        subagentTag: spec.subagentTag,
        ...(spec.job !== undefined ? { job: spec.job } : {}),
        ...(spec.steps !== undefined ? { steps: spec.steps } : {}),
        ...(spec.guardrails !== undefined ? { guardrails: spec.guardrails } : {}),
        ...(spec.routeWhen !== undefined ? { routeWhen: spec.routeWhen } : {}),
      };
    case "set_status":
      return { status: spec.status, reason: spec.reason ?? null };
    case "set_schedule":
      return {
        ...(spec.cron !== undefined ? { cron: spec.cron } : {}),
        ...(spec.scheduleEnabled !== undefined ? { scheduleEnabled: spec.scheduleEnabled } : {}),
      };
  }
}

export function changeSummary(spec: OrgChangeSpec, before: Record<string, unknown>): string {
  switch (spec.op) {
    case "rename":
      return `rename: ${String(before.codename)} → ${spec.newCodename}`;
    case "update_profile":
      return `update ${spec.targetTag}: ${[spec.title && "title", spec.mission && "mission"].filter(Boolean).join(" + ")}`;
    case "update_budget":
      return `budget ${spec.targetTag}: $${(Number(before.budgetMonthlyCents ?? 0) / 100).toFixed(0)} → $${((spec.budgetMonthlyCents ?? 0) / 100).toFixed(0)}/mo`;
    case "update_subagent":
      return `update ${spec.subagentTag}: ${[spec.job && "job", spec.steps && "steps", spec.guardrails && "guardrails", spec.routeWhen && "routing"].filter(Boolean).join(" + ")}`;
    case "set_status":
      return `${spec.status === "paused" ? "pause" : "resume"} ${spec.targetTag}`;
    case "set_schedule":
      return `schedule ${spec.targetTag}: ${[spec.cron && `cron → ${spec.cron}`, spec.scheduleEnabled !== undefined && (spec.scheduleEnabled ? "enable" : "disable")].filter(Boolean).join(", ")}`;
  }
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.join(" · ") || "—";
  return String(v);
}

/** The Queue-facing diff body (markdown; the Slack layer converts to mrkdwn). */
export function renderChangeBody(
  spec: OrgChangeSpec,
  before: Record<string, unknown>,
  target: { codename: string; tag: string },
): string {
  const after = computeAfter(spec);
  const keys = Object.keys(after).filter((k) => k !== "subagentTag");
  const lines = keys.map((k) => `- **${k}**: ${fmt(before[k])} → ${fmt(after[k])}`);
  return [
    `## Org change: ${changeSummary(spec, before)}`,
    "",
    `**Target:** ${target.codename} (${target.tag})${spec.subagentTag ? ` · subagent ${spec.subagentTag}` : ""}`,
    `**Operation:** ${spec.op}`,
    "",
    ...lines,
    "",
    "_Approve to apply. Reject to discard. Applied changes are logged on the Company page and can be reverted._",
  ].join("\n");
}

// ---- apply ----------------------------------------------------------------------

async function findSchedule(db: Db, companyId: string, agentId: string) {
  const [routine] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, agentId)))
    .limit(1);
  if (!routine) return null;
  const [trigger] = await db
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.routineId, routine.id), eq(routineTriggers.kind, "schedule")))
    .limit(1);
  return { routine, trigger: trigger ?? null };
}

export interface ApplyOrgChangeInput {
  companyId: string;
  spec: OrgChangeSpec;
  outputId?: string | null;
  appliedBy: string;
  revertOfChangeId?: string | null;
}

/** Apply an approved change and record it in the revertible log. */
export async function applyOrgChange(db: Db, input: ApplyOrgChangeInput) {
  const { companyId, spec } = input;
  const [row] = await db
    .select({ profile: tethrAgentProfiles, agent: agents })
    .from(tethrAgentProfiles)
    .innerJoin(agents, eq(agents.id, tethrAgentProfiles.agentId))
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, spec.targetTag)))
    .limit(1);
  if (!row) throw new Error(`no such agent ${spec.targetTag}`);
  const agentId = row.agent.id;
  const before = await computeBefore(db, companyId, spec);
  const after = computeAfter(spec);
  const now = new Date();

  if (spec.op === "rename") {
    const oldTag = row.profile.tag;
    const newTag = tagForCodename(spec.newCodename!);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const adapterConfig = {
        ...((row.agent.adapterConfig as Record<string, unknown>) ?? {}),
        agentTag: newTag,
      };
      await txDb
        .update(agents)
        .set({ name: spec.newCodename!, adapterConfig, updatedAt: now })
        .where(eq(agents.id, agentId));
      await txDb
        .update(tethrAgentProfiles)
        .set({ codename: spec.newCodename!, tag: newTag })
        .where(eq(tethrAgentProfiles.id, row.profile.id));
      // Subagent tags keep their suffix: @radar.scan → @scout.scan
      const subs = await txDb
        .select()
        .from(tethrSubagents)
        .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.agentId, agentId)));
      for (const sub of subs) {
        await txDb
          .update(tethrSubagents)
          .set({ tag: `${newTag}.${sub.key}`, updatedAt: now })
          .where(eq(tethrSubagents.id, sub.id));
      }
      // Every routing table that pointed at the old tag follows the rename.
      const profiles = await txDb
        .select()
        .from(tethrAgentProfiles)
        .where(eq(tethrAgentProfiles.companyId, companyId));
      for (const p of profiles) {
        const table = Array.isArray(p.routingTable)
          ? (p.routingTable as Array<{ when: string[]; to: string; description?: string }>)
          : [];
        if (table.some((r) => r.to === oldTag)) {
          await txDb
            .update(tethrAgentProfiles)
            .set({ routingTable: table.map((r) => (r.to === oldTag ? { ...r, to: newTag } : r)) })
            .where(eq(tethrAgentProfiles.id, p.id));
        }
      }
    });
  } else if (spec.op === "update_profile") {
    await db
      .update(agents)
      .set({
        ...(spec.title !== undefined ? { title: spec.title } : {}),
        ...(spec.mission !== undefined ? { capabilities: spec.mission } : {}),
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));
    if (spec.mission !== undefined) {
      await db
        .update(tethrAgentProfiles)
        .set({ mission: spec.mission })
        .where(eq(tethrAgentProfiles.id, row.profile.id));
    }
  } else if (spec.op === "update_budget") {
    await db
      .update(agents)
      .set({ budgetMonthlyCents: spec.budgetMonthlyCents!, updatedAt: now })
      .where(eq(agents.id, agentId));
    await db
      .update(budgetPolicies)
      .set({ amount: spec.budgetMonthlyCents!, updatedAt: now })
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "agent"),
          eq(budgetPolicies.scopeId, agentId),
        ),
      );
  } else if (spec.op === "update_subagent") {
    await db
      .update(tethrSubagents)
      .set({
        ...(spec.job !== undefined ? { job: spec.job } : {}),
        ...(spec.steps !== undefined ? { steps: spec.steps } : {}),
        ...(spec.guardrails !== undefined ? { guardrails: spec.guardrails } : {}),
        ...(spec.routeWhen !== undefined ? { routeWhen: spec.routeWhen } : {}),
        updatedAt: now,
      })
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, spec.subagentTag!)));
  } else if (spec.op === "set_status") {
    await db
      .update(agents)
      .set(
        spec.status === "paused"
          ? { status: "paused", pausedAt: now, pauseReason: spec.reason ?? `Paused via Tinkr by ${input.appliedBy}`, updatedAt: now }
          : { status: "idle", pausedAt: null, pauseReason: null, updatedAt: now },
      )
      .where(eq(agents.id, agentId));
  } else if (spec.op === "set_schedule") {
    const sched = await findSchedule(db, companyId, agentId);
    if (!sched?.trigger) throw new Error(`${spec.targetTag} has no schedule trigger`);
    const { routineService } = await import("../services/routines.js");
    const svc = routineService(db);
    await svc.updateTrigger(
      sched.trigger.id,
      {
        ...(spec.cron !== undefined ? { cronExpression: spec.cron } : {}),
        ...(spec.scheduleEnabled !== undefined ? { enabled: spec.scheduleEnabled } : {}),
      },
      { userId: input.appliedBy },
    );
    if (spec.scheduleEnabled !== undefined) {
      await svc.update(
        sched.routine.id,
        { status: spec.scheduleEnabled ? "active" : "paused" },
        { userId: input.appliedBy },
      );
    }
  }

  const [change] = await db
    .insert(tethrOrgChanges)
    .values({
      companyId,
      outputId: input.outputId ?? null,
      op: spec.op,
      targetAgentId: agentId,
      targetTag: spec.targetTag,
      before,
      after,
      summary: changeSummary(spec, before),
      status: "applied",
      revertOfChangeId: input.revertOfChangeId ?? null,
      appliedBy: input.appliedBy,
    })
    .returning();

  if (input.revertOfChangeId) {
    await db
      .update(tethrOrgChanges)
      .set({ status: "reverted", revertedByChangeId: change.id })
      .where(eq(tethrOrgChanges.id, input.revertOfChangeId));
  }

  logger.info(
    { companyId, changeId: change.id, op: spec.op, target: spec.targetTag },
    "[tethr] org change applied",
  );
  return change;
}

/** Build the inverse spec (git-revert style) from a logged change. */
export function buildInverseSpec(change: typeof tethrOrgChanges.$inferSelect): OrgChangeSpec {
  const before = change.before as Record<string, unknown>;
  const after = change.after as Record<string, unknown>;
  const op = change.op as OrgChangeOp;
  switch (op) {
    case "rename":
      // The agent now carries the AFTER tag; rename it back to the before name.
      return { op, targetTag: String(after.tag), newCodename: String(before.codename) };
    case "update_profile":
      return {
        op,
        targetTag: change.targetTag,
        ...(before.title !== undefined ? { title: String(before.title) } : {}),
        ...(before.mission !== undefined ? { mission: String(before.mission) } : {}),
      };
    case "update_budget":
      return { op, targetTag: change.targetTag, budgetMonthlyCents: Number(before.budgetMonthlyCents ?? 0) };
    case "update_subagent":
      return {
        op,
        targetTag: change.targetTag,
        subagentTag: String(before.subagentTag),
        ...(before.job !== undefined ? { job: String(before.job) } : {}),
        ...(before.steps !== undefined ? { steps: (before.steps as string[]) ?? [] } : {}),
        ...(before.guardrails !== undefined ? { guardrails: (before.guardrails as string[]) ?? [] } : {}),
        ...(before.routeWhen !== undefined ? { routeWhen: (before.routeWhen as string[]) ?? [] } : {}),
      };
    case "set_status":
      return {
        op,
        targetTag: change.targetTag,
        status: (before.status as "active" | "paused") ?? "active",
        reason: `Revert of change ${change.id.slice(0, 8)}`,
      };
    case "set_schedule":
      return {
        op,
        targetTag: change.targetTag,
        ...(before.cron !== undefined && before.cron !== null ? { cron: String(before.cron) } : {}),
        ...(before.scheduleEnabled !== undefined ? { scheduleEnabled: Boolean(before.scheduleEnabled) } : {}),
      };
  }
}
