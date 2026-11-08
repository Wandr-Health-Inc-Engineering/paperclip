import { describe, expect, it } from "vitest";
import { classify, decide, isInternal, parseMcpTool, type PolicyContext } from "../tethr/assistant/policy.js";

// Phase 18: the chat's approval gate policy (pure).

const ctx: PolicyContext = {
  workspaceDir: "/drive/00 Tethr/tethr",
  readableRoots: ["/drive/00 Tethr"],
  internalAddresses: ["travelwithwandr.com"],
};
const gmail = (name: string) => `mcp__claude_ai_Gmail__${name}`;

describe("tethr assistant policy — classify", () => {
  it("parses claude.ai connector tool names", () => {
    expect(parseMcpTool("mcp__claude_ai_Google_Calendar__list_events")).toEqual({
      server: "claude_ai_Google_Calendar",
      connector: "Google Calendar",
      name: "list_events",
    });
    expect(parseMcpTool("Read")).toBeNull();
  });

  it("lets built-in reads look only inside 00 Tethr", () => {
    expect(classify("Read", { file_path: "/drive/00 Tethr/02 Documents/a.md" }, ctx).cls).toBe("builtin");
    const outside = classify("Read", { file_path: "/Users/mark/.ssh/id_rsa" }, ctx);
    expect(outside.cls).toBe("blocked");
    expect(outside.blockedReason).toMatch(/outside/);
    expect(classify("ToolSearch", { query: "gmail" }, ctx).cls).toBe("builtin");
  });

  it("confines writes to the workspace and protects the generated CLAUDE.md", () => {
    expect(classify("Write", { file_path: "/drive/00 Tethr/tethr/files/plan.md" }, ctx).cls).toBe("workspace");
    expect(classify("Write", { file_path: "/drive/00 Tethr/02 Documents/x.md" }, ctx).cls).toBe("blocked");
    expect(classify("Write", { file_path: "/Users/mark/Desktop/x.md" }, ctx).cls).toBe("blocked");
    const gen = classify("Edit", { file_path: "/drive/00 Tethr/tethr/CLAUDE.md" }, ctx);
    expect(gen.cls).toBe("blocked");
    expect(gen.blockedReason).toMatch(/Memory\.md/);
    expect(classify("Edit", { file_path: "/drive/00 Tethr/tethr/Memory.md" }, ctx).cls).toBe("workspace");
  });

  it("treats the shell and unknown built-ins separately", () => {
    expect(classify("Bash", { command: "ls" }, ctx).cls).toBe("shell");
    expect(classify("CronCreate", {}, ctx).cls).toBe("blocked");
  });

  it("classifies Gmail: reads, drafts, sends, outsiders, medical", () => {
    expect(classify(gmail("search_threads"), { query: "invoice" }, ctx).cls).toBe("read");
    expect(classify(gmail("create_draft"), { to: ["a@gmail.com"], subject: "Hi" }, ctx).cls).toBe("draft");
    expect(classify(gmail("send_message"), { to: ["mark@travelwithwandr.com"], subject: "Hi", body: "x" }, ctx).cls).toBe("write");
    const outside = classify(gmail("send_message"), { to: ["someone@gmail.com"], subject: "Hi", body: "x" }, ctx);
    expect(outside.cls).toBe("public");
    expect(outside.summary).toBe("Email to someone@gmail.com — “Hi”");
    expect(classify(gmail("send_message"), { to: ["mark@travelwithwandr.com"], body: "her dosage is 250mg" }, ctx).cls).toBe("medical");
    expect(classify(gmail("trash_thread"), { thread_id: "1" }, ctx).cls).toBe("write");
  });

  it("classifies money, calendar, PostHog and unknown connectors", () => {
    expect(classify("mcp__claude_ai_Stripe__stripe_api_read", {}, ctx).cls).toBe("read");
    expect(classify("mcp__claude_ai_Stripe__stripe_api_write", {}, ctx).cls).toBe("money");
    expect(classify("mcp__claude_ai_Mercury__getAccounts", {}, ctx).cls).toBe("money");
    expect(classify("mcp__claude_ai_Google_Calendar__list_events", {}, ctx).cls).toBe("read");
    expect(
      classify("mcp__claude_ai_Google_Calendar__create_event", { summary: "Sync", attendees: [{ email: "x@partner.com" }] }, ctx).cls,
    ).toBe("public");
    expect(classify("mcp__claude_ai_Google_Drive__share_file", {}, ctx).cls).toBe("public");
    expect(classify("mcp__claude_ai_PostHog__exec", { command: "query SELECT 1" }, ctx).cls).toBe("read");
    expect(classify("mcp__claude_ai_PostHog__exec", { command: "feature-flag create x" }, ctx).cls).toBe("write");
    expect(classify("mcp__claude_ai_Notion__search_pages", {}, ctx).cls).toBe("read");
    expect(classify("mcp__claude_ai_Notion__create_page", {}, ctx).cls).toBe("write");
  });

  it("matches internal addresses by domain or exact address", () => {
    expect(isInternal("Mark@TravelWithWandr.com", ["travelwithwandr.com"])).toBe(true);
    expect(isInternal("a@b.com", ["@travelwithwandr.com", "a@b.com"])).toBe(true);
    expect(isInternal("evil@travelwithwandr.com.attacker.io", ["travelwithwandr.com"])).toBe(false);
  });
});

describe("tethr assistant policy — decide", () => {
  const send = classify(gmail("send_message"), { to: ["mark@travelwithwandr.com"], subject: "Hi" }, ctx);
  const read = classify(gmail("search_threads"), {}, ctx);
  const draft = classify(gmail("create_draft"), { to: ["mark@travelwithwandr.com"] }, ctx);
  const money = classify("mcp__claude_ai_Stripe__stripe_api_write", {}, ctx);
  const external = classify(gmail("send_message"), { to: ["x@gmail.com"] }, ctx);

  it("off denies everything; read allows reads only", () => {
    expect(decide(read, { mode: "off", shell: "off" }).action).toBe("deny");
    expect(decide(read, { mode: "read", shell: "off" }).action).toBe("allow");
    expect(decide(draft, { mode: "read", shell: "off" }).action).toBe("deny");
    expect(decide(send, { mode: "read", shell: "off" }).action).toBe("deny");
  });

  it("ask allows reads and drafts and asks for the rest", () => {
    expect(decide(draft, { mode: "ask", shell: "off" }).action).toBe("allow");
    const d = decide(send, { mode: "ask", shell: "off" });
    expect(d.action).toBe("ask");
    expect(d.action === "ask" && d.reason).toMatch(/^Tethr approval gate: waiting for Mark's approval/);
  });

  it("auto allows plain writes but always asks for money, outsiders and medical", () => {
    expect(decide(send, { mode: "auto", shell: "off" })).toEqual({ action: "allow", note: "auto" });
    expect(decide(money, { mode: "auto", shell: "off" }).action).toBe("ask");
    expect(decide(external, { mode: "auto", shell: "off" }).action).toBe("ask");
  });

  it("gates the shell by its own mode and denies blocked built-ins", () => {
    const sh = classify("Bash", { command: "rm -rf /" }, ctx);
    expect(decide(sh, { mode: "auto", shell: "off" }).action).toBe("deny");
    expect(decide(sh, { mode: "auto", shell: "ask" }).action).toBe("ask");
    const blocked = classify("Write", { file_path: "/tmp/x" }, ctx);
    const d = decide(blocked, { mode: "auto", shell: "ask" });
    expect(d.action).toBe("deny");
    expect(d.action === "deny" && d.reason).toMatch(/workspace/);
  });
});
