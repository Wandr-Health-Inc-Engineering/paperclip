import { describe, expect, it } from "vitest";
import { classify, decide, isInternal, parseMcpTool, resolvesToPrivateHost, type PolicyContext } from "../tethr/assistant/policy.js";
import { selfApiUrl } from "../tethr/self-url.js";

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
    expect(gen.blockedReason).toMatch(/memory tool/);
    // Phase 25: Memory.md is a copy tethr writes; memories go through the memory tool.
    const copy = classify("Edit", { file_path: "/drive/00 Tethr/tethr/Memory.md" }, ctx);
    expect(copy.cls).toBe("blocked");
    expect(copy.blockedReason).toMatch(/memory tool/);
  });

  it("never lets the chat write Claude Code settings, hooks or instructions", () => {
    const ws = "/drive/00 Tethr/tethr";
    for (const p of [
      `${ws}/.claude/settings.json`,
      `${ws}/.claude/settings.local.json`,
      `${ws}/.mcp.json`,
      `${ws}/CLAUDE.local.md`,
      `${ws}/claude.md`, // case variant of the generated file (APFS is case-insensitive)
      `${ws}/files/notes/CLAUDE.md`,
      `${ws}/files/.hidden/x.md`,
      `${ws}/stray.md`, // outside files/
    ]) {
      expect(classify("Write", { file_path: p }, ctx).cls, p).toBe("blocked");
    }
    expect(classify("Write", { file_path: `${ws}/files/deep/plan.md` }, ctx).cls).toBe("workspace");
  });

  it("resolves relative paths against the session's folder, not the server's", () => {
    const withCwd = { ...ctx, cwd: "/drive/00 Tethr/tethr" };
    expect(classify("Read", { file_path: "Memory.md" }, withCwd).cls).toBe("builtin");
    expect(classify("Grep", { pattern: "x", path: "." }, withCwd).cls).toBe("builtin");
    expect(classify("Write", { file_path: "files/a.md" }, withCwd).cls).toBe("workspace");
    expect(classify("Read", { file_path: "../../../Users/mark/.ssh/id_rsa" }, withCwd).cls).toBe("blocked");
  });

  it("treats a Gmail reply as leaving Wandr unless every recipient is inside", () => {
    expect(classify(gmail("reply"), { message_id: "m1", body: "Thanks!" }, ctx).cls).toBe("public");
    expect(classify(gmail("forward"), { message_id: "m1", to: ["ops@travelwithwandr.com"] }, ctx).cls).toBe("write");
  });

  it("classifies deletes and overwrites as destructive (always ask)", () => {
    expect(classify("mcp__claude_ai_Google_Drive__trash_file", { file_id: "f" }, ctx).cls).toBe("destructive");
    expect(classify("mcp__claude_ai_Google_Drive__update_file", { file_id: "f" }, ctx).cls).toBe("destructive");
    expect(classify(gmail("trash_thread"), { thread_id: "t" }, ctx).cls).toBe("destructive");
    expect(classify("mcp__claude_ai_Google_Calendar__delete_event", { event_id: "e" }, ctx).cls).toBe("destructive");
    expect(classify("mcp__someserver__remove_contact", {}, ctx).cls).toBe("destructive");
    const d = classify("mcp__claude_ai_Google_Drive__trash_file", { file_id: "f" }, ctx);
    expect(decide(d, { mode: "auto", shell: "off" }).action).toBe("ask");
  });

  it("lets web pages through until the thread has read connector data", () => {
    const page = classify("WebFetch", { url: "https://example.com/x?d=1", prompt: "p" }, ctx);
    expect(page.cls).toBe("web");
    expect(decide(page, { mode: "ask", shell: "off" }).action).toBe("allow");
    expect(decide(page, { mode: "ask", shell: "off", tainted: true }).action).toBe("ask");
    const own = classify("WebFetch", { url: "https://www.travelwithwandr.com/a", prompt: "p" }, ctx);
    expect(decide(own, { mode: "ask", shell: "off", tainted: true }).action).toBe("allow");
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
    expect(classify(gmail("trash_thread"), { thread_id: "1" }, ctx).cls).toBe("destructive");
  });

  it("never sends a saved Gmail draft blind, and treats reply-all as leaving the company", () => {
    // Gmail ignores to/subject/body when draftId is set, so a card showing them would lie.
    const draftSend = classify(gmail("send_message"), { draftId: "r-123", to: ["mark@travelwithwandr.com"], subject: "Weekly notes", body: "benign" }, ctx);
    expect(draftSend.cls).toBe("blocked");
    expect(decide(draftSend, { mode: "auto", shell: "off" }).action).toBe("deny");
    expect(classify(gmail("send_message"), { draftId: "", to: ["mark@travelwithwandr.com"], subject: "Hi" }, ctx).cls).toBe("write");

    expect(classify(gmail("reply"), { messageId: "m1", to: ["mark@travelwithwandr.com"], body: "ok" }, ctx).cls).toBe("write");
    // cc and bcc only add people: the reply still goes to the original sender.
    expect(classify(gmail("reply"), { messageId: "m1", cc: ["alec@travelwithwandr.com"], body: "ok" }, ctx).cls).toBe("public");
    expect(classify(gmail("reply"), { messageId: "m1", to: [], bcc: ["alec@travelwithwandr.com"], body: "ok" }, ctx).cls).toBe("public");
    const replyAll = classify(gmail("reply"), { messageId: "m1", to: ["mark@travelwithwandr.com"], replyAll: true, body: "ok" }, ctx);
    expect(replyAll.cls).toBe("public");
    expect(decide(replyAll, { mode: "auto", shell: "off" }).action).toBe("ask");
    expect(classify(gmail("forward"), { messageId: "m1", forwardText: "fyi" }, ctx).cls).toBe("public");
  });

  it("counts every Calendar attendee field, and an RSVP note, as reaching people", () => {
    const cal = (n: string) => `mcp__claude_ai_Google_Calendar__${n}`;
    expect(classify(cal("update_event"), { eventId: "e1", addedAttendees: [{ email: "x@partner.com" }] }, ctx).cls).toBe("public");
    expect(classify(cal("update_event"), { eventId: "e1", addedAttendeeEmails: ["x@partner.com"] }, ctx).cls).toBe("public");
    expect(classify(cal("update_event"), { eventId: "e1", removedAttendeeEmails: ["x@partner.com"] }, ctx).cls).toBe("public");
    expect(classify(cal("create_event"), { summary: "Sync", attendeeEmails: ["x@partner.com"] }, ctx).cls).toBe("public");
    // A change guests see lands on their copy of the event, emailed or not, and the input doesn't say who they are.
    expect(classify(cal("update_event"), { eventId: "e1", description: "Q3 numbers" }, ctx).cls).toBe("public");
    expect(classify(cal("update_event"), { eventId: "e1", description: "Q3 numbers", notificationLevel: "NONE" }, ctx).cls).toBe("public");
    expect(classify(cal("update_event"), { eventId: "e1", startTime: "2026-11-09T10:00:00" }, ctx).cls).toBe("public");
    // The user's own color and reminders reach nobody.
    expect(classify(cal("update_event"), { eventId: "e1", colorId: "5" }, ctx).cls).toBe("write");
    expect(classify(cal("update_event"), { eventId: "e1", overrideReminders: [{ method: "popup", minutes: 10 }], useDefaultReminders: false }, ctx).cls).toBe("write");
    expect(classify(cal("update_event"), { eventId: "e1", addedAttendees: [{ email: "alec@travelwithwandr.com" }] }, ctx).cls).toBe("write");
    expect(classify(cal("create_event"), { summary: "Focus", startTime: "2026-11-09T09:00:00", endTime: "2026-11-09T10:00:00" }, ctx).cls).toBe("write");
    // Someone else's calendar is a recipient; the user's own calendars aren't.
    expect(classify(cal("create_event"), { summary: "Hold", calendarId: "partner@outside.com", startTime: "a", endTime: "b" }, ctx).cls).toBe("public");
    expect(classify(cal("create_event"), { summary: "Hold", calendarId: "alec@travelwithwandr.com", startTime: "a", endTime: "b" }, ctx).cls).toBe("write");
    expect(classify(cal("create_event"), { summary: "Hold", calendarId: "abc123@group.calendar.google.com", startTime: "a", endTime: "b" }, ctx).cls).toBe("write");
    expect(classify(cal("create_event"), { summary: "Hold", calendarId: "primary", startTime: "a", endTime: "b" }, ctx).cls).toBe("write");
    expect(classify(cal("respond_to_event"), { eventId: "e1", responseStatus: "accepted" }, ctx).cls).toBe("write");
    expect(classify(cal("respond_to_event"), { eventId: "e1", responseStatus: "declined", responseComment: "see notes" }, ctx).cls).toBe("public");
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
    expect(d.action === "ask" && d.reason).toMatch(/^Tethr approval gate: waiting for approval in tethr/);
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

describe("tethr assistant policy — names that resolve to this machine", () => {
  const lookup = (map: Record<string, string[]>) => async (h: string) => {
    if (!(h in map)) throw new Error("ENOTFOUND");
    return map[h].map((address) => ({ address }));
  };

  it("blocks a public-looking name that resolves to loopback or the LAN", async () => {
    const dns = lookup({ "127.0.0.1.nip.io": ["127.0.0.1"], "printer.example.com": ["192.168.1.20"], "travelwithwandr.com": ["104.21.3.4"], "mixed.example.com": ["8.8.8.8", "10.0.0.5"] });
    expect(await resolvesToPrivateHost("127.0.0.1.nip.io", dns)).toBe(true);
    expect(await resolvesToPrivateHost("printer.example.com", dns)).toBe(true);
    expect(await resolvesToPrivateHost("mixed.example.com", dns)).toBe(true);
    expect(await resolvesToPrivateHost("travelwithwandr.com", dns)).toBe(false);
  });

  it("judges literal addresses and local names without a lookup, and lets a failed lookup through", async () => {
    const never = async () => {
      throw new Error("should not look up");
    };
    expect(await resolvesToPrivateHost("localhost", never)).toBe(true);
    expect(await resolvesToPrivateHost("", never)).toBe(true);
    expect(await resolvesToPrivateHost("8.8.8.8", never)).toBe(false);
    expect(await resolvesToPrivateHost("nowhere.invalid", lookup({}))).toBe(false);
    const slow = () => new Promise<Array<{ address: string }>>(() => {});
    expect(await resolvesToPrivateHost("slow.example.com", slow, 20)).toBe(false);
  });
});

describe("selfApiUrl", () => {
  it("calls the server on its own loopback listener, never the public address", () => {
    expect(selfApiUrl({ PAPERCLIP_API_URL: "http://tunnel.example.dev:3100", PAPERCLIP_LISTEN_HOST: "127.0.0.1", PAPERCLIP_LISTEN_PORT: "3100" })).toBe("http://127.0.0.1:3100");
    expect(selfApiUrl({ PAPERCLIP_LISTEN_HOST: "0.0.0.0", PAPERCLIP_LISTEN_PORT: "8080" })).toBe("http://127.0.0.1:8080");
    expect(selfApiUrl({ PAPERCLIP_LISTEN_HOST: "::1", PAPERCLIP_LISTEN_PORT: "3100" })).toBe("http://[::1]:3100");
    expect(selfApiUrl({ PAPERCLIP_LISTEN_HOST: "100.64.1.2", PAPERCLIP_LISTEN_PORT: "3100" })).toBe("http://100.64.1.2:3100");
    expect(selfApiUrl({})).toBe("http://127.0.0.1:3100");
    expect(selfApiUrl({ TETHR_HOOK_URL: "http://127.0.0.1:4000/" })).toBe("http://127.0.0.1:4000");
  });
});
