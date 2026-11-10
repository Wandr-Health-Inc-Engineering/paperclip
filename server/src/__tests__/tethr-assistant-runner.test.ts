import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { costEvents, createDb, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { getSession, isTainted, setSession, startOver } from "../tethr/chats.ts";
import { stableThreadId } from "../tethr/ids.ts";
import { instructionsFingerprint } from "../tethr/assistant/persona.ts";
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
    expect(env.TETHR_HOOK_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The generated workspace (memory rendered in, phase 25) + per-turn settings with the gate hooks.
    const claudeMd = fs.readFileSync(path.join(dir, "workspace", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("## Memory");
    expect(claudeMd).not.toContain("@Memory.md");
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

  it("starts fresh with a recap when tethr's instructions changed, and catches memory up", async () => {
    // Core won't resume a session made under other instructions; the runner must know.
    await setSession(companyId, companyId, { ...getSession(companyId, companyId)!, instructions: "older-persona" });
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "So what should we do?" });
    await waitDone(routeRunId);
    expect(calls[0].runtime.sessionId ?? null).toBeNull();
    const prompt = calls[0].context.tethrPrompt as string;
    expect(prompt).toContain("continues from an earlier session");
    expect(prompt).toContain("Earlier in this conversation (for context):");
    expect(prompt).toContain("Them: And Monday?");
    // Three messages from a person and nothing in memory: recall and save first.
    expect(prompt).toContain("Your memory is empty, but this chat has history.");
    expect(prompt.endsWith("So what should we do?")).toBe(true);
    expect(getSession(companyId, companyId)?.instructions).toBe(instructionsFingerprint());
  });

  it("sends the recap with a session saved before sessions recorded their instructions", async () => {
    const { instructions: _drop, ...legacy } = getSession(companyId, companyId)!;
    await setSession(companyId, companyId, legacy);
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId } = await runner.send({ companyId, threadId: companyId, text: "And after that?" });
    await waitDone(routeRunId);
    const prompt = calls[0].context.tethrPrompt as string;
    expect(calls[0].runtime.sessionId).toBeTruthy();
    expect(prompt).toContain("Earlier in this conversation (for context):");
    expect(prompt).not.toContain("continues from an earlier session");
  });

  it("after Start over, a new session never gets the turns from before it", async () => {
    // Older turns can quote connector data, and starting over clears the taint.
    await startOver(companyId, companyId);
    expect(getSession(companyId, companyId)).toBeNull();
    const runner = assistantRunner(db, { execute: fakeExecute });
    const first = await runner.send({ companyId, threadId: companyId, text: "Fresh question" });
    await waitDone(first.routeRunId);
    let prompt = calls[0].context.tethrPrompt as string;
    expect(prompt).not.toContain("Earlier in this conversation");
    expect(prompt).not.toContain("Your memory is empty");
    expect(prompt.endsWith("Fresh question")).toBe(true);

    // A later fresh session recaps only what came after the restart.
    await setSession(companyId, companyId, { ...getSession(companyId, companyId)!, instructions: "older-persona" });
    const second = await runner.send({ companyId, threadId: companyId, text: "And now?" });
    await waitDone(second.routeRunId);
    prompt = calls[1].context.tethrPrompt as string;
    expect(prompt).toContain("Them: Fresh question");
    expect(prompt).not.toContain("And Monday?");
  });

  it("still recaps the conversation when the newest rows are cards", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const first = await runner.send({ companyId, threadId: null, text: "Partners bring one order a month" });
    await waitDone(first.routeRunId);
    const thread = first.threadId;
    // Agent reports landing in the chat after it: more of them than the recap holds.
    const [tethr] = await db.select({ agentId: tethrRouteRuns.agentId }).from(tethrRouteRuns).where(eq(tethrRouteRuns.id, first.routeRunId));
    for (let i = 0; i < 10; i++) {
      await db.insert(tethrRouteRuns).values({
        companyId,
        agentId: tethr!.agentId,
        threadId: thread,
        invocationSource: "chat",
        sourceKey: "tethr-agent-report",
        requestText: `@seo report ${i}`,
        resultText: "Report body from a web page",
        status: "done",
        createdAt: new Date(Date.now() + (i + 1) * 1000),
      } as never);
    }
    await setSession(companyId, thread, { ...getSession(companyId, thread)!, instructions: "older-persona" });
    const next = await runner.send({ companyId, threadId: thread, text: "So?" });
    await waitDone(next.routeRunId);
    const prompt = calls[1].context.tethrPrompt as string;
    expect(prompt).toContain("Them: Partners bring one order a month");
    expect(prompt).not.toContain("Report body from a web page");
  });

  it("never replays the Ideas chat's private turns into a person's session there", async () => {
    const ideas = stableThreadId("ideas", companyId);
    const runner = assistantRunner(db, { execute: fakeExecute });
    const idea = await runner.sendPrivate({ companyId, threadId: ideas, summary: "Idea check from Slack", prompt: "Slack excerpt: …" });
    await waitDone(idea.routeRunId);
    const mine = await runner.send({ companyId, threadId: ideas, text: "Tell me more" });
    await waitDone(mine.routeRunId);
    const prompt = calls[1].context.tethrPrompt as string;
    expect(prompt).not.toContain("Idea check from Slack");
    expect(prompt).not.toContain("Earlier in this conversation");
  });

  it("gives a new thread the first run's id", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const { routeRunId, threadId } = await runner.send({ companyId, threadId: null, text: "Side project" });
    expect(threadId).toBe(routeRunId);
    const row = await waitDone(routeRunId);
    expect(row.threadId).toBe(routeRunId);
  });

  it("runs a private turn on a tainted thread, without resuming or saving a session", async () => {
    const runner = assistantRunner(db, { execute: fakeExecute });
    const ideas = "22222222-2222-4222-8222-222222222222";
    expect(isTainted(companyId, ideas)).toBe(false);
    const { routeRunId } = await runner.sendPrivate({ companyId, threadId: ideas, summary: "Idea check", prompt: "Slack excerpt: …" });
    // Other people's words sit beside Memory.md, so outside pages need approval from the first call.
    expect(isTainted(companyId, ideas)).toBe(true);
    const row = await waitDone(routeRunId);
    expect(row.requestText).toBe("Idea check");
    expect(calls[0].context.tethrPrompt).toBe("[From Tethr, not the user] Slack excerpt: …");
    expect(calls[0].runtime.sessionId ?? null).toBeNull();
    expect(calls[0].config.extraArgs as string[]).toContain("--no-session-persistence");
    expect(getSession(companyId, ideas)).toBeNull();
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
