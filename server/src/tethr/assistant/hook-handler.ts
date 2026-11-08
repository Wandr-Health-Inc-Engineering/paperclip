import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { getIntegrations, modeFor } from "../integrations.js";
import type { HookTokenContext } from "./gate.js";
import { consumeGrant, createPendingAction, findPending, inputHash, recordOutcome, shortId } from "./grants.js";
import { classify, decide } from "./policy.js";
import { readableRoots, workspaceDir } from "./workspace.js";

// The approval gate's server side (phase 18). The hook script POSTs Claude Code's
// PreToolUse / PostToolUse payload here; we reply with what the script should
// print and its exit code. Pre: allow, deny, or hold for Mark (a card).

export interface HookReply {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

function preDecision(decision: "allow" | "deny", reason: string): HookReply {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    }),
  };
}

export async function handlePreToolUse(db: Db, ctx: HookTokenContext, payload: Record<string, unknown>): Promise<HookReply> {
  const toolName = String(payload.tool_name ?? "");
  const toolInput = (payload.tool_input ?? {}) as Record<string, unknown>;
  const cfg = getIntegrations(ctx.companyId);
  const c = classify(toolName, toolInput, {
    workspaceDir: workspaceDir().dir,
    readableRoots: readableRoots(),
    internalAddresses: cfg.internalAddresses,
  });
  const d = decide(c, { mode: modeFor(cfg, c.connector), shell: cfg.shell });

  if (d.action === "allow") {
    if (d.note === "auto") {
      await logActivity(db, {
        companyId: ctx.companyId,
        actorType: "agent",
        actorId: "@tethr",
        action: "tethr_action_auto",
        entityType: "tethr_route_run",
        entityId: ctx.runId,
        details: { tool: toolName, summary: c.summary, connector: c.connector },
      }).catch(() => {});
    }
    return preDecision("allow", "Allowed by Tethr.");
  }
  if (d.action === "deny") return preDecision("deny", d.reason);

  // Needs Mark: run it if he already approved this exact call, else hold it.
  const hash = inputHash(toolName, toolInput);
  const granted = await consumeGrant(db, ctx.companyId, ctx.threadId, hash);
  if (granted) {
    await logActivity(db, {
      companyId: ctx.companyId,
      actorType: "agent",
      actorId: "@tethr",
      action: "tethr_action_approved_run",
      entityType: "tethr_output",
      entityId: granted,
      details: { tool: toolName, summary: c.summary },
    }).catch(() => {});
    return preDecision("allow", "Approved by Mark.");
  }
  const pending = await findPending(db, ctx.companyId, ctx.threadId, hash);
  if (pending) {
    return preDecision(
      "deny",
      `Tethr approval gate: still waiting for Mark's approval (${shortId(pending.id)}) — ${c.summary}. Don't retry it; it runs once he approves.`,
    );
  }
  try {
    const card = await createPendingAction(db, { ...ctx, classified: c, toolName, toolInput, hash });
    return preDecision(
      "deny",
      `Tethr approval gate: sent to Mark for approval (${shortId(card.id)}) — ${c.summary}. It runs once he approves; don't retry it or work around it.`,
    );
  } catch {
    return preDecision("deny", `Tethr approval gate: couldn't create the approval for this, so it was not done — ${c.summary}.`);
  }
}

export async function handlePostToolUse(db: Db, ctx: HookTokenContext, payload: Record<string, unknown>): Promise<HookReply> {
  const toolName = String(payload.tool_name ?? "");
  if (toolName.startsWith("mcp__") || toolName === "Bash") {
    const hash = inputHash(toolName, payload.tool_input ?? {});
    await recordOutcome(db, ctx.companyId, ctx.threadId, hash).catch(() => {});
  }
  return { exitCode: 0 };
}
