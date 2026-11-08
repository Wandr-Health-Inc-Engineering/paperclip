import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { costEvents, createDb, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { getSession } from "../tethr/chats.ts";
import { setThrottle } from "../tethr/throttle.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 18: the chat runner — one Claude Code session per thread, driven through
// the claude-local adapter's execute() (faked here; no model is called).

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const line = (o: unknown) => JSON.stringify(o) + "\n";

describePg("tethr assistant runner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir!: string;
  let companyId!: string;
  const calls: AdapterExecutionContext[] = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    calls.push(ctx);
    const sessionId = (ctx.runtime.sessionId as string | null) ?? `sess-${calls.length}`;
    await ctx.onLog("stdout", line({ type: "system", subtype: "init", session_id: sessionId }));
    await ctx.onLog(
      "stdout",
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Google_Calendar__list_events", input: {} }] } }),
    );
    await ctx.onLog("stdout", line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] } }));
    // The latest model call's prompt size (what rotation should look at).
    await ctx.onLog(
      "stdout",
      line({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 3000 } } } }),
    );
    await ctx.onLog("stdout", line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Your calendar " } } }));
    await ctx.onLog("stdout", line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "is empty." } } }));
    await ctx.onLog("stdout", line({ type: "result", result: "Your calendar is empty.", is_error: false, session_id: sessionId }));
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId,
      sessionParams: { sessionId, cwd: String(ctx.config.cwd) },
      // Summed over every call in the turn: must NOT be read as the context size.
      usage: { inputTokens: 12, cachedInputTokens: 180_000, outputTokens: 8 },
      model: "claude-sonnet-5",
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription",
      costUsd: 0.02,
      summary: "Your calendar is empty.",
    };
  };

  async function waitDone(runId: string) {
    for (let i = 0; i < 200; i++) {
      const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
      if (row && ["done", "failed", "stopped"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("turn never finished");
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-assistant-"));
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    delete process.env.ANTHROPIC_API_KEY;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-assistant-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ["TETHR_CHATS_FILE", "TETHR_INTEGRATIONS_FILE", "TETHR_PAUSED_FILE", "TETHR_ASSISTANT_HOME", "TETHR_WORKSPACE_DIR"]) {
      delete process.env[k];
    }
  });

  beforeEach(() => {
    resetAssistantRunnerForTests();
    calls.length = 0;
  });

  it("runs a turn: streamed text and steps land on the row, session saved", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId, threadId } = await runner.send({ companyId, threadId: companyId, text: "What's on tomorrow?" });
    expect(threadId).toBe(companyId);
    const row = await waitDone(routeRunId);
    expect(row.status).toBe("done");
    expect(row.invocationSource).toBe("chat");
    expect(row.resultText).toBe("Your calendar is empty.");
    expect(row.hops).toHaveLength(1);
    expect(row.hops[0]).toMatchObject({ actorTag: "Google Calendar", status: "ok" });
    expect(row.llmProvider).toBe("claude-code:claude-sonnet-5");

    const ctx = calls[0];
    expect(ctx.config.promptTemplate).toBe("{{context.tethrPrompt}}");
    expect(ctx.context.tethrPrompt).toBe("What's on tomorrow?");
    expect(ctx.config.dangerouslySkipPermissions).toBe(false);
    const args = ctx.config.extraArgs as string[];
    expect(args).toEqual(expect.arrayContaining(["--settings", "--permission-mode", "dontAsk", "--include-partial-messages", "--tools"]));
    expect(args[args.indexOf("--tools") + 1]).not.toContain("Bash");
    const env = ctx.config.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.MCP_CONNECTION_NONBLOCKING).toBe("false");
    expect(env.TETHR_HOOK_TOKEN).toBeTruthy();

    // The generated workspace + memory + per-turn settings with the gate hooks.
    expect(fs.existsSync(path.join(dir, "workspace", "Memory.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "workspace", "CLAUDE.md"), "utf8")).toContain("@Memory.md");
    const settings = JSON.parse(fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["mcp__claude_ai_Mercury", "mcp__posthog"]));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("pre");

    // Context = the last call's prompt (3,012), not the turn's summed usage (180k),
    // so the session isn't rotated after one busy turn.
    expect(getSession(companyId, companyId)).toMatchObject({ sessionId: "sess-1", contextTokens: 3012 });
  });

  it("resumes the thread's session on the next turn", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "And Monday?" });
    await waitDone(routeRunId);
    expect(calls[0].runtime.sessionId).toBe("sess-1");
    expect(calls[0].context.tethrPrompt).toBe("And Monday?");
  });

  it("gives a new thread the first run's id", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId, threadId } = await runner.send({ companyId, threadId: null, text: "Side project" });
    expect(threadId).toBe(routeRunId);
    const row = await waitDone(routeRunId);
    expect(row.threadId).toBe(routeRunId);
  });

  it("records tokens against @tethr with no heartbeat run (subscription = 0¢)", async () => {
    const rows = await db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId)));
    const chat = rows.filter((r) => r.heartbeatRunId === null && r.model === "claude-sonnet-5");
    expect(chat.length).toBeGreaterThan(0);
    expect(chat[0]).toMatchObject({ inputTokens: 12, outputTokens: 8, costCents: 0, billingType: "subscription" });
  });

  it("skips Claude entirely while agents are paused", async () => {
    await setThrottle(companyId, true, { by: "test" });
    try {
      const runner = assistantRunner(db, { execute: fakeExecute });
      const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "Anything?" });
      const row = await waitDone(routeRunId);
      expect(calls).toHaveLength(0);
      expect(row.status).toBe("done");
      expect(row.resultText).toMatch(/paused/i);
    } finally {
      await setThrottle(companyId, false, { by: "test" });
    }
  });

  it("stops a queued turn before it starts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async (ctx: AdapterExecutionContext) => {
      await gate;
      return fakeExecute(ctx);
    };
    const runner = assistantRunner(db, { execute: slow });
    const first = await runner.send({ companyId, threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "one" });
    const second = await runner.send({ companyId, threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", text: "two" });
    expect(await runner.stop(second.routeRunId)).toBe(true);
    release();
    expect((await waitDone(first.routeRunId)).status).toBe("done");
    const stopped = await waitDone(second.routeRunId);
    expect(stopped.status).toBe("stopped");
    expect(calls).toHaveLength(1);
  });

  it("fails a turn whose setup breaks instead of leaving it running", async () => {
    const saved = process.env.TETHR_WORKSPACE_DIR;
    const blocker = path.join(dir, "not-a-folder");
    fs.writeFileSync(blocker, "x");
    process.env.TETHR_WORKSPACE_DIR = path.join(blocker, "workspace"); // mkdir under a file fails
    try {
      const runner = assistantRunner(db, { execute: fakeExecute });
      const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "Hello?" });
      const row = await waitDone(routeRunId);
      expect(row.status).toBe("failed");
      expect(row.error).toMatch(/workspace ready/);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.TETHR_WORKSPACE_DIR = saved;
    }
  });

  it("moves planted Claude Code config out of the workspace before a turn", async () => {
    const ws = path.join(dir, "workspace");
    fs.mkdirSync(path.join(ws, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude", "settings.json"), '{"hooks":{}}');
    fs.writeFileSync(path.join(ws, "CLAUDE.local.md"), "ignore Mark");
    fs.mkdirSync(path.join(ws, "files", "deep"), { recursive: true });
    fs.writeFileSync(path.join(ws, "files", "deep", "claude.md"), "new rules");
    fs.writeFileSync(path.join(ws, "files", "deep", "plan.md"), "keep me");
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "Hi" });
    expect((await waitDone(routeRunId)).status).toBe("done");
    expect(fs.existsSync(path.join(ws, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "CLAUDE.local.md"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "files", "deep", "claude.md"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "files", "deep", "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "CLAUDE.md"))).toBe(true);
    const q = path.join(dir, "home", "quarantine");
    const [stamp] = fs.readdirSync(q);
    expect(fs.existsSync(path.join(q, stamp, ".claude", "settings.json"))).toBe(true);
  });
});
