import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { gatingService } from "../tethr/gating.ts";
import { updateIntegrations } from "../tethr/integrations.ts";
import { takeNotes } from "../tethr/chats.ts";
import { issueHookToken, resolveHookToken, revokeHookToken } from "../tethr/assistant/gate.ts";
import { canonicalJson, inputHash } from "../tethr/assistant/grants.ts";
import { handlePostToolUse, handlePreToolUse } from "../tethr/assistant/hook-handler.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 18.3: the enforced approval gate — hold → card → approve → one-time run.

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

const SEND = "mcp__claude_ai_Gmail__send_message";
const decisionOf = (reply: { stdout?: string }) =>
  JSON.parse(reply.stdout ?? "{}").hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };

describe("tethr assistant gate — hashing + tokens", () => {
  it("hashes the same call the same way regardless of key order and whitespace", () => {
    const a = { to: ["m@travelwithwandr.com"], subject: "Hi", body: "Line one  \r\nLine two", cc: [] };
    const b = { body: "Line one\nLine two", subject: "Hi", to: ["m@travelwithwandr.com"] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(inputHash(SEND, a)).toBe(inputHash(SEND, b));
    expect(inputHash(SEND, a)).not.toBe(inputHash(SEND, { ...b, subject: "Hi!" }));
  });

  it("issues per-turn tokens that stop working after revoke", async () => {
    const t = issueHookToken({ companyId: "c", threadId: "t", runId: "r" });
    expect(resolveHookToken(t)).toEqual({ companyId: "c", threadId: "t", runId: "r" });
    expect(resolveHookToken("nope")).toBeNull();
    revokeHookToken(t, 0);
    await new Promise((r) => setTimeout(r, 5));
    expect(resolveHookToken(t)).toBeNull();
  });
});

describePg("tethr assistant gate — approvals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let dir!: string;
  let companyId!: string;
  const threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const prompts: string[] = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    prompts.push(String(ctx.context.tethrPrompt));
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Sent.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "Sent." };
  };

  async function turnRow() {
    const [row] = await db
      .insert(tethrRouteRuns)
      .values({ companyId, requestText: "email me", invocationSource: "chat", threadId, status: "running", hops: [] })
      .returning();
    return row;
  }

  async function cards() {
    return db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "external_action")));
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-gate-"));
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    delete process.env.SLACK_BOT_TOKEN;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-gate-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ["TETHR_CHATS_FILE", "TETHR_INTEGRATIONS_FILE", "TETHR_PAUSED_FILE", "TETHR_ASSISTANT_HOME", "TETHR_WORKSPACE_DIR"]) {
      delete process.env[k];
    }
  });

  beforeEach(() => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    prompts.length = 0;
  });

  const email = { to: ["mark@travelwithwandr.com"], subject: "Checklist", body: "Here it is." };

  it("holds an outward action as one gated card, then says it's still waiting", async () => {
    const run = await turnRow();
    const ctx = { companyId, threadId, runId: run.id };
    const first = decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: email }));
    expect(first.permissionDecision).toBe("deny");
    expect(first.permissionDecisionReason).toMatch(/^Tethr approval gate: sent to Mark for approval/);
    const again = decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: email }));
    expect(again.permissionDecisionReason).toMatch(/still waiting/);
    const held = await cards();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: "gated", sensitivity: "external", routeRunId: run.id, title: "Email to mark@travelwithwandr.com — “Checklist”" });
    expect(held[0].approvalId).toBeTruthy();
    expect(held[0].body).toContain("**Subject:** Checklist");
  });

  it("approve → wakes the chat → the identical call runs once → closes as done", async () => {
    const [card] = await cards();
    await gatingService(db).decide({ companyId, outputId: card.id, decision: "approve", reviewer: "local-board" });
    const [approved] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, card.id));
    expect(approved.status).toBe("approved");
    expect((approved.meta as Record<string, any>).grant.status).toBe("active");

    // The system turn ran with the approval instructions prepended.
    for (let i = 0; i < 100 && !prompts.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(prompts[0]).toMatch(/Notes from Tethr:/);
    expect(prompts[0]).toContain(SEND);
    expect(prompts[0]).toContain("[From Tethr, not Mark] Mark approved: Email to mark@travelwithwandr.com");

    const run = await turnRow();
    const ctx = { companyId, threadId, runId: run.id };
    const go = decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: { body: "Here it is.", subject: "Checklist", to: ["mark@travelwithwandr.com"] } }));
    expect(go.permissionDecision).toBe("allow");
    await handlePostToolUse(db, ctx, { tool_name: SEND, tool_input: email, tool_response: { ok: true } });
    const [done] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, card.id));
    expect(done.status).toBe("published");

    // No replay: the same call again needs a fresh approval.
    const replay = decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: email }));
    expect(replay.permissionDecision).toBe("deny");
    expect(replay.permissionDecisionReason).toMatch(/sent to Mark for approval/);
  });

  it("a different message never rides on an approval", async () => {
    const pending = (await cards()).find((c) => c.status === "gated")!;
    await gatingService(db).decide({ companyId, outputId: pending.id, decision: "approve", reviewer: "local-board" });
    const run = await turnRow();
    const altered = decisionOf(
      await handlePreToolUse(db, { companyId, threadId, runId: run.id }, { tool_name: SEND, tool_input: { ...email, body: "Something else" } }),
    );
    expect(altered.permissionDecision).toBe("deny");
  });

  it("expired grants don't run", async () => {
    const approved = (await cards()).find((c) => c.status === "approved")!;
    const meta = approved.meta as Record<string, any>;
    await db
      .update(tethrOutputs)
      .set({ meta: { ...meta, grant: { ...meta.grant, expiresAt: new Date(Date.now() - 1000).toISOString() } } })
      .where(eq(tethrOutputs.id, approved.id));
    const run = await turnRow();
    const d = decisionOf(await handlePreToolUse(db, { companyId, threadId, runId: run.id }, { tool_name: SEND, tool_input: email }));
    expect(d.permissionDecision).toBe("deny");
  });

  it("reject → no grant, a note for the next turn, no wake", async () => {
    const run = await turnRow();
    const input = { to: ["mark@travelwithwandr.com"], subject: "Reject me", body: "x" };
    await handlePreToolUse(db, { companyId, threadId, runId: run.id }, { tool_name: SEND, tool_input: input });
    const card = (await cards()).find((c) => c.title.includes("Reject me"))!;
    prompts.length = 0;
    await gatingService(db).decide({ companyId, outputId: card.id, decision: "reject", reviewer: "local-board" });
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts).toHaveLength(0);
    const notes = await takeNotes(companyId, threadId);
    expect(notes.some((n) => n.includes("Mark rejected: Email to mark@travelwithwandr.com — “Reject me”"))).toBe(true);
  });

  it("auto mode sends internal mail without a card but still asks for outsiders and money", async () => {
    await updateIntegrations(companyId, { connectors: { Gmail: { mode: "auto" }, Stripe: { mode: "auto" } } });
    const run = await turnRow();
    const ctx = { companyId, threadId, runId: run.id };
    expect(decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: { ...email, subject: "Auto" } })).permissionDecision).toBe("allow");
    const outside = decisionOf(await handlePreToolUse(db, ctx, { tool_name: SEND, tool_input: { to: ["x@gmail.com"], subject: "Out" } }));
    expect(outside.permissionDecisionReason).toMatch(/sent to Mark for approval/);
    const money = decisionOf(await handlePreToolUse(db, ctx, { tool_name: "mcp__claude_ai_Stripe__stripe_api_write", tool_input: { op: "refund" } }));
    expect(money.permissionDecisionReason).toMatch(/sent to Mark for approval/);
    const [moneyCard] = (await cards()).filter((c) => c.sensitivity === "spend");
    expect(moneyCard).toBeTruthy();
  });

  it("keeps reads, workspace writes and blocked tools on the right side", async () => {
    const run = await turnRow();
    const ctx = { companyId, threadId, runId: run.id };
    expect(decisionOf(await handlePreToolUse(db, ctx, { tool_name: "mcp__claude_ai_Gmail__search_threads", tool_input: {} })).permissionDecision).toBe("allow");
    const ws = path.join(dir, "workspace", "files", "plan.md");
    expect(decisionOf(await handlePreToolUse(db, ctx, { tool_name: "Write", tool_input: { file_path: ws, content: "x" } })).permissionDecision).toBe("allow");
    const out = decisionOf(await handlePreToolUse(db, ctx, { tool_name: "Write", tool_input: { file_path: path.join(os.homedir(), "Desktop", "x.md") } }));
    expect(out.permissionDecision).toBe("deny");
    expect(decisionOf(await handlePreToolUse(db, ctx, { tool_name: "Bash", tool_input: { command: "ls" } })).permissionDecision).toBe("deny");
  });
});
