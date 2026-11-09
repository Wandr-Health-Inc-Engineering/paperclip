import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrMembers, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { resolveHookToken } from "../tethr/assistant/gate.ts";
import { handlePreToolUse } from "../tethr/assistant/hook-handler.ts";
import * as chats from "../tethr/chats.ts";
import { interpretSlackEvent, routeInboundKickoff } from "../tethr/slack.ts";
import { saveSlackFiles, setSlackChatPosterForTests, slackReplyTargetOf } from "../tethr/slack-chat.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 26.1: one brain behind every door. An admin in Slack reaches the chat
// brain (a DM is the main chat, a channel thread its own side chat) and the
// answer comes back where it was asked; anyone else keeps the classic engine.
// The terminal client and the bell reach the chat brain too.

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const ADMIN = "UADMIN01";
const OTHER = "UOTHER02";

describe("Slack files", () => {
  it("takes every file type Slack sends, and keeps images for the classic engine", () => {
    const interp = interpretSlackEvent({
      type: "event_callback",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: ADMIN,
        ts: "1.1",
        text: "file these",
        files: [
          { name: "invoice.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/a/invoice.pdf", size: 2000 },
          { name: "photo.heic", mimetype: "image/heic", url_private: "https://files.slack.com/a/photo.heic" },
        ],
      },
    });
    expect(interp).toMatchObject({ type: "kickoff", isDM: true, userId: ADMIN });
    if (interp.type !== "kickoff") throw new Error("not a kickoff");
    expect(interp.files?.map((f) => f.name)).toEqual(["invoice.pdf", "photo.heic"]);
    expect(interp.images?.map((i) => i.name)).toEqual(["photo.heic"]);
  });

  it("reads a stored reply target back only when it's whole", () => {
    expect(slackReplyTargetOf({ channel: "C1", threadTs: "1.1", dm: false, askedBy: ADMIN })).toEqual({ channel: "C1", threadTs: "1.1", dm: false, askedBy: ADMIN });
    expect(slackReplyTargetOf({ channel: "C1" })).toBeUndefined();
    expect(slackReplyTargetOf("C1")).toBeUndefined();
  });
});

describePg("Slack and the terminal reach the chat brain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir!: string;
  let companyId!: string;
  const posts: Array<{ channel?: string; threadTs?: string; text: string }> = [];
  /** What the next fake turn does before answering. */
  let during: ((ctx: AdapterExecutionContext) => Promise<void>) | null = null;
  let answer = "Partner payouts go out on the 15th.";
  let savedAnthropicKey: string | undefined;

  const execute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    if (during) await during(ctx);
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: answer, is_error: false, session_id: "s1" }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s1", summary: answer };
  };

  async function settle(runId: string) {
    for (let i = 0; i < 300; i++) {
      const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
      if (row && ["done", "failed", "stopped"].includes(row.status)) {
        await new Promise((r) => setTimeout(r, 50)); // the answer is posted right after
        return row;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("turn never finished");
  }

  const dm = (text: string, user = ADMIN, extra: Record<string, unknown> = {}) => ({
    requestText: text,
    channel: "D1",
    threadTs: `${Date.now()}.1`,
    isDM: true,
    userId: user,
    ...extra,
  });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-slack-chat-"));
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    process.env.TETHR_MEMORY_FILE = path.join(dir, "memory.json");
    // The classic engine (for non-admins) must use the offline mock, never a key in the shell.
    savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-slack-chat-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    await db.insert(tethrMembers).values({ companyId, name: "Mark Karam", email: "mark@example.test", role: "admin", slackUserId: ADMIN });
    setSlackChatPosterForTests(async (p) => {
      posts.push(p);
      return { ok: true };
    });
  }, 60_000);

  afterAll(async () => {
    if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    setSlackChatPosterForTests(null);
    resetAssistantRunnerForTests();
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ["TETHR_CHATS_FILE", "TETHR_INTEGRATIONS_FILE", "TETHR_PAUSED_FILE", "TETHR_ASSISTANT_HOME", "TETHR_WORKSPACE_DIR", "TETHR_MEMORY_FILE"]) delete process.env[k];
  });

  beforeEach(() => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute }));
    posts.length = 0;
    during = null;
    answer = "Partner payouts go out on the 15th.";
  });

  it("an admin's DM is the main chat, and the answer comes back in the DM", async () => {
    const msg = dm("When do partner payouts go out?");
    const ids = await routeInboundKickoff(db, msg);
    expect(ids?.threadId).toBe(companyId);
    const row = await settle(ids!.routeRunId);
    expect(row).toMatchObject({ invocationSource: "chat", threadId: companyId, requestText: "When do partner payouts go out?" });
    expect(posts).toEqual([{ channel: "D1", threadTs: msg.threadTs, text: "Partner payouts go out on the 15th." }]);
  });

  it("anyone else in Slack keeps the classic engine", async () => {
    const ids = await routeInboundKickoff(db, dm("When do partner payouts go out?", OTHER, { channel: "D2" }));
    let row: typeof tethrRouteRuns.$inferSelect | undefined;
    for (let i = 0; i < 200; i++) {
      [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, ids!.routeRunId));
      if (row && !["queued", "routing", "working", "running"].includes(row.status)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(row!.invocationSource).toBe("api");
    expect(row!.llmProvider ?? "mock").not.toMatch(/^claude/); // offline: the mock answered
    expect(posts).toEqual([]);
  });

  it("a channel thread gets its own side chat, the same one for every reply in it", async () => {
    const base = { channel: "C9", threadTs: "1700.9", isDM: false, userId: ADMIN };
    const first = await routeInboundKickoff(db, { ...base, requestText: "Draft the partner FAQ" });
    await settle(first!.routeRunId);
    expect(first!.threadId).not.toBe(companyId);
    expect(chats.listSideChats(companyId).find((c) => c.threadId === first!.threadId)?.title).toBe("Slack: Draft the partner FAQ");
    const second = await routeInboundKickoff(db, { ...base, requestText: "Make it shorter" });
    await settle(second!.routeRunId);
    expect(second!.threadId).toBe(first!.threadId);
    expect(posts.every((p) => p.channel === "C9" && p.threadTs === "1700.9")).toBe(true);
  });

  it("in a channel, an answer from a chat that read connector data goes to the asker privately", async () => {
    const base = { channel: "C7", threadTs: "1700.7", isDM: false, userId: ADMIN };
    // The turn reads Gmail (allowed), which marks the chat as holding connector data.
    during = async (ctx) => {
      const token = resolveHookToken((ctx.config.env as Record<string, string>).TETHR_HOOK_TOKEN)!;
      await handlePreToolUse(db, token, { tool_name: "mcp__claude_ai_Gmail__search_threads", tool_input: { query: "refund" } });
    };
    answer = "Jane at Lakeside asked for a refund on order 1042.";
    const ids = await routeInboundKickoff(db, { ...base, requestText: "Any refund emails?" });
    await settle(ids!.routeRunId);
    expect(posts).toEqual([
      { channel: "C7", threadTs: "1700.7", text: "This answer uses data from your connected tools, so I sent it to you directly." },
      { channel: ADMIN, text: "Jane at Lakeside asked for a refund on order 1042." },
    ]);
  });

  it("an approval asked from Slack is decided there, and the result comes back there", async () => {
    const msg = dm("Email the partner FAQ to jane@lakeside.example");
    // The turn tries to send an email outside the company: the gate holds it as a card.
    during = async (ctx) => {
      if (String(ctx.context.tethrPrompt).includes("Approved in tethr")) return; // the follow-up after approval
      const token = resolveHookToken((ctx.config.env as Record<string, string>).TETHR_HOOK_TOKEN)!;
      const reply = await handlePreToolUse(db, token, {
        tool_name: "mcp__claude_ai_Gmail__send_message",
        tool_input: { to: ["jane@lakeside.example"], subject: "Partner FAQ", body: "Here it is." },
      });
      expect(reply.stdout).toMatch(/sent for approval/);
    };
    answer = "I've drafted it; the send is waiting for your approval.";
    const ids = await routeInboundKickoff(db, msg);
    await settle(ids!.routeRunId);
    const [card] = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.routeRunId, ids!.routeRunId), eq(tethrOutputs.kind, "external_action")));
    expect(card!.status).toBe("gated");
    expect((card!.meta as Record<string, unknown>).slack).toEqual({ channel: "D1", threadTs: msg.threadTs, dm: true, askedBy: ADMIN });
    expect(posts.at(-1)!.text).toMatch(/^Waiting for your approval: \*.*\*\. Reply \*approve\* or \*reject\* here/);

    // "approve" in the DM decides it; the follow-up turn's result is posted to the same place.
    posts.length = 0;
    answer = "Sent the partner FAQ to Jane.";
    const decided = await routeInboundKickoff(db, dm("approve", ADMIN, { threadTs: "1800.1" }));
    expect(decided).toBeNull();
    expect(posts[0]!.text).toMatch(/^Approved: .*Running it now/);
    const [approved] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, card!.id));
    expect(approved!.status).toBe("approved");
    for (let i = 0; i < 200 && !posts.some((p) => p.text === "Sent the partner FAQ to Jane."); i++) await new Promise((r) => setTimeout(r, 25));
    expect(posts.find((p) => p.text === "Sent the partner FAQ to Jane.")).toEqual({ channel: "D1", threadTs: msg.threadTs, text: "Sent the partner FAQ to Jane." });
  });

  it("files sent in Slack are saved like chat attachments; ones the chat can't read are named", async () => {
    const download = async (f: { name: string }) => Buffer.from(f.name.endsWith(".exe") ? "MZ" : "# Q3 plan\n- grow partners\n");
    const saved = await saveSlackFiles(
      [
        { url: "https://files.slack.com/a/plan.md", name: "plan.md", mimeType: "text/markdown" },
        { url: "https://files.slack.com/a/setup.exe", name: "setup.exe", mimeType: "application/octet-stream" },
      ],
      download,
    );
    expect(saved.paths).toEqual([expect.stringMatching(/^files\/uploads\/\d{4}-\d{2}-\d{2}\/plan\.md$/)]);
    expect(saved.skipped).toEqual([{ name: "setup.exe", why: expect.stringMatching(/reads images, PDFs/) }]);
    expect(fs.readFileSync(path.join(dir, "workspace", saved.paths[0]!), "utf8")).toContain("grow partners");
  });

  it("the terminal client and the bell reach the chat brain; an agent's key keeps the classic engine", async () => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const appFor = (actor: Record<string, unknown>) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", tethrRoutes(db));
      return app;
    };
    const person = appFor({ type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true });
    const fresh = await request(person).post(`/api/tethr/${companyId}/route`).send({ request: "What's on this week?" }).expect(200);
    const row = await settle(fresh.body.routeRunId);
    expect(row.invocationSource).toBe("chat");
    expect(chats.listSideChats(companyId).some((c) => c.threadId === fresh.body.threadId && c.title === "What's on this week?")).toBe(true);
    const main = await request(person).post(`/api/tethr/${companyId}/route`).send({ request: "And next week?", threadId: companyId }).expect(200);
    expect(main.body.threadId).toBe(companyId);
    await settle(main.body.routeRunId);
    await request(person).post(`/api/tethr/${companyId}/route`).send({ request: "x", threadId: "not-a-chat" }).expect(400);

    const agent = appFor({ type: "agent", agentId: "a1", companyId });
    const classic = await request(agent).post(`/api/tethr/${companyId}/route`).send({ request: "What's on this week?" });
    if (classic.status === 200) {
      const [c] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, classic.body.routeRunId));
      expect(c!.invocationSource).toBe("console");
    } else {
      expect(classic.status).toBe(403);
    }
  });
});
