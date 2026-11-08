import path from "node:path";
import type { TethrRouteHop } from "@paperclipai/db";
import { classify, type PolicyContext } from "./policy.js";

// Claude Code stream-json → chat turn state (phase 18). Pure: the runner feeds
// it each stdout line and writes the state to the turn's tethr_route_runs row.
// Raw tool results are never kept (they can hold customer data); only a status
// per tool call ("ok" / "failed" / "blocked").

export interface TurnState {
  text: string;
  hops: TethrRouteHop[];
  sessionId: string | null;
  /** MCP tool names seen this turn (calls + ToolSearch results), for discovery. */
  toolNames: Set<string>;
  resultText: string | null;
  resultIsError: boolean;
  /** Internal: did the current assistant message stream deltas? */
  deltaInMessage: boolean;
  /** Internal: a new message started after some text, so add a paragraph break. */
  pendingBreak: boolean;
}

export function newTurnState(): TurnState {
  return {
    text: "",
    hops: [],
    sessionId: null,
    toolNames: new Set(),
    resultText: null,
    resultIsError: false,
    deltaInMessage: false,
    pendingBreak: false,
  };
}

export interface EventContext {
  policy: PolicyContext;
  /** The 00 Tethr root, so file events are shown relative to it. */
  mirrorRoot: string | null;
  now?: () => string;
}

function appendText(state: TurnState, chunk: string) {
  if (!chunk) return;
  if (state.pendingBreak && state.text && !state.text.endsWith("\n\n")) {
    state.text = state.text.replace(/\s+$/, "") + "\n\n";
  }
  state.pendingBreak = false;
  state.text += chunk;
}

function relativeFile(file: string, ctx: EventContext): string {
  const abs = path.resolve(file);
  for (const root of [ctx.mirrorRoot, ctx.policy.workspaceDir]) {
    if (!root) continue;
    const r = path.resolve(root);
    if (abs.startsWith(r + path.sep)) return abs.slice(r.length + 1);
  }
  return path.basename(abs);
}

/** Apply one stream-json line. Returns true when something visible changed. */
export function applyStreamLine(state: TurnState, line: string, ctx: EventContext): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return false;
  }
  const now = ctx.now ?? (() => new Date().toISOString());
  // Ignore anything from inside a subagent; only the main conversation shows.
  if (ev.parent_tool_use_id) return false;

  switch (ev.type) {
    case "system": {
      if (ev.subtype === "init" && typeof ev.session_id === "string") state.sessionId = ev.session_id;
      return false;
    }
    case "stream_event": {
      const event = (ev.event ?? {}) as Record<string, unknown>;
      if (event.type === "message_start") {
        state.deltaInMessage = false;
        if (state.text) state.pendingBreak = true;
        return false;
      }
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      if (event.type === "content_block_delta" && delta.type === "text_delta" && typeof delta.text === "string") {
        state.deltaInMessage = true;
        appendText(state, delta.text);
        return true;
      }
      return false;
    }
    case "assistant": {
      const message = (ev.message ?? {}) as { content?: Array<Record<string, unknown>> };
      let changed = false;
      for (const block of message.content ?? []) {
        if (block.type === "text" && typeof block.text === "string" && !state.deltaInMessage) {
          appendText(state, block.text);
          changed = true;
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          const c = classify(block.name, input, ctx.policy);
          if (block.name.startsWith("mcp__")) state.toolNames.add(block.name);
          const hop: TethrRouteHop = {
            layer: "tool",
            actorTag: c.connector ?? "tethr",
            decision: c.summary,
            reason: "",
            at: now(),
            tool: block.name,
            toolUseId: typeof block.id === "string" ? block.id : undefined,
            status: "running",
          };
          if (["Write", "Edit", "MultiEdit"].includes(block.name) && typeof input.file_path === "string") {
            hop.file = relativeFile(input.file_path, ctx);
          }
          state.hops.push(hop);
          changed = true;
        }
      }
      // A finished message: the next one starts a new paragraph.
      if (state.text) state.pendingBreak = true;
      return changed;
    }
    case "user": {
      const message = (ev.message ?? {}) as { content?: Array<Record<string, unknown>> };
      let changed = false;
      for (const block of message.content ?? []) {
        if (block.type !== "tool_result") continue;
        const content = block.content;
        if (Array.isArray(content)) {
          for (const c of content as Array<Record<string, unknown>>) {
            if (c.type === "tool_reference" && typeof c.tool_name === "string" && c.tool_name.startsWith("mcp__")) {
              state.toolNames.add(c.tool_name);
            }
          }
        }
        const hop = state.hops.find((h) => h.toolUseId && h.toolUseId === block.tool_use_id);
        if (!hop) continue;
        const textOf = Array.isArray(content)
          ? (content as Array<Record<string, unknown>>).map((c) => (typeof c.text === "string" ? c.text : "")).join(" ")
          : String(content ?? "");
        hop.status = block.is_error ? (/Tethr approval gate:/.test(textOf) || /denied/i.test(textOf) ? "blocked" : "failed") : "ok";
        if (hop.status === "blocked") hop.reason = textOf.replace(/^.*?Tethr approval gate:\s*/s, "").slice(0, 300);
        changed = true;
      }
      return changed;
    }
    case "result": {
      state.resultText = typeof ev.result === "string" ? ev.result : null;
      state.resultIsError = ev.is_error === true;
      if (!state.text && state.resultText && !state.resultIsError) {
        appendText(state, state.resultText);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}
