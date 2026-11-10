import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { companies, createDb, issues, routines, routineTriggers, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { applyRhythm, operationsThreadId, runTaskInOperationsChat } from "../tethr/rhythm.ts";
import { DEFAULT_RHYTHM, getSetup, interviewBrief, SETUP_STEPS, updateSetup, validCron, validTimezone } from "../tethr/setup.ts";
import { getIntegrations, updateIntegrations } from "../tethr/integrations.ts";
import { teamService } from "../tethr/team.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { addSideChat, clearSession, getSession, listSideChats, setSession } from "../tethr/chats.ts";
import { foldInterviewIntoMainChat } from "../tethr/main-chat.ts";
import { initTethrAdapter } from "../tethr/adapter.ts";
import { planReset, runReset, transcriptDirFor } from "../tethr/reset.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 20: tethr's setup (onboarding), the working rhythm on the chat engine,
// and the fresh-start wipe.

describe("tethr setup — pure bits", () => {
  it("validates schedules and time zones, and briefs the interview", () => {
    expect(validCron("0 8 * * 1")).toBe(true);
    expect(validCron("30 7 * * 1-5")).toBe(true);
    expect(validCron("0 8 * *")).toBe(false);
    expect(validCron("0 8 * * 1; rm -rf /")).toBe(false);
    expect(validTimezone("America/Chicago")).toBe(true);
    expect(validTimezone("Mars/Base")).toBe(false);
    const brief = interviewBrief(["New customers", "Revenue"], { person: "Mark", company: "Wandr Health", pace: "ambitious" });
    expect(brief.split("\n")[0]).toBe("Setup: goals interview");
    expect(brief).toContain("start with New customers");
    expect(brief).toContain("Never save numbers they haven't agreed to");
    expect(brief).toContain("setting up Wandr Health's goals with Mark");
    expect(brief).toContain("Ambitious (about 30% on top of the trend)");
    expect(interviewBrief(["Revenue"])).toContain("with the person you're working with");
    expect(brief).toContain("Aggregates only");
    // It reasons out loud and uses the connectors' own summaries, not export downloads.
    expect(brief).toContain("Think out loud");
    expect(brief).toContain("an easier and a harder option");
    expect(brief).toContain("Don't download export files");
    expect(brief).toContain("already has agreed metrics");
    expect(operationsThreadId("c1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(operationsThreadId("c1")).toBe(operationsThreadId("c1"));
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr setup — routes, rhythm, operations chat, wipe", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const prompts: string[] = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    prompts.push(String(ctx.context.tethrPrompt));
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Scorecard: New customers 140 of 200, on track.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };

  const appFor = async (actor: Record<string, unknown>) => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", tethrRoutes(db));
    return app;
  };
  const mark = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-setup-"));
    process.env.TETHR_SETUP_FILE = path.join(dir, "setup.json");
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_OVERSEERS_FILE = path.join(dir, "overseers.json");
    process.env.TETHR_ARCHIVE_FILE = path.join(dir, "archive.json");
    process.env.TETHR_MOUNTS_FILE = path.join(dir, "mounts.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-setup-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    initTethrAdapter(db);
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    resetAssistantRunnerForTests();
    await tempDb?.cleanup();
  });

  it("saves the company and you (its admin), then the focus areas and growth pace", async () => {
    const app = await appFor(mark);
    const before = await request(app).get(`/api/tethr/${companyId}/setup`).expect(200);
    expect(before.body.state.completedAt).toBeNull();
    expect(before.body.checks.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(["stripe", "posthog", "google_ads", "slack_bot", "jev", "slack_listen"]));
    expect(before.body.mission).toMatch(/small team/);
    expect(before.body.positions.map((p: { key: string }) => p.key)).toContain("cto");
    expect(before.body.state).toMatchObject({ growthPace: "balanced", autoAdjust: true, ideas: { level: "normal", adaptive: true, slackListen: true } });

    // Step 1: the company and you.
    await request(app).put(`/api/tethr/${companyId}/setup/company`).send({ companyName: "", adminName: "Mark", position: "coo" }).expect(400);
    await request(app).put(`/api/tethr/${companyId}/setup/company`).send({ companyName: "Wandr Health", adminName: "Mark", position: "nope" }).expect(400);
    await request(app).put(`/api/tethr/${companyId}/setup/company`).send({ companyName: "Wandr Health", adminName: "Mark", position: "coo", slackUserId: "bad" }).expect(400);
    const company = await request(app)
      .put(`/api/tethr/${companyId}/setup/company`)
      .send({ companyName: "Wandr Health", sells: "Travel medicine online", adminName: "Mark Karam", adminEmail: "mark@travelwithwandr.com", position: "coo", slackUserId: "u0abcdef1", timezone: "America/Chicago", internalAddresses: ["travelwithwandr.com"] })
      .expect(200);
    expect(company.body.profile).toMatchObject({ name: "Wandr Health", sells: "Travel medicine online" });
    expect(company.body.profile.admin).toMatchObject({ name: "Mark Karam", position: "coo", title: "COO / Operations", role: "admin", slackUserId: "U0ABCDEF1" });
    expect(company.body.state.timezone).toBe("America/Chicago");
    expect(company.body.state.steps.company).toBeTruthy();

    // Step 2: what to work on first, and how hard to push.
    await request(app).put(`/api/tethr/${companyId}/setup/focus`).send({ areas: [] }).expect(400);
    const focus = await request(app)
      .put(`/api/tethr/${companyId}/setup/focus`)
      .send({ areas: ["New customers", "Revenue", "Partnerships & distribution"], growthPace: "ambitious", autoAdjust: true })
      .expect(200);
    expect(focus.body.goals.company.title).toBe("Wandr Health: grow with a small team");
    expect(focus.body.goals.goals.map((g: { title: string }) => g.title)).toEqual(["New customers", "Revenue", "Partnerships & distribution"]);
    expect(focus.body.state.growthPace).toBe("ambitious");

    // Dropping an area with no numbers cancels it (kept, not deleted).
    const again = await request(app).put(`/api/tethr/${companyId}/setup/focus`).send({ areas: ["New customers", "Revenue"] }).expect(200);
    expect(again.body.goals.goals.map((g: { title: string }) => g.title)).toEqual(["New customers", "Revenue"]);

    const agent = await appFor({ type: "agent", agentId: "a1", companyId });
    await request(agent).put(`/api/tethr/${companyId}/setup/company`).send({ companyName: "x", adminName: "x", position: "coo" }).expect(403);
  });

  it("folds an interview that ran in a side chat into the empty main chat, with its session", async () => {
    const [old] = await db
      .insert(tethrRouteRuns)
      .values({ companyId, requestText: "Setup: goals interview", invocationSource: "chat", status: "done", sourceKey: "chat-system" })
      .returning();
    await db.update(tethrRouteRuns).set({ threadId: old.id }).where(eq(tethrRouteRuns.id, old.id));
    await addSideChat(companyId, old.id, "Goals interview");
    await setSession(companyId, old.id, { sessionId: "s-old", sessionParams: null, lastTurnAt: new Date().toISOString(), contextTokens: 10 });
    await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: old.id }));

    expect(await foldInterviewIntoMainChat(db, companyId)).toBe(true);
    const [moved] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, old.id));
    expect(moved.threadId).toBe(companyId);
    expect(getSession(companyId, companyId)?.sessionId).toBe("s-old");
    expect(getSession(companyId, old.id)).toBeNull();
    expect(listSideChats(companyId).some((c) => c.threadId === old.id)).toBe(false);
    expect(getSetup(companyId).interviewThreadId).toBe(companyId);
    expect(await foldInterviewIntoMainChat(db, companyId)).toBe(false);

    // Undo, so the next test starts the interview fresh in an empty main chat.
    await db.delete(tethrRouteRuns).where(eq(tethrRouteRuns.id, old.id));
    await clearSession(companyId, companyId);
    await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: null }));
  });

  it("starts the goals interview once, in the main chat", async () => {
    const app = await appFor(mark);
    const first = await request(app).post(`/api/tethr/${companyId}/setup/interview`).send({}).expect(200);
    expect(first.body).toEqual({ threadId: companyId, started: true });
    const second = await request(app).post(`/api/tethr/${companyId}/setup/interview`).send({}).expect(200);
    expect(second.body).toEqual({ threadId: companyId, started: false });
    expect(listSideChats(companyId).some((c) => c.title === "Goals interview")).toBe(false);
    const turns = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.threadId, companyId));
    expect(turns).toHaveLength(1);
    expect(turns[0].requestText.startsWith("Setup: goals interview")).toBe(true);
    expect(turns[0].sourceKey).toBe("chat-system");
    // The interview is the last step: starting it finishes setup, so the chat it
    // opens never asks the person to "finish setting up".
    expect(getSetup(companyId).completedAt).toBeTruthy();
  });

  it("keeps the forms first and the conversation last", () => {
    expect(SETUP_STEPS).toEqual(["company", "focus", "connect", "rhythm", "autonomy", "interview"]);
  });

  it("saves the On its own step through the same settings as Integrations", async () => {
    const app = await appFor(mark);
    const saved = await request(app)
      .put(`/api/tethr/${companyId}/setup/autonomy`)
      .send({ newAgents: "auto", actOnReports: true, dailyReview: { enabled: true, time: "07:30" }, learner: true, defaultMode: "auto" })
      .expect(200);
    expect(saved.body.steps.autonomy).toBeTruthy();
    const cfg = getIntegrations(companyId);
    expect(cfg.team.newAgents).toBe("auto");
    expect(cfg.team.autonomy.actOnReports).toBe(true);
    expect(cfg.team.autonomy.dailyReview).toMatchObject({ enabled: true, time: "07:30", weekdaysOnly: true });
    expect(cfg.defaultMode).toBe("auto");
    const view = await request(app).get(`/api/tethr/${companyId}/setup`).expect(200);
    expect(view.body.autonomy).toMatchObject({ newAgents: "auto", actOnReports: true, learner: true, defaultMode: "auto" });
    // The learner is a real agent on the team, made because a person switched it on.
    const sage = await teamService(db).get(companyId, "@sage");
    expect(sage).toMatchObject({ sandbox: true, paused: false });

    // Off again pauses it; a mode setup doesn't offer (read, off) is ignored, never applied.
    await request(app)
      .put(`/api/tethr/${companyId}/setup/autonomy`)
      .send({ newAgents: "ask", actOnReports: false, dailyReview: { enabled: false }, learner: false, defaultMode: "off" })
      .expect(200);
    expect(getIntegrations(companyId).defaultMode).toBe("auto");
    expect(getIntegrations(companyId).team.newAgents).toBe("ask");
    expect((await teamService(db).get(companyId, "@sage"))?.paused).toBe(true);
    await updateIntegrations(companyId, { defaultMode: "ask" });

    const agent = await appFor({ type: "agent", agentId: "a1", companyId });
    await request(agent).put(`/api/tethr/${companyId}/setup/autonomy`).send({ newAgents: "auto" }).expect(403);
    expect(getIntegrations(companyId).team.newAgents).toBe("ask");
  });

  it("links the admin's Slack member ID by itself, and clears the claim it answers", async () => {
    const app = await appFor(mark);
    await updateSetup(companyId, (st) => ({ ...st, slackClaim: { slackUserId: "U0CLAIM01", name: "Mark", at: new Date().toISOString() } }));
    await request(app).put(`/api/tethr/${companyId}/setup/admin-slack`).send({ slackUserId: "not an id" }).expect(400);
    const linked = await request(app).put(`/api/tethr/${companyId}/setup/admin-slack`).send({ slackUserId: "u0claim01" }).expect(200);
    expect(linked.body.profile.admin.slackUserId).toBe("U0CLAIM01");
    expect(linked.body.state.slackClaim).toBeNull();
    const view = await request(app).get(`/api/tethr/${companyId}/setup`).expect(200);
    expect(view.body.checks.find((c: { key: string }) => c.key === "approver")).toMatchObject({ ok: true, detail: "Linked" });
    const agent = await appFor({ type: "agent", agentId: "a1", companyId });
    await request(agent).put(`/api/tethr/${companyId}/setup/admin-slack`).send({ slackUserId: "U0OTHER02" }).expect(403);
  });

  it("never folds a side chat into a main chat that already has turns", async () => {
    const [side] = await db
      .insert(tethrRouteRuns)
      .values({ companyId, requestText: "Setup: goals interview", invocationSource: "chat", status: "done" })
      .returning();
    await db.update(tethrRouteRuns).set({ threadId: side.id }).where(eq(tethrRouteRuns.id, side.id));
    await addSideChat(companyId, side.id, "Goals interview");
    const before = getSetup(companyId).interviewThreadId;
    await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: side.id }));
    expect(await foldInterviewIntoMainChat(db, companyId)).toBe(false);
    expect(listSideChats(companyId).some((c) => c.threadId === side.id)).toBe(true);
    await updateSetup(companyId, (s) => ({ ...s, interviewThreadId: before }));
  });

  it("turns the chosen rhythm into core routines in the right time zone, and pauses the rest", async () => {
    const app = await appFor(mark);
    await request(app)
      .put(`/api/tethr/${companyId}/setup/rhythm`)
      .send({ rhythm: { plan: { enabled: true, cron: "0 9 * * 1", slack: false } } })
      .expect(200);
    await request(app)
      .put(`/api/tethr/${companyId}/setup/rhythm`)
      .send({ rhythm: { scorecard: { enabled: true, cron: "bad", slack: false } } })
      .expect(400);
    const saved = await request(app)
      .put(`/api/tethr/${companyId}/setup/rhythm`)
      .send({ rhythm: { plan: { enabled: false, cron: "0 9 * * 1" }, scorecard: { enabled: true, cron: "0 15 * * 5" } } })
      .expect(200);
    const plan = saved.body.rhythm.plan;
    const scorecard = saved.body.rhythm.scorecard;
    expect(plan.routineId).toBeTruthy();
    const [planRoutine] = await db.select().from(routines).where(eq(routines.id, plan.routineId));
    const [scoreRoutine] = await db.select().from(routines).where(eq(routines.id, scorecard.routineId));
    expect(planRoutine.status).toBe("paused");
    expect(scoreRoutine).toMatchObject({ title: "Weekly scorecard", status: "active" });
    expect(scoreRoutine.description).toContain("record_metric");
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, scoreRoutine.id));
    expect(trigger).toMatchObject({ cronExpression: "0 15 * * 5", timezone: "America/Chicago", enabled: true });
    const [planTrigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, planRoutine.id));
    expect(planTrigger.enabled).toBe(false);
    // Brief was never chosen: no routine at all.
    expect(saved.body.rhythm.brief.routineId).toBeUndefined();
    expect(getSetup(companyId).steps.rhythm).toBeTruthy();
    // Saving again updates the same routines instead of making new ones.
    const again = await applyRhythm(db, companyId, getSetup(companyId).rhythm, "America/Chicago", { userId: "mark" });
    expect(again.scorecard.routineId).toBe(scorecard.routineId);
    expect(await db.select().from(routines).where(and(eq(routines.companyId, companyId), eq(routines.title, "Weekly scorecard")))).toHaveLength(1);
  });

  it("runs a scheduled task as a turn in the Operations chat and waits for it", async () => {
    const scoreId = getSetup(companyId).rhythm.scorecard.routineId!;
    const [routine] = await db.select().from(routines).where(eq(routines.id, scoreId));
    const issue = {
      id: "00000000-0000-4000-8000-000000000123",
      title: routine.title,
      identifier: "WD-9",
      description: routine.description,
      originId: routine.id,
    } as unknown as typeof issues.$inferSelect;
    const out = await runTaskInOperationsChat(db, { companyId, issue, pollMs: 20 });
    expect(out).toMatchObject({ status: "done", text: "Scorecard: New customers 140 of 200, on track." });
    const ops = operationsThreadId(companyId);
    expect(listSideChats(companyId).find((c) => c.threadId === ops)?.title).toBe("Operations");
    const [turn] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, out.runId!));
    expect(turn.threadId).toBe(ops);
    expect(turn.requestText).toMatch(/^Scheduled: Weekly scorecard \(WD-9\)/);
    expect(prompts.at(-1)).toContain("[From Tethr, not the user] Scheduled: Weekly scorecard");
  });

  it("skips a scheduled turn when agents are paused, instead of calling it done", async () => {
    const { setThrottle } = await import("../tethr/throttle.ts");
    const scoreId = getSetup(companyId).rhythm.scorecard.routineId!;
    const issue = { id: "00000000-0000-4000-8000-000000000124", title: "Weekly scorecard", identifier: "WD-10", description: "Measure.", originId: scoreId } as unknown as typeof issues.$inferSelect;
    await setThrottle(companyId, true, { by: "test" });
    try {
      const out = await runTaskInOperationsChat(db, { companyId, issue, pollMs: 20 });
      expect(out.status).toBe("skipped");
      expect(out.text).toMatch(/agents were paused/);
    } finally {
      await setThrottle(companyId, false, { by: "test" });
    }
  });

  it("stops a scheduled turn that runs past its time, so the task and the chat agree", async () => {
    // Hold the Operations chat with a turn that doesn't finish, so the scheduled one waits in line.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      await held;
      return fakeExecute(ctx);
    };
    setAssistantRunnerForTests(assistantRunner(db, { execute: slow }));
    try {
      const { getAssistantRunner } = await import("../tethr/assistant/runner.ts");
      const blocker = await getAssistantRunner(db).send({ companyId, threadId: operationsThreadId(companyId), text: "busy", kind: "user" } as never);
      const issue = { id: "00000000-0000-4000-8000-000000000125", title: "Weekly plan", identifier: "WD-11", description: "Plan.", originId: null } as unknown as typeof issues.$inferSelect;
      const out = await runTaskInOperationsChat(db, { companyId, issue, pollMs: 20, waitMs: 300 });
      expect(out.status).toBe("failed");
      expect(out.text).toMatch(/so it was stopped/);
      const [turn] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, out.runId!));
      expect(turn.status).toBe("stopped");
      release();
      for (let i = 0; i < 100; i++) {
        const [b] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, blocker.routeRunId));
        if (b && ["done", "failed", "stopped"].includes(b.status)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      release();
      setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    }
  });

  it("tells Slack it's ready and where, with the scorecard's numbers from the goals, never the chat's words", async () => {
    const { rhythmSlackText } = await import("../tethr/rhythm.ts");
    process.env.PAPERCLIP_PUBLIC_URL = "https://tethr.example.com/";
    try {
      const brief = await rhythmSlackText(db, companyId, "brief");
      expect(brief).toBe(`*Daily brief* is ready in tethr's <https://tethr.example.com/chat?chat=${operationsThreadId(companyId)}|Operations chat>.`);
      const score = await rhythmSlackText(db, companyId, "scorecard");
      expect(score.split("\n")[0]).toMatch(/^\*Friday scorecard\* is ready/);
      expect(score).not.toContain("Scorecard: New customers 140 of 200");
    } finally {
      delete process.env.PAPERCLIP_PUBLIC_URL;
    }
    expect(await rhythmSlackText(db, companyId, "plan")).toBe("*Monday plan* is ready in tethr's Operations chat.");
  });

  it("runs an item once even when it isn't switched on (creates it paused)", async () => {
    const { runRhythmNow } = await import("../tethr/rhythm.ts");
    expect(getSetup(companyId).rhythm.brief.routineId).toBeUndefined();
    const out = await runRhythmNow(db, companyId, "brief", { userId: "mark" });
    expect(out.issueId).toBeTruthy();
    const briefId = getSetup(companyId).rhythm.brief.routineId!;
    const [brief] = await db.select().from(routines).where(eq(routines.id, briefId));
    expect(brief).toMatchObject({ title: "Morning brief", status: "paused" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, out.issueId!));
    expect(issue).toMatchObject({ originKind: "routine_execution", originId: briefId });
    // Core wakes @tethr for it; the adapter runs it as a turn in the Operations
    // chat (the fake runner answers) and closes the task. Wait for that.
    let status = issue.status;
    for (let i = 0; i < 250 && status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      [{ status }] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, out.issueId!));
    }
    expect(status).toBe("done");
    const turns = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.threadId, operationsThreadId(companyId)));
    expect(turns.some((t) => t.requestText.startsWith("Scheduled: Morning brief"))).toBe(true);
  }, 40_000);

  it("re-creates an item's routine if it was deleted, instead of failing every Measure now", async () => {
    const { runRhythmNow } = await import("../tethr/rhythm.ts");
    const { updateSetup } = await import("../tethr/setup.ts");
    // The saved id points at a routine that no longer exists (deleted on the Routines page).
    const gone = "00000000-0000-4000-8000-0000000000aa";
    await updateSetup(companyId, (st) => ({ ...st, rhythm: { ...st.rhythm, brief: { ...st.rhythm.brief, routineId: gone } } }));
    const out = await runRhythmNow(db, companyId, "brief", { userId: "mark" });
    expect(out.issueId).toBeTruthy();
    const newId = getSetup(companyId).rhythm.brief.routineId!;
    expect(newId).not.toBe(gone);
    expect(await db.select().from(routines).where(eq(routines.id, newId))).toHaveLength(1);
    let status = "";
    for (let i = 0; i < 250 && status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      [{ status }] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, out.issueId!));
    }
    expect(status).toBe("done");
  }, 40_000);

  it("marks setup complete", async () => {
    const app = await appFor(mark);
    const done = await request(app).post(`/api/tethr/${companyId}/setup/complete`).send({}).expect(200);
    expect(done.body.completedAt).toBeTruthy();
    expect(DEFAULT_RHYTHM.plan.enabled).toBe(false); // nothing is on by default
  });

  it("a wipe that leaves a company standing keeps the shared Drive folder, Memory.md and transcripts", async () => {
    const mirror = path.join(dir, "drive-partial", "00 Tethr");
    const ws = path.join(mirror, "tethr");
    fs.mkdirSync(path.join(mirror, "01 Briefs"), { recursive: true });
    fs.writeFileSync(path.join(mirror, "01 Briefs", "live brief.md"), "live");
    fs.mkdirSync(path.join(ws, "files"), { recursive: true });
    fs.writeFileSync(path.join(ws, "Memory.md"), "live memory");
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude-home-partial");
    process.env.TETHR_MIRROR_ALLOW_TEST = "1";
    process.env.TETHR_MIRROR_DIR = mirror;
    const transcripts = transcriptDirFor(ws);
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, "live.jsonl"), "{}");
    try {
      const [other] = await db.insert(companies).values({ name: "Old Org", issuePrefix: "OLD" } as never).returning();
      const plan = await planReset(db, ["OLD"]);
      expect(plan.companies.map((c) => c.id)).toEqual([other.id]);
      expect(plan.keptCompanies.some((k) => k.includes("Wandr") || k.startsWith("WD"))).toBe(true);
      expect(plan.driveMoves).toEqual([]);
      expect(plan.transcriptDirs).toEqual([]);

      const result = await runReset(db, ["OLD"]);
      expect(result.errors).toEqual([]);
      expect(result.deletedCompanies).toHaveLength(1);
      expect(result.moved).toEqual([]);
      expect(fs.readFileSync(path.join(ws, "Memory.md"), "utf8")).toBe("live memory");
      expect(fs.existsSync(path.join(mirror, "01 Briefs", "live brief.md"))).toBe(true);
      expect(fs.existsSync(path.join(transcripts, "live.jsonl"))).toBe(true);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.TETHR_MIRROR_ALLOW_TEST;
      delete process.env.TETHR_MIRROR_DIR;
    }
  });

  it("wipes whole companies, cleans their stores, archives Drive files and old transcripts", async () => {
    const mirror = path.join(dir, "drive", "00 Tethr");
    const ws = path.join(mirror, "tethr");
    fs.mkdirSync(path.join(mirror, "01 Briefs"), { recursive: true });
    fs.writeFileSync(path.join(mirror, "01 Briefs", "old brief.md"), "old");
    fs.writeFileSync(path.join(mirror, "00 START HERE.md"), "old guide");
    fs.writeFileSync(path.join(mirror, "Open Tethr Command Center.command"), "#!/bin/sh");
    fs.mkdirSync(path.join(ws, "files"), { recursive: true });
    fs.writeFileSync(path.join(ws, "files", "plan.md"), "x");
    fs.writeFileSync(path.join(ws, "Memory.md"), "old memory");
    fs.writeFileSync(path.join(ws, "CLAUDE.md"), "generated");
    const claudeHome = path.join(dir, "claude-home");
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.TETHR_MIRROR_ALLOW_TEST = "1";
    process.env.TETHR_MIRROR_DIR = mirror;
    process.env.TETHR_WORKSPACE_DIR = "";
    delete process.env.TETHR_WORKSPACE_DIR;
    const transcripts = transcriptDirFor(ws);
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, "abc.jsonl"), "{}");
    // The learner's sealed room isn't per company: a new learner mustn't inherit it.
    const room = path.join(process.env.TETHR_ASSISTANT_HOME!, "sandbox", "sage");
    fs.mkdirSync(room, { recursive: true });
    fs.writeFileSync(path.join(room, "notes.md"), "old study");
    const roomTranscripts = transcriptDirFor(room);
    fs.mkdirSync(roomTranscripts, { recursive: true });
    fs.writeFileSync(path.join(roomTranscripts, "s.jsonl"), "{}");
    try {
      const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
      // Like core's onboarding wizard: a project linked to the mission goal.
      const { goals, projects } = await import("@paperclipai/db");
      const [mission] = await db.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.level, "company")));
      await db.insert(projects).values({ companyId, name: "Onboarding", goalId: mission.id } as never);
      const now = new Date("2026-11-07T12:00:00Z");
      const plan = await planReset(db, [co.issuePrefix!], now);
      expect(plan.companies).toHaveLength(1);
      expect(plan.companies[0].counts.goals).toBeGreaterThan(0);
      expect(plan.driveMoves.map((m) => m.from)).toEqual(["00 START HERE.md", "01 Briefs", path.join("tethr", "files"), path.join("tethr", "Memory.md")]);
      expect(plan.archiveDir).toBe(path.join("99 Archive", "2026-11 before fresh start"));

      const result = await runReset(db, [co.issuePrefix!], now);
      expect(result.errors).toEqual([]);
      expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
      expect(result.storesCleaned).toEqual(expect.arrayContaining(["setup.json", "chats.json"]));
      expect(getSetup(companyId).completedAt).toBeNull();
      const archived = path.join(mirror, "99 Archive", "2026-11 before fresh start");
      expect(fs.readFileSync(path.join(archived, "01 Briefs", "old brief.md"), "utf8")).toBe("old");
      expect(fs.readFileSync(path.join(archived, "tethr", "Memory.md"), "utf8")).toBe("old memory");
      expect(fs.existsSync(path.join(archived, "tethr", "files", "plan.md"))).toBe(true);
      expect(fs.existsSync(path.join(mirror, "Open Tethr Command Center.command"))).toBe(true);
      expect(fs.existsSync(path.join(ws, "CLAUDE.md"))).toBe(true);
      expect(fs.existsSync(transcripts)).toBe(false);
      expect(fs.existsSync(roomTranscripts)).toBe(false);
      expect(result.transcriptsDeleted).toBe(2);
      expect(fs.existsSync(room)).toBe(false);
      const movedRoom = path.join(process.env.TETHR_ASSISTANT_HOME!, "archive", "2026-11 before fresh start", "sandbox", "sage");
      expect(fs.readFileSync(path.join(movedRoom, "notes.md"), "utf8")).toBe("old study");
      expect(result.moved).toContain(movedRoom);
      // A fresh company seeds cleanly afterwards.
      const fresh = await seedTethrCore(db);
      expect(fresh.companyId).not.toBe(companyId);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.TETHR_MIRROR_ALLOW_TEST;
      delete process.env.TETHR_MIRROR_DIR;
    }
  });

  it("keeps the wipe endpoint shut unless it's switched on, and demands a backup", async () => {
    const app = await appFor(mark);
    delete process.env.TETHR_ALLOW_RESET;
    await request(app).get(`/api/tethr/admin/reset/plan?prefixes=WD`).expect(404);
    process.env.TETHR_ALLOW_RESET = "true";
    try {
      await request(app).get(`/api/tethr/admin/reset/plan?prefixes=WD`).expect(200);
      await request(app).post(`/api/tethr/admin/reset`).send({ prefixes: "WD", confirm: "yes" }).expect(400);
      const noBackup = await request(app).post(`/api/tethr/admin/reset`).send({ prefixes: "WD", confirm: "WIPE WD", backupFile: "/nope.sql" }).expect(400);
      expect(noBackup.body.error).toMatch(/backup/);
      const member = await appFor({ type: "board", source: "session", userId: "u2", isInstanceAdmin: false });
      await request(member).get(`/api/tethr/admin/reset/plan?prefixes=WD`).expect(403);
    } finally {
      delete process.env.TETHR_ALLOW_RESET;
    }
  });
});
