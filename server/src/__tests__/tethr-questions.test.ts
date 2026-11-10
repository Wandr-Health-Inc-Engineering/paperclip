import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { agents, createDb, issues, tethrNotifications, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { runTethrTool, TETHR_TOOL_DEFS } from "../tethr/assistant/tethr-tools.ts";
import { classify } from "../tethr/assistant/policy.ts";
import { sandboxRefusal } from "../tethr/assistant/sandbox.ts";
import { answerText, getQuestion, openQuestions, parseAsk, QUESTION_LIMITS, QuestionInputError, questionStore, type Question } from "../tethr/assistant/questions.ts";
import { questionDmText } from "../tethr/assistant/person-tools.ts";
import { agentDenyRules, agentToolRefusal, TEAM_TOOL_NAMES, validateTeamSpec } from "../tethr/team-spec.ts";
import { executeTeamTask } from "../tethr/team-run.ts";
import { healTeamIcons, teamConnectorLabels, teamService } from "../tethr/team.ts";
import { connectionsContextText, findConnection, needResolver } from "../tethr/connections.ts";
import { updateIntegrations } from "../tethr/integrations.ts";
import { takeNotes } from "../tethr/chats.ts";
import { taskService } from "../tethr/tasks.ts";
import { gatingService } from "../tethr/gating.ts";
import { tethrRoutes } from "../routes/tethr.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 27: questions asked as cards with buttons (the `ask` tool), instead of in prose.

const question = (over: Partial<Question> = {}): Question => ({
  id: "q1",
  threadId: "t1",
  runId: null,
  agentTag: null,
  question: "Save these goals as they are?",
  detail: null,
  options: null,
  status: "answered",
  answer: { choice: "approve", comment: null, by: "mark", at: "2026-11-10T16:00:00.000Z", via: "card" },
  askedAt: "2026-11-10T15:59:00.000Z",
  ...over,
});

describe("questions as cards: the pure parts", () => {
  it("takes a one-line question, an optional detail and 2 to 4 choices", () => {
    expect(parseAsk({ question: "  Save these goals\nas they are?  " })).toEqual({ question: "Save these goals as they are?", detail: null, options: null });
    const withOptions = parseAsk({ question: "Which first?", detail: "Line one\r\nLine two", options: [{ label: "SEO", description: "about 40 a month" }, "Paid ads"] });
    expect(withOptions).toEqual({
      question: "Which first?",
      detail: "Line one\nLine two",
      options: [
        { label: "SEO", description: "about 40 a month" },
        { label: "Paid ads", description: null },
      ],
    });
    expect(() => parseAsk({})).toThrow(QuestionInputError);
    expect(() => parseAsk({ question: "x".repeat(QUESTION_LIMITS.question + 1) })).toThrow(/one line/);
    expect(() => parseAsk({ question: "Which?", options: [{ label: "Only one" }] })).toThrow(/2 to 4 options/);
    expect(() => parseAsk({ question: "Which?", options: ["a", "b", "c", "d", "e"] })).toThrow(/2 to 4 options/);
    expect(() => parseAsk({ question: "Which?", options: ["Same", "same"] })).toThrow(/same label/);
    expect(() => parseAsk({ question: "Which?", options: [{ label: "x".repeat(41) }, "b"] })).toThrow(/button/);
  });

  it("turns an answer into the person's own message to whoever asked", () => {
    expect(answerText(question())).toBe('Approved: "Save these goals as they are?"');
    expect(answerText(question({ answer: { choice: "reject", comment: "Keep revenue at 350K.", by: "mark", at: "", via: "card" } }))).toBe(
      'Rejected: "Save these goals as they are?"\nKeep revenue at 350K.',
    );
    const choice = question({ question: "Which first?", options: [{ label: "SEO", description: null }, { label: "Paid ads", description: null }], answer: { choice: "SEO", comment: null, by: "mark", at: "", via: "card" } });
    expect(answerText(choice)).toBe('About "Which first?": SEO');
    expect(answerText(question({ answer: { choice: null, comment: "Do both, SEO first.", by: "mark", at: "", via: "card" } }))).toBe(
      'About "Save these goals as they are?": Do both, SEO first.',
    );
  });

  it("is a draft inside tethr, kept from the sealed learner, and every other agent has it whatever its tools", () => {
    const ctx = { workspaceDir: "/w", readableRoots: ["/w"], internalAddresses: [] };
    expect(classify("mcp__tethr__ask", { question: "Go ahead?" }, ctx)).toMatchObject({ cls: "draft", summary: "Asking you: “Go ahead?”" });
    expect(TETHR_TOOL_DEFS.some((d) => d.name === "ask")).toBe(true);
    expect(sandboxRefusal("@sage", "mcp__tethr__ask")).toMatch(/blocked/);

    const others = TETHR_TOOL_DEFS.map((d) => d.name).filter((n) => !(TEAM_TOOL_NAMES as readonly string[]).includes(n));
    const noTethrTools = agentDenyRules(["Stripe"], ["Stripe", "Gmail", "Tethr tools"], { otherTethrTools: others });
    expect(noTethrTools).not.toContain("mcp__tethr");
    expect(noTethrTools).not.toContain("mcp__tethr__ask");
    expect(noTethrTools).toContain("mcp__tethr__score_list");
    expect(noTethrTools).toContain("mcp__tethr__create_agent");
    expect(noTethrTools).toContain("mcp__claude_ai_Gmail");
    // Without the list of the other tools, the whole server is denied rather than left open.
    expect(agentDenyRules(["Stripe"], ["Stripe", "Tethr tools"])).toContain("mcp__tethr");
    const scout = { tag: "@scout", connectors: ["Stripe"] };
    expect(agentToolRefusal(scout, "mcp__tethr__ask", "Tethr tools")).toBeNull();
    expect(agentToolRefusal(scout, "mcp__tethr__score_list", "Tethr tools")).toMatch(/isn't set up to use Tethr tools/);
  });

  it("tells an owner on Slack that a question waits, without anyone's health details", () => {
    expect(questionDmText("@paid-ads", question({ question: "Approve a $1,200 test budget?" }))).toContain("*Approve a $1,200 test budget?*");
    const withHealth = questionDmText("@paid-ads", question({ question: "Reply to Jane Doe about her malaria prescription?" }));
    expect(withHealth).toBe("@paid-ads has a question for you. Answer it in tethr (Needs you, or the chat).");
    // A chat that has read connector data: the question's words stay in tethr.
    expect(questionDmText("tethr", question({ question: "Refund the Acme order?" }), { tainted: true })).toBe("tethr has a question for you. Answer it in tethr (Needs you, or the chat).");
    // A missing connection is tethr's own wording, so it always goes.
    expect(questionDmText("@paid-ads", question({ question: "@paid-ads needs Google Ads", connection: { key: "Google Ads" } }), { tainted: true })).toContain("*@paid-ads needs Google Ads*");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("questions as cards: asked, answered, and held on", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const calls: string[] = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    calls.push(String(ctx.context.tethrPrompt));
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Done.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };
  const PERSON = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };
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
  const ask = (args: Record<string, unknown>, threadId: string, runId?: string) =>
    runTethrTool("ask", args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId, runId });
  const settle = async (runId: string) => {
    for (let i = 0; i < 300; i++) {
      const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
      if (row && ["done", "failed", "stopped"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("turn never finished");
  };
  const say = async (threadId: string, text: string) =>
    (await request(appFor(PERSON)).post(`/api/tethr/${companyId}/chats/${threadId}/messages`).send({ text }).expect(200)).body.routeRunId as string;
  const turnsOf = async (threadId: string) => (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/chats/${threadId}/runs`).expect(200)).body as Array<Record<string, unknown>>;
  const answer = (id: string, body: Record<string, unknown>, actor: Record<string, unknown> = PERSON) =>
    request(appFor(actor)).post(`/api/tethr/${companyId}/questions/${id}/answer`).send(body);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-questions-"));
    for (const [key, name] of [
      ["TETHR_SETUP_FILE", "setup.json"],
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_PAUSED_FILE", "paused.json"],
      ["TETHR_OVERSEERS_FILE", "overseers.json"],
      ["TETHR_QUESTIONS_FILE", "questions.json"],
      ["TETHR_MEMORY_FILE", "memory.json"],
    ]) {
      process.env[key!] = path.join(dir, name!);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-questions-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    resetAssistantRunnerForTests();
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    calls.length = 0;
    await questionStore.update(companyId, () => ({ questions: [] }));
  });

  it("shows under the turn that asked; Approve sends the answer into that chat as the person's message", async () => {
    const turn = await say(companyId, "Set up my goals");
    await settle(turn);
    const res = await ask({ question: "Save these goals as they are?", detail: "Revenue 350K by Dec 2027." }, companyId, turn);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Approve, Reject and Comment");
    expect((await ask({ question: "save these goals as they are?" }, companyId, turn)).text).toMatch(/already waiting/);

    const asked = (await turnsOf(companyId)).find((r) => r.id === turn)!.questions as Question[];
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ status: "open", agentTag: null, detail: "Revenue 350K by Dec 2027.", options: null });
    // The person is in this chat: no bell for a question in a turn they started.
    expect((await db.select().from(tethrNotifications).where(eq(tethrNotifications.companyId, companyId))).filter((n) => n.title.includes("asks"))).toHaveLength(0);

    const id = asked[0]!.id;
    await answer(id, { choice: "approve" }, { type: "agent", agentId: "a1", companyId }).expect(403);
    await answer(id, { choice: "maybe" }).expect(409);
    await answer(id, {}).expect(409);
    expect(getQuestion(companyId, id)!.status).toBe("open");

    const done = await answer(id, { choice: "approve" }).expect(200);
    expect(done.body.threadId).toBe(companyId);
    const next = await settle(done.body.routeRunId);
    expect(next).toMatchObject({ requestText: 'Approved: "Save these goals as they are?"', sourceKey: null, requestedByUserId: "mark" });
    expect(calls.at(-1)).toContain('Approved: "Save these goals as they are?"');
    expect(getQuestion(companyId, id)).toMatchObject({ status: "answered", answer: { choice: "approve", via: "card", by: "mark" } });
    await answer(id, { choice: "reject" }).expect(409);
  });

  it("offers choices as buttons, and takes a comment as the answer", async () => {
    await ask({ question: "Which first?", options: [{ label: "SEO" }, { label: "Paid ads" }] }, companyId);
    await ask({ question: "Run the scorecard now?" }, companyId);
    const [choice, yesNo] = openQuestions(companyId, { threadId: companyId });
    await answer(choice!.id, { choice: "Partnerships" }).expect(409);
    const picked = await answer(choice!.id, { choice: "Paid ads" }).expect(200);
    expect((await settle(picked.body.routeRunId)).requestText).toBe('About "Which first?": Paid ads');
    // Answering one card leaves the other open.
    expect(getQuestion(companyId, yesNo!.id)!.status).toBe("open");
    const commented = await answer(yesNo!.id, { comment: "Not yet: wait for Friday." }).expect(200);
    expect((await settle(commented.body.routeRunId)).requestText).toBe('About "Run the scorecard now?": Not yet: wait for Friday.');
  });

  it("counts a typed message as the answer to what was open in that chat, and only there", async () => {
    const side = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await ask({ question: "Use last month's numbers?" }, companyId);
    await ask({ question: "Draft the partner email?" }, side);
    await settle(await say(companyId, "Yes, use October."));
    expect(openQuestions(companyId, { threadId: companyId })).toHaveLength(0);
    expect(openQuestions(companyId, { threadId: side })).toHaveLength(1);
    const [typed] = (questionStore.get(companyId).questions ?? []).filter((q) => q.threadId === companyId);
    expect(typed!.answer).toMatchObject({ via: "chat", choice: null });
  });

  it("keeps a chat to three unanswered questions", async () => {
    for (const q of ["One?", "Two?", "Three?"]) expect((await ask({ question: q }, companyId)).isError).toBeFalsy();
    const fourth = await ask({ question: "Four?" }, companyId);
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toMatch(/3 questions are already waiting/);
  });

  it("an agent's question rings the bell, counts as needing you, and holds its scheduled run without spending a turn", async () => {
    const team = teamService(db);
    const spec = validateTeamSpec(
      { name: "Paid Ads", title: "Paid acquisition lead", mission: "Owns paid search.", instructions: "Plan and track paid search campaigns.", connectors: [], schedule: { cron: "0 9 * * 1", brief: "Weekly check." } },
      { takenTags: await team.takenTags(companyId), connectors: teamConnectorLabels(companyId) },
    );
    const agent = await team.create(companyId, spec, { userId: "mark", via: "approval" });
    const asked = await ask({ question: "Approve a $1,200 a month test budget?" }, agent.threadId);
    expect(asked.isError).toBeFalsy();
    expect(openQuestions(companyId, { agentTag: "@paid-ads" })).toHaveLength(1);
    const bells = await db.select().from(tethrNotifications).where(eq(tethrNotifications.companyId, companyId));
    expect(bells.find((n) => n.title === "@paid-ads asks: Approve a $1,200 a month test budget?")).toMatchObject({ kind: "approval", href: `/chat?chat=${agent.threadId}` });
    const roster = await request(appFor(PERSON)).get(`/api/tethr/${companyId}/team`).expect(200);
    expect(roster.body.agents.find((a: { tag: string }) => a.tag === "@paid-ads").waitingOnYou).toBe(1);

    const scheduled = async () => {
      const [issue] = await db
        .insert(issues)
        .values({ companyId, title: "Weekly check", status: "todo", assigneeAgentId: agent.agentId, originKind: "routine_execution" })
        .returning();
      const logs: string[] = [];
      const ctx = { agent: { id: agent.agentId, companyId }, runId: null, context: {}, onLog: async (_s: string, line: string) => void logs.push(line) } as unknown as AdapterExecutionContext;
      const out = await executeTeamTask(db, { ctx, issueId: issue!.id, issue: issue!, tasks: taskService(db), agentTag: agent.tag });
      const [after] = await db.select().from(issues).where(eq(issues.id, issue!.id));
      return { out, status: after!.status, logs };
    };
    const turnsInItsChat = async () => (await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.threadId, agent.threadId)))).length;

    const before = await turnsInItsChat();
    const held = await scheduled();
    expect(held.out.summary).toContain('waiting for an answer to "Approve a $1,200 a month test budget?"');
    expect(held.status).toBe("cancelled");
    expect(await turnsInItsChat()).toBe(before);
    expect(calls).toHaveLength(0);

    // Answered: the next scheduled run goes ahead.
    const [open] = openQuestions(companyId, { agentTag: "@paid-ads" });
    const answered = await answer(open!.id, { choice: "approve" }).expect(200);
    expect(answered.body.threadId).toBe(agent.threadId);
    await settle(answered.body.routeRunId);
    const ran = await scheduled();
    expect(ran.out.summary).not.toContain("waiting for an answer");
    expect(await turnsInItsChat()).toBeGreaterThan(before + 1);
  }, 60_000);
});

// ---- phase 27.5: connections an agent's job depends on -------------------------------

describePg("an agent waits on a missing connection, and spends nothing until it's sorted", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const calls: string[] = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    calls.push(String(ctx.context.tethrPrompt));
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Report:\nDid the work.\n\nSlack summary: Done.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };
  const PERSON = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };
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
  const tool = (name: string, args: Record<string, unknown>, threadId: string) =>
    runTethrTool(name, args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId });
  const answer = (id: string, body: Record<string, unknown>) => request(appFor(PERSON)).post(`/api/tethr/${companyId}/questions/${id}/answer`).send(body);
  const turnsIn = async (threadId: string) =>
    (await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.threadId, threadId), eq(tethrRouteRuns.sourceKey, "chat-system")))).length;
  const makeAgent = async (name: string, extra: Record<string, unknown> = {}, lead?: Awaited<ReturnType<ReturnType<typeof teamService>["get"]>>) => {
    const team = teamService(db);
    const spec = validateTeamSpec(
      { name, title: `${name} agent`, mission: "Owns part of paid search.", instructions: "Plan and track paid search campaigns.", connectors: [], ...extra },
      { takenTags: await team.takenTags(companyId), connectors: teamConnectorLabels(companyId), ...needResolver(companyId), lead: lead ? { tag: lead.tag, connectors: lead.connectors } : null },
    );
    return team.create(companyId, spec, { userId: "mark", via: "approval" }, { lead: lead ?? null });
  };
  const runTask = async (agent: { agentId: string; tag: string }, originKind: "manual" | "routine_execution") => {
    const [issue] = await db.insert(issues).values({ companyId, title: "Reconcile ad spend", status: "todo", assigneeAgentId: agent.agentId, originKind }).returning();
    const ctx = { agent: { id: agent.agentId, companyId }, runId: null, context: {}, onLog: async () => {} } as unknown as AdapterExecutionContext;
    const out = await executeTeamTask(db, { ctx, issueId: issue!.id, issue: issue!, tasks: taskService(db), agentTag: agent.tag });
    const [after] = await db.select().from(issues).where(eq(issues.id, issue!.id));
    return { out, status: after!.status, issueId: issue!.id };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-needs-"));
    for (const [key, name] of [
      ["TETHR_SETUP_FILE", "setup.json"],
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_PAUSED_FILE", "paused.json"],
      ["TETHR_OVERSEERS_FILE", "overseers.json"],
      ["TETHR_QUESTIONS_FILE", "questions.json"],
      ["TETHR_MEMORY_FILE", "memory.json"],
    ]) {
      process.env[key!] = path.join(dir, name!);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-needs-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    resetAssistantRunnerForTests();
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("knows what's connected, by any of a connection's names", () => {
    expect(findConnection(companyId, "google ads api")).toMatchObject({ key: "Google Ads", ok: false, fixKey: "google_ads" });
    expect(findConnection(companyId, "stripe")).toMatchObject({ key: "Stripe", ok: true, fixKey: "stripe" });
    expect(findConnection(companyId, "Mercury")).toMatchObject({ ok: false });
    expect(findConnection(companyId, "Tethr tools")).toBeNull();
    expect(findConnection(companyId, "telepathy")).toBeNull();
    const text = connectionsContextText(companyId);
    expect(text).toMatch(/^## Connections/);
    expect(text).toContain("- Google Ads: not set up");
    expect(text).toContain("call need_connection");
    expect(() => validateTeamSpec({ name: "X Y", title: "T t", mission: "Does a thing.", instructions: "Do the thing carefully each week.", needs: ["telepathy"] }, { takenTags: [], connectors: [], ...needResolver(companyId) })).toThrow(
      /isn't a connection tethr knows/,
    );
  });

  it("holds every run while a declared need is missing: no turn, one card, and a waiting task starts once it's connected", async () => {
    const lead = await makeAgent("Paid Ads", { lead: true, needs: ["canva"], schedule: { cron: "0 9 * * 1", brief: "Weekly check." } });
    expect(lead.needs).toEqual([{ key: "Canva", why: null, confirmFirst: false }]);
    const sub = await makeAgent("Ads Reporting", {}, lead);
    const team = teamService(db);
    expect((await team.unmetNeeds(companyId, sub)).map((n) => [n.key, n.ofTag])).toEqual([["Canva", "@paid-ads"]]);

    // A scheduled run is skipped; a task someone handed over waits. Neither spends a turn.
    const scheduled = await runTask(lead, "routine_execution");
    expect(scheduled.status).toBe("cancelled");
    expect(scheduled.out.summary).toContain("waiting for Canva");
    const handed = await runTask(lead, "manual");
    expect(handed.status).toBe("blocked");
    const subRun = await runTask(sub, "routine_execution");
    expect(subRun.out.summary).toContain("(its lead @paid-ads needs it)");
    expect(await turnsIn(lead.threadId)).toBe(0);
    expect(await turnsIn(sub.threadId)).toBe(0);
    expect(calls).toHaveLength(0);

    // One card, however often it was held; the main chat heard once; the roster says what it's waiting for.
    const cards = openQuestions(companyId, { agentTag: "@paid-ads" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ question: "@paid-ads needs Canva", connection: { key: "Canva" } });
    const mainCards = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
    expect(mainCards.map((r) => r.requestText)).toEqual(["@paid-ads is waiting on a connection: Canva"]);
    const roster = (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/team`).expect(200)).body.agents as Array<{ tag: string; waitingFor: string[]; waitingOnYou: number }>;
    expect(roster.find((a) => a.tag === "@paid-ads")).toMatchObject({ waitingFor: ["Canva"], waitingOnYou: 1 });
    expect(roster.find((a) => a.tag === "@ads-reporting")!.waitingFor).toEqual(["Canva"]);
    const list = (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/needs-you`).expect(200)).body;
    expect(list).toMatchObject({ count: 1, approvals: [], questions: [] });
    expect(list.connections[0]).toMatchObject({ question: "@paid-ads needs Canva", from: "@paid-ads's chat" });
    // The agent's report card in the main chat carries the card to act on.
    const turns = (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/chats/${companyId}/runs`).expect(200)).body as Array<{ sourceKey: string | null; needsYou: { questions: Question[] } | null }>;
    expect(turns.find((t) => t.sourceKey === "tethr-agent-report")!.needsYou!.questions.map((q) => q.question)).toEqual(["@paid-ads needs Canva"]);

    // "I've connected it" isn't taken on faith while tethr still can't use it.
    const refused = await answer(cards[0]!.id, { choice: "connected" }).expect(409);
    expect(refused.body.error).toMatch(/still can't use Canva/);
    expect(openQuestions(companyId, { agentTag: "@paid-ads" })).toHaveLength(1);

    // It's switched on in Integrations: the card closes by itself and the waiting task starts.
    // (Google Ads can't be switched on under tests, so a connector stands in.)
    await updateIntegrations(companyId, { connectors: { Canva: { mode: "ask" } } });
    const rechecked = await request(appFor(PERSON)).post(`/api/tethr/${companyId}/team/recheck`).send({}).expect(200);
    expect(rechecked.body).toEqual({ closed: 1, startedTasks: 1 });
    expect(openQuestions(companyId, { agentTag: "@paid-ads" })).toHaveLength(0);
    const [reopened] = await db.select().from(issues).where(eq(issues.id, handed.issueId));
    expect(reopened!.status).not.toBe("blocked");
    expect((await team.get(companyId, "@paid-ads"))!.heldIssues).toEqual([]);
    expect((await team.unmetNeeds(companyId, (await team.get(companyId, "@ads-reporting"))!))).toEqual([]);
    await updateIntegrations(companyId, { connectors: { Canva: { mode: "off" } } });
  }, 60_000);

  it("an agent that says a connection doesn't answer is held until a person says it's fixed, or to carry on without it", async () => {
    const agent = await makeAgent("Funnel Watch", { connectors: ["PostHog"] });
    const team = teamService(db);
    // tethr thinks PostHog is on; the agent found it doesn't answer.
    const raised = await tool("need_connection", { connector: "posthog", why: "It asks for authorization, so I can't read traffic." }, agent.threadId);
    expect(raised.isError).toBeFalsy();
    expect(raised.text).toContain("You won't be run again until they answer");
    expect((await team.get(companyId, agent.tag))!.needs).toEqual([{ key: "PostHog", why: "It asks for authorization, so I can't read traffic.", confirmFirst: true }]);
    expect((await tool("need_connection", { connector: "telepathy", why: "x" }, agent.threadId)).isError).toBe(true);

    const held = await runTask(agent, "manual");
    expect(held.status).toBe("blocked");
    expect(await turnsIn(agent.threadId)).toBe(0);
    // A saved setting doesn't clear it: only a person's word does.
    expect((await request(appFor(PERSON)).post(`/api/tethr/${companyId}/team/recheck`).send({}).expect(200)).body).toEqual({ closed: 0, startedTasks: 0 });

    // Writing to the agent doesn't make the connection card go away: typing connects nothing.
    await request(appFor(PERSON)).post(`/api/tethr/${companyId}/chats/${agent.threadId}/messages`).send({ text: "How's it going?" }).expect(200);
    const [card] = openQuestions(companyId, { agentTag: agent.tag });
    expect(card).toMatchObject({ connection: { key: "PostHog" }, detail: expect.stringContaining("It asks for authorization") });
    const done = await answer(card!.id, { choice: "without" }).expect(200);
    // The waiting task starts, so the news rides along as a note instead of a turn of its own.
    expect(done.body).toMatchObject({ startedTasks: 1, routeRunId: null });
    const after = (await team.get(companyId, agent.tag))!;
    expect(after.waived).toEqual(["PostHog"]);
    expect(await team.unmetNeeds(companyId, after)).toEqual([]);
    // Told once; asking again is turned away without a new card.
    const again = await tool("need_connection", { connector: "PostHog", why: "Still can't read traffic." }, agent.threadId);
    expect(again.text).toMatch(/already said to work without PostHog/);
    expect(openQuestions(companyId, { agentTag: agent.tag })).toHaveLength(0);
  }, 60_000);

  it("from tethr's own chat it's a card with the fix, and no hold", async () => {
    const res = await tool("need_connection", { connector: "Google Ads", why: "I can't see what the campaigns spent." }, companyId);
    expect(res.isError).toBeFalsy();
    const [card] = openQuestions(companyId, { threadId: companyId });
    expect(card).toMatchObject({ question: "Connect Google Ads", agentTag: null, connection: { key: "Google Ads" } });
    await answer(card!.id, { choice: "approve" }).expect(409); // not one of a connection card's answers
    await answer(card!.id, { choice: "connected" }).expect(409); // still not set up
    const done = await answer(card!.id, { choice: "without" }).expect(200);
    const [msg] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, done.body.routeRunId));
    expect(msg!.requestText).toMatch(/^Carry on without Google Ads\. Don't ask for it again/);
  });

  it("a proposed agent's card says what it would wait for, and sits in Needs you until it's decided", async () => {
    const res = await tool(
      "create_agent",
      { name: "Email Scout", title: "Lifecycle email", mission: "Finds lifecycle email wins.", instructions: "Review the welcome series each week and propose one test.", needs: ["Mercury", "gmail"], why: "Email is under-used." },
      companyId,
    );
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("It needs Mercury, which isn't connected");
    const list = (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/needs-you`).expect(200)).body;
    const card = list.approvals.find((o: { kind: string }) => o.kind === "team_agent");
    expect(card).toMatchObject({ status: "gated", from: "your chat with tethr", threadId: companyId });
    expect(card.body).toContain("Needs: Mercury (not connected), Gmail (connected). It won't run, or spend anything, until that's connected or you say to carry on without it.");

    // Approved: it's on the team, waiting, with its own connection card; the approval has left the list.
    await gatingService(db).decide({ companyId, outputId: card.id, decision: "approve", reviewer: "mark" });
    const after = (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/needs-you`).expect(200)).body;
    expect(after.approvals.find((o: { id: string }) => o.id === card.id)).toBeUndefined();
    expect(after.connections.map((q: { question: string }) => q.question)).toContain("@email-scout needs Mercury");
    expect((await teamService(db).get(companyId, "@email-scout"))!.needs.map((n) => n.key)).toEqual(["Mercury", "Gmail"]);
  });

  it("gives a new agent the icon for its job, and heals ones made before icons followed the job", async () => {
    const agent = await makeAgent("Lifecycle Email");
    const iconOf = async () => (await db.select({ icon: agents.icon }).from(agents).where(eq(agents.id, agent.agentId)))[0]!.icon;
    expect(await iconOf()).toBe("mail");
    expect((await teamService(db).get(companyId, agent.tag))!.icon).toBe("mail");
    await db.update(agents).set({ icon: "bot" }).where(eq(agents.id, agent.agentId));
    expect(await healTeamIcons(db)).toBeGreaterThanOrEqual(1);
    expect(await iconOf()).toBe("mail");
    // A second pass finds nothing to do; tethr itself (not a team agent) keeps its own icon.
    expect(await healTeamIcons(db)).toBe(0);
  });

  it("deletes files from tethr's folder only with approval, by moving them to the archive", async () => {
    const files = path.join(dir, "workspace", "files");
    fs.mkdirSync(path.join(files, "content"), { recursive: true });
    fs.writeFileSync(path.join(files, "content", "draft-a.md"), "old draft a");
    fs.writeFileSync(path.join(files, "content", "draft-b.md"), "old draft b");
    fs.writeFileSync(path.join(dir, "workspace", "Memory.md"), "memory");
    const agent = await makeAgent("Content Writer");

    // Nothing outside files/, no folders, nothing that isn't there.
    expect((await tool("delete_files", { paths: ["Memory.md"], why: "x" }, agent.threadId)).isError).toBe(true);
    expect((await tool("delete_files", { paths: ["files/../Memory.md"], why: "x" }, agent.threadId)).isError).toBe(true);
    expect((await tool("delete_files", { paths: ["files/content"], why: "x" }, agent.threadId)).isError).toBe(true);
    expect((await tool("delete_files", { paths: ["files/content/draft-a.md"] }, agent.threadId)).isError).toBe(true); // why is required

    const res = await tool("delete_files", { paths: ["files/content/draft-a.md", "content/draft-b.md", "files/nope.md"], why: "Replaced by the de-duplicated drafts." }, agent.threadId);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("remove 2 files");
    expect(res.text).toContain("Left out: files/nope.md isn't there.");
    const [card] = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "drive_change")));
    expect(card).toMatchObject({ status: "gated", sensitivity: "destructive", agentId: agent.agentId });
    expect(card!.body).toContain("- files/content/draft-a.md");
    expect(card!.body).toContain("Nothing is erased");
    // Nothing moved before a person says yes.
    expect(fs.existsSync(path.join(files, "content", "draft-a.md"))).toBe(true);

    await gatingService(db).decide({ companyId, outputId: card!.id, decision: "approve", reviewer: "mark" });
    const [after] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, card!.id));
    expect(after!.status).toBe("published");
    expect(fs.existsSync(path.join(files, "content", "draft-a.md"))).toBe(false);
    expect(fs.existsSync(path.join(files, "content", "draft-b.md"))).toBe(false);
    // Out of the way, not erased (no Drive here: the workspace's archive folder).
    expect(fs.readdirSync(path.join(dir, "workspace", "archive")).sort()).toEqual(["draft-a.md", "draft-b.md"]);
    expect(fs.readFileSync(path.join(dir, "workspace", "Memory.md"), "utf8")).toBe("memory");
    const notes = await takeNotes(companyId, agent.threadId);
    expect(notes.some((n) => n.startsWith("Approved: moved 2 files out of files/"))).toBe(true);

    // Rejected: nothing moves, and the chat that asked hears it.
    fs.writeFileSync(path.join(files, "keep.md"), "keep");
    await tool("delete_files", { paths: ["files/keep.md"], why: "Looks unused." }, agent.threadId);
    const [second] = (await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "drive_change"), eq(tethrOutputs.status, "gated"))));
    await gatingService(db).decide({ companyId, outputId: second!.id, decision: "reject", reviewer: "mark" });
    expect(fs.existsSync(path.join(files, "keep.md"))).toBe(true);
    expect((await takeNotes(companyId, agent.threadId)).some((n) => n.startsWith("Rejected: keep those files"))).toBe(true);
  });

  it("reads Google Ads only when it's set up, and points at the card when it isn't", async () => {
    const res = await tool("google_ads_report", { report: "overview" }, companyId);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("need_connection");
    expect(classify("mcp__tethr__google_ads_report", { report: "campaigns" }, { workspaceDir: "/w", readableRoots: ["/w"], internalAddresses: [] })).toMatchObject({ cls: "read" });
  });
});
