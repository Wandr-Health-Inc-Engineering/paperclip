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

// Patch — the debug agent (Mark's spec, 2026-07-13). Tag @tethr when something
// breaks; Tethr routes here. Patch reads the failure log (read-only, DB only —
// no filesystem access), diagnoses what went wrong, and writes a
// Claude-Code-ready fix report into the shared workspace. Reached ONLY through
// @tethr routing — there is no Patch Slack bot; @patch is an internal org tag.
//
// Additive + idempotent, like seed/tinkr.ts: fills into the live org on boot.

export const PATCH_AGENT = {
  tag: "@patch",
  codename: "Patch",
  title: "Debug — reviews failures, writes fixes for Claude Code",
  mission:
    "When a request fails, read the failure log, explain in plain terms what broke and why, and write a precise, paste-ready fix a developer can hand straight to Claude Code — the file, the problem, and the change. Diagnose only; never claim to have applied anything.",
  budgetMonthlyCents: 1000, // $10/mo, hard-stop on — reading logs + writing a report is cheap
};

const PATCH_ROUTING_ROW = {
  when: [
    "error",
    "broke",
    "broken",
    "failed",
    "failure",
    "didn't work",
    "not working",
    "bug",
    "crash",
    "exception",
    "debug",
    "review the logs",
    "what went wrong",
  ],
  to: "@patch",
  description:
    "Something broke — review the failure log, diagnose the cause, and write a Claude-Code-ready fix. Read-only; changes nothing.",
};

const PATCH_SUBAGENT = {
  key: "diagnose",
  name: "Diagnose",
  job: "Read the recent failure log, find the root cause, and write a paste-ready fix report for Claude Code.",
  routeWhen: ["error", "failed", "broke", "debug", "bug", "crash", "what went wrong"],
  notHere: [
    { phrase: "change or rename an agent", to: "@tinkr" },
    { phrase: "a general question, nothing broke", to: "@tethr.chat" },
  ],
  reads: ["The failure log (read_failures — recent failed/errored requests + traces)", "memory"],
  steps: [
    "Call read_failures to pull the recent failures (filter by a keyword if the request names one)",
    "Identify the single most relevant failure and its root cause from the error + trace",
    "Name the likely file/area at fault and explain the cause in plain terms",
    "Write a paste-ready Claude Code instruction: the file, the problem, and the exact change to make",
    "Note any human step that code alone can't fix (a token, a scope, an account setting)",
  ],
  output:
    "A short markdown fix report. Begin the response with the line `[file-under: 07 Debug]` on its own line, then a blank line, then: what broke (plain English) · likely file/cause · a copy-paste Claude Code prompt to fix it · any manual step needed.",
  guardrails: [
    "Read-only: you diagnose and recommend — you never apply a fix or claim you did",
    "Ground every claim in the actual error/trace from read_failures; if the log is empty, say so",
    "Give ONE concrete recommendation, not a menu of maybes",
    "If a fix needs a human action (API key, Slack scope, account setting), call it out explicitly",
  ],
  doneWhen: "A fix report is written naming the cause and a paste-ready Claude Code instruction (or a clear 'nothing is broken').",
  escalation: "A failure that needs data you can't see (external service state) → say what a human should check.",
  sensitivity: "internal" as const,
};

export interface PatchSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure Patch exists, reporting to the CEO, routed from @tethr. */
export async function seedPatchAgent(db: Db, companyId: string): Promise<PatchSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, PATCH_AGENT.tag)),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding Patch (@patch), the debug agent");

  const [ceo] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);

  const [patch] = await db
    .insert(agents)
    .values({
      companyId,
      name: PATCH_AGENT.codename,
      role: "general",
      title: PATCH_AGENT.title,
      icon: "bug",
      status: "idle",
      reportsTo: ceo?.agentId ?? null,
      capabilities: PATCH_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: PATCH_AGENT.tag, subagentChain: ["diagnose"] },
      budgetMonthlyCents: PATCH_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: patch.id,
    divisionId: null,
    tag: PATCH_AGENT.tag,
    codename: PATCH_AGENT.codename,
    mission: PATCH_AGENT.mission,
    approvalGate: "internal", // reports are internal read-and-recommend — no gate
    overseerRole: "tech", // debugging routes to the tech overseer (Frank)
    heartbeatNote: "On request — no schedule; Patch works when something breaks.",
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: patch.id,
    key: PATCH_SUBAGENT.key,
    tag: `${PATCH_AGENT.tag}.${PATCH_SUBAGENT.key}`,
    name: PATCH_SUBAGENT.name,
    job: PATCH_SUBAGENT.job,
    routeWhen: PATCH_SUBAGENT.routeWhen,
    notHere: PATCH_SUBAGENT.notHere,
    reads: PATCH_SUBAGENT.reads,
    steps: PATCH_SUBAGENT.steps,
    output: PATCH_SUBAGENT.output,
    guardrails: PATCH_SUBAGENT.guardrails,
    doneWhen: PATCH_SUBAGENT.doneWhen,
    escalation: PATCH_SUBAGENT.escalation,
    sensitivity: PATCH_SUBAGENT.sensitivity,
    // The tool grant (read-only debug log + drive write for the report). Baseline
    // (drive_list/drive_read/recall_memory/escalate) is auto-added at run time.
    tools: ["read_failures", "drive_write"],
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: patch.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: PATCH_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  await addTethrRoutingRow(db, companyId, PATCH_ROUTING_ROW);

  logger.info({ companyId, agentId: patch.id }, "[tethr] Patch seeded (on-request, no heartbeat)");
  return { created: true, agentId: patch.id };
}
