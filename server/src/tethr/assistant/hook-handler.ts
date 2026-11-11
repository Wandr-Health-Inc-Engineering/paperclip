import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { isTainted, markTainted } from "../chats.js";
import { autonomyFor, getIntegrations, modeFor } from "../integrations.js";
import { effectiveSettings, settingsOwner } from "../agent-settings.js";
import { spendAdapterFor } from "../spend/adapters.js";
import { checkSpend, type SpendCheck } from "../spend/guard.js";
import { recordChange, recordChangeOutcome } from "../spend/log.js";
import type { HookTokenContext } from "./gate.js";
import { canonicalJson, consumeGrant, createPendingAction, findPending, inputHash, MAX_APPROVAL_INPUT_CHARS, recordFailure, recordOutcome, shortId } from "./grants.js";
import { classify, decide, resolvesToPrivateHost } from "./policy.js";
import { agentToolRefusal } from "../team-spec.js";
import { sealedThreadTag } from "../learn/learner.js";
import { roomDir } from "../learn/rooms.js";
import { sandboxRefusal } from "./sandbox.js";
import { teamService } from "../team.js";
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
  // Phase 23: in an agent's thread, only its own connectors (and never the
  // shell or tethr's team tools). The turn's deny rules say the same; this is
  // the gate's own check.
  let member: Awaited<ReturnType<ReturnType<typeof teamService>["byThread"]>>;
  try {
    member = await teamService(db).byThread(ctx.companyId, ctx.threadId);
  } catch {
    // An agent's limits can't be checked, so nothing runs (never fall back to tethr's own rights).
    return preDecision("deny", "Tethr approval gate: couldn't check whose chat this is, so this was not done. Try again.");
  }
  // Phase 26.6: a sandboxed agent reads and writes only its own sealed folder.
  // The learner's chat with no agent behind it (deleted) gets nothing at all.
  if (!member && sealedThreadTag(ctx.companyId, ctx.threadId)) {
    return preDecision("deny", "Tethr approval gate: blocked. The learner isn't on the team any more, so nothing runs in its chat.");
  }
  // The learner works in one room per turn (desk for a person's message): only that room's tools and folder.
  const room = member?.sandbox ? (ctx.room ?? "desk") : null;
  const sealed = member && room ? roomDir(member.tag, room) : null;
  if (member && room) {
    const refusal = sandboxRefusal(member.tag, toolName, room);
    if (refusal) return preDecision("deny", refusal);
  }
  let c = classify(toolName, toolInput, {
    workspaceDir: sealed ?? workspaceDir().dir,
    readableRoots: sealed ? [sealed] : readableRoots(),
    internalAddresses: cfg.internalAddresses,
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : undefined,
  });
  if (member) {
    const refusal = agentToolRefusal(member, toolName, c.connector);
    if (refusal) return preDecision("deny", refusal);
  }
  // A web page whose name resolves to this Mac or its network is blocked like
  // a literal localhost address (tethr answers loopback requests as Mark).
  if (c.cls === "web") {
    let host = "";
    try {
      host = new URL(String(toolInput.url ?? "")).hostname.replace(/^\[|\]$/g, "");
    } catch {
      host = "";
    }
    if (await resolvesToPrivateHost(host)) {
      return preDecision("deny", "Tethr approval gate: blocked — the chat can't open pages on this computer or its local network.");
    }
  }
  // An agent goes by its own settings (a sub-agent by its lead's); tethr by Integrations.
  const lead = member?.leadTag ? await teamService(db).get(ctx.companyId, member.leadTag).catch(() => null) : null;
  const { mode, autonomy } = member ? effectiveSettings(cfg, settingsOwner(member, lead), c.connector) : { mode: modeFor(cfg, c.connector), autonomy: autonomyFor(cfg, c.connector) };
  // Spending: whether this call spends more (an account tethr can read knows a
  // budget cut isn't), and whether it stays under the cap that applies.
  let spend: SpendCheck | null = null;
  if (c.connector && (mode === "auto" || mode === "ask") && (c.cls === "money" || (c.cls === "write" && spendAdapterFor(c.connector)))) {
    spend = await checkSpend(ctx.companyId, c, toolInput, autonomy);
    c = spend.classified;
  }
  // The learner's research room holds nothing private, so a taint on its chat doesn't hold back its pages.
  const tainted = room === "research" ? false : isTainted(ctx.companyId, ctx.threadId);
  const d = decide(c, { mode, shell: cfg.shell, tainted, autonomy, withinCap: spend?.withinCap, spendNote: spend?.spendNote });
  // What a connector did is logged here; tethr's own tools are logged where they run (the tools endpoint).
  const logsHere = !!c.connector && c.server !== "tethr" && c.cls !== "read" && c.cls !== "draft";

  if (d.action === "allow") {
    // Once a thread's session has seen connector data, web pages outside Wandr
    // need approval for the rest of that session (a URL can carry data out).
    // Tethr's own tools bring in no private data, so they don't count, except
    // recall: past answers can quote what a connector returned (phase 25).
    if ((c.connector && c.server !== "tethr") || toolName === "mcp__tethr__recall") {
      await markTainted(ctx.companyId, ctx.threadId).catch(() => {});
    }
    if (d.note === "auto") {
      if (logsHere) {
        await recordChange(ctx.companyId, {
          connector: c.connector!,
          tool: toolName,
          summary: c.summary,
          cls: c.cls,
          how: "auto",
          by: member?.tag ?? "@tethr",
          amount: spend?.amount ?? null,
          hash: inputHash(toolName, toolInput),
          ok: null,
        }).catch(() => {});
      }
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
  if (canonicalJson(toolInput).length > MAX_APPROVAL_INPUT_CHARS) {
    return preDecision(
      "deny",
      `Tethr approval gate: too long to review on an approval card, so it was not done — ${c.summary}. Make it shorter or split it up.`,
    );
  }
  const hash = inputHash(toolName, toolInput);
  const granted = await consumeGrant(db, ctx.companyId, ctx.threadId, hash);
  if (granted) {
    if (logsHere) {
      await recordChange(ctx.companyId, {
        connector: c.connector!,
        tool: toolName,
        summary: c.summary,
        cls: c.cls,
        how: "approved",
        by: member?.tag ?? "@tethr",
        amount: spend?.amount ?? null,
        hash,
        ok: null,
      }).catch(() => {});
    }
    await logActivity(db, {
      companyId: ctx.companyId,
      actorType: "agent",
      actorId: "@tethr",
      action: "tethr_action_approved_run",
      entityType: "tethr_output",
      entityId: granted,
      details: { tool: toolName, summary: c.summary },
    }).catch(() => {});
    return preDecision("allow", "Approved in tethr.");
  }
  const pending = await findPending(db, ctx.companyId, ctx.threadId, hash);
  if (pending) {
    return preDecision(
      "deny",
      `Tethr approval gate: still waiting for approval in tethr (${shortId(pending.id)}) — ${c.summary}. Don't retry it; it runs once it's approved.`,
    );
  }
  try {
    const card = await createPendingAction(db, {
      ...ctx,
      classified: c,
      toolName,
      toolInput,
      hash,
      note: spend?.spendNote ?? null,
      ...(member ? { actor: { agentId: member.agentId, tag: member.tag } } : {}),
    });
    return preDecision(
      "deny",
      `Tethr approval gate: sent for approval in tethr (${shortId(card.id)}) — ${c.summary}. It runs once it's approved; don't retry it or work around it.`,
    );
  } catch {
    return preDecision("deny", `Tethr approval gate: couldn't create the approval for this, so it was not done — ${c.summary}.`);
  }
}

export async function handlePostToolUse(db: Db, ctx: HookTokenContext, payload: Record<string, unknown>): Promise<HookReply> {
  const toolName = String(payload.tool_name ?? "");
  if (toolName.startsWith("mcp__") || toolName === "Bash" || toolName === "WebFetch") {
    const hash = inputHash(toolName, payload.tool_input ?? {});
    // An approved call that came back with an error is NOT marked sent.
    const failed = responseFailed(payload.tool_response);
    const record = failed ? recordFailure : recordOutcome;
    await record(db, ctx.companyId, ctx.threadId, hash).catch(() => {});
    await recordChangeOutcome(ctx.companyId, hash, !failed).catch(() => {});
  }
  return { exitCode: 0 };
}

/** Did a tool come back with an error? (MCP results flag isError; some tools
 * return an { error } object.) */
export function responseFailed(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  if (Array.isArray(response)) return response.some((r) => responseFailed(r));
  const r = response as Record<string, unknown>;
  return r.isError === true || r.is_error === true || (r.error !== undefined && r.error !== null && r.error !== false);
}
