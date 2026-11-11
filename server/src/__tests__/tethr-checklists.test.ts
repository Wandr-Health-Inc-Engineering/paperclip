import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { runTethrTool, TETHR_TOOL_DEFS } from "../tethr/assistant/tethr-tools.ts";
import { classify } from "../tethr/assistant/policy.ts";
import { sandboxRefusal } from "../tethr/assistant/sandbox.ts";
import { CHECKLIST_LIMITS, checklistDoneText, checklistStore, ChecklistInputError, getChecklist, parseChecklist } from "../tethr/assistant/checklists.ts";
import { ensureWorkspace } from "../tethr/assistant/workspace.ts";
import { AGENT_ALWAYS_TOOLS, agentIdentityText } from "../tethr/team-spec.ts";
import { playbooksContextText, playbooksForJob } from "../tethr/growth-map/playbooks.ts";
import { GROWTH_AREAS } from "../tethr/growth-map/areas.ts";
import { takeNotes } from "../tethr/chats.ts";
import { tethrRoutes } from "../routes/tethr.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Mark, 2026-11-10: when something has to be done by him outside tethr (set up a
// Google Ads campaign), tethr should hand him a checklist, not prose; and it
// should use its paid-ads expertise (a small budget isn't five ad groups).

const ALL_PLAYBOOKS = new Set(GROWTH_AREAS.flatMap((a) => a.playbooks));

describe("checklists and playbooks: the pure parts", () => {
  it("takes a title, an optional why and 2 to 12 one-line steps, each with optional detail and text to paste", () => {
    const parsed = parseChecklist({
      title: "  Launch the malaria\nsearch campaign ",
      why: "First paid test.",
      steps: [{ do: "Create a Search campaign", detail: "Campaigns → New\r\nGoal: Leads", copy: "malaria pills\ntravel malaria prescription" }, "Set the budget to $10 a day"],
    });
    expect(parsed).toEqual({
      title: "Launch the malaria search campaign",
      why: "First paid test.",
      steps: [
        { do: "Create a Search campaign", detail: "Campaigns → New\nGoal: Leads", copy: "malaria pills\ntravel malaria prescription" },
        { do: "Set the budget to $10 a day", detail: null, copy: null },
      ],
    });
    expect(() => parseChecklist({ steps: ["a", "b"] })).toThrow(/title/);
    expect(() => parseChecklist({ title: "x", steps: ["only one"] })).toThrow(/2 to 12 steps/);
    expect(() => parseChecklist({ title: "x", steps: Array.from({ length: CHECKLIST_LIMITS.maxSteps + 1 }, (_, i) => `step ${i}`) })).toThrow(/2 to 12 steps/);
    expect(() => parseChecklist({ title: "x", steps: [{ detail: "no action" }, "b"] })).toThrow(/Step 1 needs/);
    expect(() => parseChecklist({ title: "x", steps: ["a", { do: "b", copy: "c".repeat(CHECKLIST_LIMITS.copy + 1) }] })).toThrow(ChecklistInputError);
  });

  it("is a draft inside tethr that every agent has, kept from the sealed learner", () => {
    const ctx = { workspaceDir: "/w", readableRoots: ["/w"], internalAddresses: [] };
    expect(classify("mcp__tethr__checklist", { title: "Launch the campaign" }, ctx)).toMatchObject({ cls: "draft", summary: "Making you a checklist: “Launch the campaign”" });
    expect(TETHR_TOOL_DEFS.some((d) => d.name === "checklist")).toBe(true);
    expect(AGENT_ALWAYS_TOOLS).toContain("checklist");
    for (const room of ["desk", "plan", "research", "apply"] as const) expect(sandboxRefusal("@sage", "mcp__tethr__checklist", room)).toMatch(/blocked/);
  });

  it("names each area's installed playbooks and says to load them first; nothing when none are installed", () => {
    const text = playbooksContextText(new Set(["paid-ads", "seo-audit"]))!;
    expect(text).toMatch(/^## Playbooks/);
    expect(text).toContain("load its playbook with the Skill tool");
    expect(text).toContain("- Paid ads: paid-ads");
    expect(text).toContain("seo-audit");
    expect(text).not.toContain("ad-creative");
    expect(playbooksContextText(new Set())).toBeNull();
  });

  it("gives an agent the playbooks for its job, and tells it to use them; never the sealed learner", () => {
    expect(playbooksForJob("Paid search lead: runs our Google Ads campaigns", ALL_PLAYBOOKS)).toEqual(["paid-ads", "ad-creative"]);
    expect(playbooksForJob("Paid search lead", new Set(["paid-ads"]))).toEqual(["paid-ads"]);
    expect(playbooksForJob("Keeps the office tidy", ALL_PLAYBOOKS)).toEqual([]);
    const base = { tag: "@paid-ads", name: "Paid Ads", title: "Paid search lead", mission: "Run paid search.", instructions: "Test Google Ads.", connectors: [] };
    const identity = agentIdentityText({ ...base, playbooks: ["paid-ads", "ad-creative"] });
    expect(identity).toContain("Your playbooks: paid-ads, ad-creative. Load them with the Skill tool");
    expect(identity).toContain("checklist tool");
    expect(identity).toContain("small budget");
    const learner = agentIdentityText({ ...base, tag: "@sage", playbooks: ["paid-ads"], sandbox: true });
    expect(learner).not.toContain("Your playbooks");
    expect(learner).not.toContain("checklist tool");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("checklists: handed over, ticked off, put away", () => {
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
  const AGENT = { type: "agent", agentId: "a1", companyId: "" };
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
  const CAMPAIGN = {
    title: "Launch the malaria search campaign",
    why: "A first paid test on the highest-intent searches.",
    steps: [
      { do: "In Google Ads, create a Search campaign named Malaria · Exact", copy: "Malaria · Exact" },
      { do: "Set the daily budget to $15", detail: "Settings → Budget" },
      { do: "Add the keywords as exact match", copy: "[malaria pills]\n[malaria prescription online]" },
    ],
  };
  const makeChecklist = (args: Record<string, unknown>, threadId: string, runId?: string) =>
    runTethrTool("checklist", args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId, runId });
  const settle = async (runId: string) => {
    for (let i = 0; i < 300; i++) {
      const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
      if (row && ["done", "failed", "stopped"].includes(row.status)) return row;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("turn never finished");
  };
  const say = async (text: string) =>
    (await request(appFor(PERSON)).post(`/api/tethr/${companyId}/chats/${companyId}/messages`).send({ text }).expect(200)).body.routeRunId as string;
  const turnsOf = async () => (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/chats/${companyId}/runs`).expect(200)).body as Array<Record<string, unknown>>;
  const needsYou = async () => (await request(appFor(PERSON)).get(`/api/tethr/${companyId}/needs-you`).expect(200)).body as { count: number; checklists: Array<{ id: string; from: string }> };
  const tick = (id: string, stepId: string, body: unknown, actor: Record<string, unknown> = PERSON) =>
    request(appFor(actor)).post(`/api/tethr/${companyId}/checklists/${id}/steps/${stepId}`).send(body as object);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-checklists-"));
    for (const [key, name] of [
      ["TETHR_SETUP_FILE", "setup.json"],
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_PAUSED_FILE", "paused.json"],
      ["TETHR_OVERSEERS_FILE", "overseers.json"],
      ["TETHR_QUESTIONS_FILE", "questions.json"],
      ["TETHR_CHECKLISTS_FILE", "checklists.json"],
      ["TETHR_MEMORY_FILE", "memory.json"],
    ]) {
      process.env[key!] = path.join(dir, name!);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    // One playbook "installed", so the chat's CLAUDE.md lists it.
    process.env.TETHR_SKILLS_DIR = path.join(dir, "skills");
    fs.mkdirSync(path.join(dir, "skills", "paid-ads"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skills", "paid-ads", "SKILL.md"), "# paid-ads\n");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-checklists-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    AGENT.companyId = companyId;
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    resetAssistantRunnerForTests();
    delete process.env.TETHR_SKILLS_DIR;
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    calls.length = 0;
    await checklistStore.update(companyId, () => ({ checklists: [] }));
  });

  it("puts the playbooks, the budget rule and the checklist rule in the chat's CLAUDE.md", async () => {
    await settle(await say("Can you start a campaign?"));
    const md = fs.readFileSync(path.join(dir, "workspace", "CLAUDE.md"), "utf8");
    expect(md).toContain("## Playbooks");
    expect(md).toContain("- Paid ads: paid-ads");
    expect(md.indexOf("## Playbooks")).toBeLessThan(md.indexOf("## Deciding what to do"));
    expect(md).toContain("A small budget or a first test gets one channel and one campaign");
    expect(md).toContain("Hand them a checklist with the checklist tool");
    // Without any playbook installed, no empty section.
    await ensureWorkspace({ playbooks: null });
    expect(fs.readFileSync(path.join(dir, "workspace", "CLAUDE.md"), "utf8")).not.toContain("## Playbooks");
  });

  it("shows under the turn that made it, and in Needs you; one of a title per chat, at most three open", async () => {
    const turn = await say("Can you start a campaign?");
    await settle(turn);
    const made = await makeChecklist(CAMPAIGN, companyId, turn);
    expect(made.isError).toBeFalsy();
    expect(made.text).toContain("card right under your reply");
    expect((await makeChecklist(CAMPAIGN, companyId, turn)).text).toMatch(/already with the person/);

    const shown = (await turnsOf()).find((r) => r.id === turn)!.checklists as Array<{ id: string; status: string; agentTag: string | null; steps: unknown[] }>;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ status: "open", agentTag: null });
    expect(shown[0]!.steps).toHaveLength(3);
    const waiting = await needsYou();
    expect(waiting.count).toBe(1);
    expect(waiting.checklists[0]).toMatchObject({ id: shown[0]!.id, from: "your chat with tethr" });

    await makeChecklist({ ...CAMPAIGN, title: "Connect PostHog" }, companyId, turn);
    await makeChecklist({ ...CAMPAIGN, title: "Add the pixel" }, companyId, turn);
    expect((await makeChecklist({ ...CAMPAIGN, title: "One too many" }, companyId, turn)).text).toMatch(/3 checklists are still open/);
  });

  it("ticks steps as the person goes; the last tick tells the chat, as the person's own message", async () => {
    await makeChecklist(CAMPAIGN, companyId);
    const list = checklistStore.get(companyId).checklists![0]!;
    const [first, second, third] = list.steps;

    await tick(list.id, first!.id, { done: true }, AGENT).expect(403);
    await tick(list.id, first!.id, { done: "yes" }).expect(400);
    await tick(list.id, "nope", { done: true }).expect(409);

    const one = await tick(list.id, first!.id, { done: true }).expect(200);
    expect(one.body).toMatchObject({ routeRunId: null, checklist: { status: "open" } });
    await tick(list.id, second!.id, { done: true }).expect(200);
    // Unticking is fine.
    await tick(list.id, second!.id, { done: false }).expect(200);
    expect(getChecklist(companyId, list.id)!.steps[1]!.done).toBe(false);
    await tick(list.id, second!.id, { done: true }).expect(200);
    expect(calls).toHaveLength(0);

    const last = await tick(list.id, third!.id, { done: true }).expect(200);
    expect(last.body.checklist).toMatchObject({ status: "done" });
    const turn = await settle(last.body.routeRunId);
    expect(turn).toMatchObject({ requestText: checklistDoneText(getChecklist(companyId, list.id)!), sourceKey: null, requestedByUserId: "mark" });
    expect(calls.at(-1)).toContain('I finished the checklist "Launch the malaria search campaign"');
    expect((await needsYou()).checklists).toHaveLength(0);
  });

  it("can be put away unfinished: it leaves Needs you, and the chat is told not to bring it up again", async () => {
    await makeChecklist(CAMPAIGN, companyId);
    const list = checklistStore.get(companyId).checklists![0]!;
    await tick(list.id, list.steps[0]!.id, { done: true }).expect(200);
    await request(appFor(AGENT)).post(`/api/tethr/${companyId}/checklists/${list.id}/dismiss`).send({}).expect(403);
    await request(appFor(PERSON)).post(`/api/tethr/${companyId}/checklists/missing/dismiss`).send({}).expect(404);

    const res = await request(appFor(PERSON)).post(`/api/tethr/${companyId}/checklists/${list.id}/dismiss`).send({}).expect(200);
    expect(res.body.checklist.status).toBe("dismissed");
    expect((await needsYou()).count).toBe(0);
    expect((await takeNotes(companyId, companyId)).join("\n")).toContain('put away the checklist "Launch the malaria search campaign" (1 of 3 steps ticked)');
    await request(appFor(PERSON)).post(`/api/tethr/${companyId}/checklists/${list.id}/dismiss`).send({}).expect(409);
    await tick(list.id, list.steps[1]!.id, { done: true }).expect(409);
    // No turn was started for it.
    expect(calls).toHaveLength(0);
  });
});
