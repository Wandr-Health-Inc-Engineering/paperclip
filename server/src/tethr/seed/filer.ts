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

// Filer — the file archivist (phase 15). The ONLY agent that can "delete" a
// file, with two hard properties: deletion is ALWAYS a soft archive (a move to
// the store's archive folder — recoverable, never permanent), and nothing moves
// without a human confirmation ("approve"/"confirm" in the Slack thread or the
// Queue). Reached ONLY through @tethr routing — no Filer Slack bot.
//
// Additive + idempotent, like seed/tinkr.ts: fills into the live org on boot.

export const FILER_AGENT = {
  tag: "@filer",
  codename: "Filer",
  title: "Archivist — archives files, with your approval",
  mission:
    "Keep the workspace tidy without ever destroying anything: when asked to delete or archive a file, stage a soft archive (shared 00 Tethr folder → 99 Archive; internal Drive → /archive) and wait for a human to confirm. One file at a time, always recoverable, never a hard delete.",
  budgetMonthlyCents: 1000, // $10/mo, hard-stop on — staging archives is cheap
};

const FILER_ROUTING_ROW = {
  when: [
    "delete file",
    "delete the file",
    "delete that",
    "archive file",
    "archive the",
    "remove file",
    "remove the file",
    "trash",
    "get rid of",
    "clean up the drive",
  ],
  to: "@filer",
  description:
    "Archive (soft-delete) a file from the shared 00 Tethr workspace or the internal Drive. Always staged for your confirmation; never a hard delete.",
};

const FILER_SUBAGENT = {
  key: "archive",
  name: "Archive",
  job: "Turn a plain-language delete/archive request into exactly one staged file archive (via stage_file_archive) that waits for human confirmation.",
  routeWhen: ["delete", "archive", "remove", "trash", "get rid of"],
  notHere: [
    { phrase: "change an agent (rename, budget, pause)", to: "@tinkr" },
    { phrase: "just a question about a file", to: "@tethr.chat" },
  ],
  reads: ["The internal Drive (drive_list/drive_read)", "memory"],
  steps: [
    "Identify the exact file from the request (shared 00 Tethr path, or internal Drive path via drive_list)",
    "Stage the archive with stage_file_archive — exactly the file asked for, nothing more",
    "If the tool refuses (protected path, folder, not found, ambiguous), relay the reason plainly and ask for the exact filename",
    "Confirm to the requester that the archive is staged and waits for their approve/confirm — and that it stays recoverable",
  ],
  output: "One staged file archive awaiting human confirmation — never an applied one.",
  guardrails: [
    "Deletion is ALWAYS a soft archive — the file moves to an archive folder and is recoverable; never claim anything is destroyed",
    "Stage exactly the file that was asked — one file per request, never a folder, never a batch",
    "Nothing is archived without a human approval — say so in every confirmation",
    "If the path is ambiguous or not found, relay the validator's message and ask — never guess",
  ],
  doneWhen: "The archive is staged and the requester knows it awaits their confirmation (or why it can't be staged).",
  escalation: "Ambiguity about which file → ask in the thread; policy questions → @tethr routes to a human.",
  sensitivity: "destructive" as const,
  tools: ["stage_file_archive"],
};

export interface FilerSeedResult {
  created: boolean;
  agentId: string;
}

/** Idempotently ensure Filer exists, reporting to the CEO, routed from @tethr. */
export async function seedFilerAgent(db: Db, companyId: string): Promise<FilerSeedResult> {
  const [existing] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(
      and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, FILER_AGENT.tag)),
    )
    .limit(1);
  if (existing) return { created: false, agentId: existing.agentId };

  logger.info({ companyId }, "[tethr] seeding Filer (@filer), the file archivist");

  const [ceo] = await db
    .select()
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
    .limit(1);

  const [filer] = await db
    .insert(agents)
    .values({
      companyId,
      name: FILER_AGENT.codename,
      role: "general",
      title: FILER_AGENT.title,
      icon: "archive",
      status: "idle",
      reportsTo: ceo?.agentId ?? null,
      capabilities: FILER_AGENT.mission,
      adapterType: TETHR_ADAPTER_TYPE,
      adapterConfig: { agentTag: FILER_AGENT.tag, subagentChain: ["archive"] },
      budgetMonthlyCents: FILER_AGENT.budgetMonthlyCents,
    })
    .returning();

  await db.insert(tethrAgentProfiles).values({
    companyId,
    agentId: filer.id,
    divisionId: null,
    tag: FILER_AGENT.tag,
    codename: FILER_AGENT.codename,
    mission: FILER_AGENT.mission,
    approvalGate: "none", // its outputs carry the `destructive` sensitivity — always gated
    heartbeatNote: "On request — no schedule; the archivist works when asked.",
    routingTable: [],
    standingRules: CORE_STANDING_RULES,
  });

  await db.insert(tethrSubagents).values({
    companyId,
    agentId: filer.id,
    key: FILER_SUBAGENT.key,
    tag: `${FILER_AGENT.tag}.${FILER_SUBAGENT.key}`,
    name: FILER_SUBAGENT.name,
    job: FILER_SUBAGENT.job,
    routeWhen: FILER_SUBAGENT.routeWhen,
    notHere: FILER_SUBAGENT.notHere,
    reads: FILER_SUBAGENT.reads,
    steps: FILER_SUBAGENT.steps,
    output: FILER_SUBAGENT.output,
    guardrails: FILER_SUBAGENT.guardrails,
    doneWhen: FILER_SUBAGENT.doneWhen,
    escalation: FILER_SUBAGENT.escalation,
    sensitivity: FILER_SUBAGENT.sensitivity,
    tools: FILER_SUBAGENT.tools,
    sortOrder: 0,
  });

  await db.insert(budgetPolicies).values({
    companyId,
    scopeType: "agent",
    scopeId: filer.id,
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    amount: FILER_AGENT.budgetMonthlyCents,
    warnPercent: 80,
    hardStopEnabled: true,
    createdByUserId: "tethr-seed",
  });

  await addTethrRoutingRow(db, companyId, FILER_ROUTING_ROW);

  logger.info({ companyId, agentId: filer.id }, "[tethr] Filer seeded (on-request, no heartbeat)");
  return { created: true, agentId: filer.id };
}
