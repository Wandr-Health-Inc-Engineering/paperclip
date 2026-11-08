import type { Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { isTainted, markTainted } from "../chats.js";
import { getIntegrations, modeFor } from "../integrations.js";
import type { HookTokenContext } from "./gate.js";
import { canonicalJson, consumeGrant, createPendingAction, findPending, inputHash, MAX_APPROVAL_INPUT_CHARS, recordFailure, recordOutcome, shortId } from "./grants.js";
import { classify, decide, resolvesToPrivateHost } from "./policy.js";
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
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : undefined,
  });
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
  const d = decide(c, { mode: modeFor(cfg, c.connector), shell: cfg.shell, tainted: isTainted(ctx.companyId, ctx.threadId) });

  if (d.action === "allow") {
    // Once a thread's session has seen connector data, web pages outside Wandr
    // need approval for the rest of that session (a URL can carry data out).
    // Tethr's own tools bring in no private data, so they don't count.
    if (c.connector && c.server !== "tethr") await markTainted(ctx.companyId, ctx.threadId).catch(() => {});
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
  if (canonicalJson(toolInput).length > MAX_APPROVAL_INPUT_CHARS) {
    return preDecision(
      "deny",
      `Tethr approval gate: too long to review on an approval card, so it was not done — ${c.summary}. Make it shorter or split it up.`,
    );
  }
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
    const card = await createPendingAction(db, { ...ctx, classified: c, toolName, toolInput, hash });
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
    const record = responseFailed(payload.tool_response) ? recordFailure : recordOutcome;
    await record(db, ctx.companyId, ctx.threadId, hash).catch(() => {});
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
