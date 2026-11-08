import { describe, expect, it } from "vitest";
import { applyStreamLine, newTurnState } from "../tethr/assistant/events.js";

// Phase 18: Claude Code stream-json → chat turn state (pure).

const ctx = {
  policy: { workspaceDir: "/drive/00 Tethr/tethr", readableRoots: ["/drive/00 Tethr"], internalAddresses: ["travelwithwandr.com"] },
  mirrorRoot: "/drive/00 Tethr",
  now: () => "2026-11-07T00:00:00.000Z",
};
const line = (o: unknown) => JSON.stringify(o);
const delta = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } }, ...extra });

describe("tethr assistant events", () => {
  it("captures the session id and streams text deltas", () => {
    const s = newTurnState();
    applyStreamLine(s, line({ type: "system", subtype: "init", session_id: "sess-1" }), ctx);
    applyStreamLine(s, line({ type: "stream_event", event: { type: "message_start" } }), ctx);
    expect(applyStreamLine(s, delta("Hello "), ctx)).toBe(true);
    applyStreamLine(s, delta("Mark."), ctx);
    // The full assistant message after its deltas must not duplicate the text.
    applyStreamLine(s, line({ type: "assistant", message: { content: [{ type: "text", text: "Hello Mark." }] } }), ctx);
    expect(s.sessionId).toBe("sess-1");
    expect(s.text).toBe("Hello Mark.");
  });

  it("records tool calls as steps and their outcomes, keeping no raw results", () => {
    const s = newTurnState();
    applyStreamLine(
      s,
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Google_Calendar__list_events", input: {} }] },
      }),
      ctx,
    );
    expect(s.hops).toHaveLength(1);
    expect(s.hops[0]).toMatchObject({ layer: "tool", actorTag: "Google Calendar", tool: "mcp__claude_ai_Google_Calendar__list_events", status: "running" });
    applyStreamLine(s, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[{\"summary\":\"Lunch\"}]" }] } }), ctx);
    expect(s.hops[0].status).toBe("ok");
    expect(JSON.stringify(s.hops)).not.toContain("Lunch");
    expect([...s.toolNames]).toEqual(["mcp__claude_ai_Google_Calendar__list_events"]);
  });

  it("marks gate refusals as blocked with the reason", () => {
    const s = newTurnState();
    applyStreamLine(
      s,
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__claude_ai_Gmail__send_message", input: { to: ["x@gmail.com"] } }] } }),
      ctx,
    );
    applyStreamLine(
      s,
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "Tethr approval gate: waiting for approval in tethr — Email to x@gmail.com." }] }] },
      }),
      ctx,
    );
    expect(s.hops[0].status).toBe("blocked");
    expect(s.hops[0].reason).toBe("waiting for approval in tethr — Email to x@gmail.com.");
  });

  it("notes file writes relative to 00 Tethr and harvests ToolSearch results", () => {
    const s = newTurnState();
    applyStreamLine(
      s,
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "w", name: "Write", input: { file_path: "/drive/00 Tethr/tethr/files/plan.md", content: "x" } }] } }),
      ctx,
    );
    expect(s.hops[0].file).toBe("tethr/files/plan.md");
    applyStreamLine(
      s,
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "zz", content: [{ type: "tool_reference", tool_name: "mcp__claude_ai_Slack__slack_read_channel" }] }] } }),
      ctx,
    );
    expect(s.toolNames.has("mcp__claude_ai_Slack__slack_read_channel")).toBe(true);
  });

  it("ignores subagent traffic and falls back to the result text", () => {
    const s = newTurnState();
    expect(applyStreamLine(s, delta("inside a subagent", { parent_tool_use_id: "p1" }), ctx)).toBe(false);
    applyStreamLine(s, line({ type: "result", result: "Done.", is_error: false }), ctx);
    expect(s.text).toBe("Done.");
    const e = newTurnState();
    applyStreamLine(e, line({ type: "result", result: "Prompt is too long", is_error: true }), ctx);
    expect(e.text).toBe("");
    expect(e.resultIsError).toBe(true);
  });

  it("separates consecutive assistant messages with a paragraph break", () => {
    const s = newTurnState();
    applyStreamLine(s, line({ type: "stream_event", event: { type: "message_start" } }), ctx);
    applyStreamLine(s, delta("Let me check."), ctx);
    applyStreamLine(s, line({ type: "stream_event", event: { type: "message_start" } }), ctx);
    applyStreamLine(s, delta("Nothing tomorrow."), ctx);
    expect(s.text).toBe("Let me check.\n\nNothing tomorrow.");
  });

  it("tracks the latest model call's prompt size as the context size", () => {
    const s = newTurnState();
    applyStreamLine(s, line({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 20_000 } } } }), ctx);
    applyStreamLine(s, line({ type: "assistant", message: { content: [], usage: { input_tokens: 9, cache_read_input_tokens: 21_000, cache_creation_input_tokens: 400 } } }), ctx);
    expect(s.contextTokens).toBe(21_409);
  });
});
