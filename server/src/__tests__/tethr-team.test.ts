import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { agents, budgetPolicies, createDb, issues, routines, routineTriggers, tethrNotifications, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { initTethrAdapter } from "../tethr/adapter.ts";
import { assistantRunner, getAssistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { runTethrTool } from "../tethr/assistant/tethr-tools.ts";
import { handlePreToolUse } from "../tethr/assistant/hook-handler.ts";
import { issueHookToken, revokeHookToken } from "../tethr/assistant/gate.ts";
import { gatingService } from "../tethr/gating.ts";
import { notificationService } from "../tethr/notify.ts";
import { takeNotes } from "../tethr/chats.ts";
import { updateIntegrations } from "../tethr/integrations.ts";
import { setRoster } from "../tethr/overseers.ts";
import { deliverAgentReport, reportHeadline } from "../tethr/team-report.ts";
import { teamService, agentThreadId, type TeamAgent } from "../tethr/team.ts";
import {
  agentDenyRules,
  agentTaskText,
  agentToolRefusal,
  reportBody,
  scheduleWords,
  splitSlackSummary,
  TeamInputError,
  teamSpecText,
  validateTeamSpec,
} from "../tethr/team-spec.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 23: tethr runs a team of agents. Each agent is a real Paperclip agent
// that works its tasks as Claude session turns in its own chat, inside an
// allowlist of connectors, and reports back to the main chat, the bell and its
// owner on Slack.

const LABELS = ["Gmail", "Slack", "Google Drive", "Stripe", "Tethr tools"];
const SPEC = {
  name: "Price Scout",
  title: "Competitor pricing watch",
  mission: "Tracks what competitors charge so our offers stay sharp; moves Revenue.",
  instructions: "Check the three competitors' public price pages, note any change since last week, and write files/pricing/<date>.md with a table.",
  connectors: ["google drive", "Tethr tools"],
  schedule: { cron: "0 9 * * 1", brief: "Weekly price check: compare against last week's file and flag any change over 5%." },
  first_task: { title: "Baseline the competitors' prices", brief: "Make the first pricing table so next week has something to compare against." },
};

describe("tethr team — the spec, in words", () => {
  it("fills sensible defaults and canonical connector names", () => {
    const spec = validateTeamSpec(SPEC, { takenTags: ["@tethr"], connectors: LABELS });
    expect(spec).toMatchObject({
      tag: "@price-scout",
      connectors: ["Google Drive", "Tethr tools"],
      budgetMonthlyUsd: 15,
      maxRunsPerDay: 4,
      ownerRole: "growth",
      firstTask: { title: "Baseline the competitors' prices" },
    });
  });

  it("refuses taken or reserved tags, fast schedules, unknown connectors and big budgets", () => {
    const bad = (patch: Record<string, unknown>, taken: string[] = []) => () => validateTeamSpec({ ...SPEC, ...patch }, { takenTags: taken, connectors: LABELS });
    expect(bad({}, ["@price-scout"])).toThrow(/already taken/);
    expect(bad({ tag: "tethr" })).toThrow(/already taken/);
    expect(bad({ schedule: { cron: "*/5 * * * *", brief: "Every five minutes, check." } })).toThrow(/at most hourly/);
    expect(bad({ connectors: ["Fax machine"] })).toThrow(/Unknown connector/);
    expect(bad({ budget_usd: 500 })).toThrow(/between 1 and 50/);
    expect(bad({ instructions: "x".repeat(4_001) })).toThrow(TeamInputError);
  });

  it("says schedules in plain words", () => {
    expect(scheduleWords("0 9 * * 1")).toBe("every Monday at 9:00 am");
    expect(scheduleWords("30 14 * * 1-5")).toBe("weekdays at 2:30 pm");
    expect(scheduleWords("0 8 * * *", "America/Chicago")).toBe("every day at 8:00 am (America/Chicago)");
    expect(scheduleWords("0 9 * * 1,3,5")).toBe("every Monday, Wednesday and Friday at 9:00 am");
    expect(scheduleWords("0 9 1 * *")).toBe("on day 1 of each month at 9:00 am");
    expect(scheduleWords("15 * * * *")).toBe("every hour at :15");
  });

  it("puts the whole agent on its approval card, and its instructions in every task", () => {
    const spec = validateTeamSpec(SPEC, { takenTags: [], connectors: LABELS });
    const card = teamSpecText(spec, { ownerName: "Mark", why: "Pricing moves weekly." });
    expect(card).toContain("Runs: every Monday at 9:00 am, and when tethr assigns it work");
    expect(card).toContain("Limits: up to 4 runs a day, $15 a month (hard stop)");
    expect(card).toContain("Reports to: Mark (growth)");
    expect(card).toContain("First task: Baseline the competitors' prices");
    expect(card).toContain("Why: Pricing moves weekly.");
    const turn = agentTaskText({ ...spec }, { identifier: "WD-9", title: "Check prices", brief: "Do it." });
    expect(turn.split("\n")[0]).toBe("Task WD-9: Check prices");
    expect(turn).toContain(spec.instructions);
    expect(turn).toContain("You can't create agents or hand work to other agents.");
    expect(turn).toContain('starts "Slack summary:"');
  });

  it("splits off the one line that may go to Slack", () => {
    expect(splitSlackSummary("Report.\n\nSlack summary: Prices up 5% at two competitors.")).toEqual({ body: "Report.", summary: "Prices up 5% at two competitors." });
    expect(splitSlackSummary("**Slack summary:** All quiet.").summary).toBe("All quiet.");
    expect(splitSlackSummary("No summary here.")).toEqual({ body: "No summary here.", summary: null });
  });

  it("keeps the report, not the working notes streamed before it", () => {
    expect(reportBody("I'll look at the pages.\n\nFound two.\n\nReport:\nTwo clinics, $49 and $59.")).toBe("Two clinics, $49 and $59.");
    expect(reportBody("Notes.\n\n**Report:**\n\nAll quiet.")).toBe("All quiet.");
    expect(reportBody("## Report\nDone.")).toBe("Done.");
    expect(reportBody("Just the answer.")).toBe("Just the answer.");
    expect(reportBody("Report: inline text stays whole.")).toBe("Report: inline text stays whole.");
  });

  it("keeps an agent inside its connectors, away from the shell and tethr's team tools", () => {
    const rules = agentDenyRules(["Google Drive", "Tethr tools"], LABELS);
    expect(rules).toEqual(expect.arrayContaining(["mcp__claude_ai_Gmail", "mcp__claude_ai_Stripe", "mcp__tethr__create_agent", "Bash"]));
    expect(rules).not.toContain("mcp__claude_ai_Google_Drive");
    expect(rules).not.toContain("mcp__tethr");
    expect(agentDenyRules([], LABELS)).toContain("mcp__tethr");
    const scout = { tag: "@scout", connectors: ["Google Drive"] };
    expect(agentToolRefusal(scout, "mcp__claude_ai_Gmail__send_message", "Gmail")).toMatch(/isn't set up to use Gmail/);
    expect(agentToolRefusal(scout, "Bash", null)).toMatch(/shell/);
    expect(agentToolRefusal(scout, "mcp__tethr__assign_task", "Tethr tools")).toMatch(/Only tethr/);
    expect(agentToolRefusal(scout, "mcp__claude_ai_Google_Drive__search_files", "Google Drive")).toBeNull();
    expect(agentToolRefusal(scout, "Read", null)).toBeNull();
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr team — agents that work in their own chats and report back", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const calls: Array<{ agentId: string; prompt: string; tools: string; settings: { permissions: { deny: string[] } } }> = [];

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    const args = (ctx.config as { extraArgs: string[] }).extraArgs;
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    calls.push({
      agentId: ctx.agent.id,
      prompt: String(ctx.context.tethrPrompt),
      tools: args[args.indexOf("--tools") + 1]!,
      settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")),
    });
    const text = "Checked three price pages; two went up 5%.\n\nSlack summary: Two competitors raised prices 5%.";
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: text, is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };

  const tool = (name: string, args: Record<string, unknown>, threadId?: string) =>
    runTethrTool(name, args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId: threadId ?? companyId });

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const approve = (outputId: string) => gatingService(db).decide({ companyId, outputId, decision: "approve", reviewer: "mark" });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-team-"));
    process.env.TETHR_SETUP_FILE = path.join(dir, "setup.json");
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_OVERSEERS_FILE = path.join(dir, "overseers.json");
    process.env.TETHR_ARCHIVE_FILE = path.join(dir, "archive.json");
    process.env.TETHR_MOUNTS_FILE = path.join(dir, "mounts.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-team-");
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

  let scout!: TeamAgent;

  it("asks before adding an agent; approving builds it, switches its schedule on and starts its first task", async () => {
    const res = await tool("create_agent", { ...SPEC, why: "Pricing moves weekly." });
    expect(res.isError).toBeFalsy();
    expect(res.text).toMatch(/^Sent @price-scout for approval/);
    expect((await tool("create_agent", SPEC)).text).toMatch(/already waiting for approval/);
    const [card] = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "team_agent")));
    expect(card).toMatchObject({ status: "gated", sensitivity: "org" });
    expect(card.body).toContain("Why: Pricing moves weekly.");
    // The bell asks for a decision only while the card is still open.
    const bellFor = async () =>
      (await notificationService(db).list(companyId)).find((n) => n.href === `/queue/${card.id}`) as { outputStatus?: string | null } | undefined;
    expect((await bellFor())?.outputStatus).toBe("gated");

    await approve(card.id);
    expect((await bellFor())?.outputStatus).not.toBe("gated");
    const team = teamService(db);
    scout = (await team.get(companyId, "@price-scout"))!;
    expect(scout).toMatchObject({ paused: false, connectors: ["Google Drive", "Tethr tools"], threadId: agentThreadId(companyId, "@price-scout") });
    const [row] = await db.select().from(agents).where(eq(agents.id, scout.agentId));
    expect(row).toMatchObject({ status: "idle", adapterType: "tethr_llm", budgetMonthlyCents: 1500 });
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, scout.agentId));
    expect(policy).toMatchObject({ amount: 1500, hardStopEnabled: true });
    const [routine] = await db.select().from(routines).where(eq(routines.id, scout.routineId!));
    expect(routine).toMatchObject({ status: "active", assigneeAgentId: scout.agentId });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine.id));
    expect(trigger).toMatchObject({ cronExpression: "0 9 * * 1", enabled: true });
    expect((await takeNotes(companyId, companyId)).some((n) => n.startsWith("Approved: @price-scout (Price Scout) is on the team"))).toBe(true);

    // The first task: core wakes the agent, it works in its own chat, the task closes.
    const [first] = await db.select().from(issues).where(and(eq(issues.assigneeAgentId, scout.agentId), eq(issues.originId, "tethr:team")));
    expect(first.title).toBe("Baseline the competitors' prices");
    await waitFor(async () => {
      const [i] = await db.select().from(issues).where(eq(issues.id, first.id));
      return i.status === "done";
    });
    const [turn] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.threadId, scout.threadId));
    expect(turn).toMatchObject({ agentId: scout.agentId, sourceKey: "chat-system", status: "done" });
    const call = calls.find((c) => c.agentId === scout.agentId)!;
    expect(call.prompt).toContain(SPEC.instructions);
    expect(call.tools.split(",")).not.toContain("Bash");
    expect(call.settings.permissions.deny).toEqual(expect.arrayContaining(["mcp__claude_ai_Gmail", "mcp__tethr__create_agent", "Bash"]));

    // The report comes back to the main chat (a card, a note) and the bell.
    const report = await waitFor(async () => {
      const [r] = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
      return r;
    });
    expect(report.requestText).toBe(`@price-scout finished ${first.identifier}: Baseline the competitors' prices`);
    expect(report.resultText).toBe("Checked three price pages; two went up 5%.");
    expect(report.agentId).toBe(scout.agentId);
    const notes = await takeNotes(companyId, companyId);
    expect(notes.some((n) => n.includes("Two competitors raised prices 5%"))).toBe(true);
    const bells = await db.select().from(tethrNotifications).where(eq(tethrNotifications.companyId, companyId));
    expect(bells.some((b) => b.title.startsWith("@price-scout finished"))).toBe(true);
  }, 60_000);

  it("hands an agent work, within its limits", async () => {
    const res = await tool("assign_task", { agent: "@price-scout", title: "Check the new competitor", brief: "Add Acme Travel to the price table." });
    expect(res.text).toMatch(/^Assigned WD-\d+ to @price-scout/);
    await expect(tool("assign_task", { agent: "@nobody", title: "x y z", brief: "Something to do here." })).resolves.toMatchObject({ isError: true });

    // Past its daily runs: it says so instead of queuing more.
    await teamService(db).update(companyId, "@price-scout", { maxRunsPerDay: 1 }, {});
    const capped = await tool("assign_task", { agent: "@price-scout", title: "One more check", brief: "Another price check please." });
    expect(capped).toMatchObject({ isError: true });
    expect(capped.text).toMatch(/used its 1 runs for today/);
  }, 30_000);

  it("pauses at once, and resuming asks under the default setting", async () => {
    const paused = await tool("update_agent", { agent: "@price-scout", pause: true });
    expect(paused.text).toMatch(/^Paused @price-scout/);
    const agent = (await teamService(db).get(companyId, "@price-scout"))!;
    expect(agent.paused).toBe(true);
    const [routine] = await db.select().from(routines).where(eq(routines.id, agent.routineId!));
    expect(routine.status).toBe("paused");
    expect((await tool("assign_task", { agent: "@price-scout", title: "Check prices", brief: "Check the price pages." })).text).toMatch(/is paused/);

    const resume = await tool("update_agent", { agent: "@price-scout", pause: false, why: "Back to weekly checks." });
    expect(resume.text).toMatch(/Sent the change to @price-scout for approval/);
    const [card] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "team_change"), eq(tethrOutputs.status, "gated")));
    await approve(card.id);
    expect((await teamService(db).get(companyId, "@price-scout"))!.paused).toBe(false);
  });

  it("creates agents on its own under Automatic, inside the team's limits; a raise always asks", async () => {
    await updateIntegrations(companyId, { team: { newAgents: "auto", maxAgents: 3, monthlyBudgetUsd: 40 } });
    const made = await tool("create_agent", {
      name: "Review Digest",
      title: "Customer review digest",
      mission: "Summarizes new public reviews each week; moves New customers.",
      instructions: "Read the review sites and write files/reviews/<date>.md with themes and quotes, no names.",
      budget_usd: 20,
    });
    expect(made.text).toMatch(/^Created @review-digest/);
    // $15 + $20 already committed; another $10 would pass $40.
    const over = await tool("create_agent", {
      name: "Ad Watch",
      title: "Ad spend watch",
      mission: "Flags ad spend that runs ahead of results; moves Revenue.",
      instructions: "Check yesterday's ad spend against conversions and flag anything off by more than 20%.",
      budget_usd: 10,
    });
    expect(over.text).toMatch(/automatic creation is on, but it would take the team past its \$40 a month/);

    const raise = await tool("update_agent", { agent: "@review-digest", budget_usd: 30 });
    expect(raise.text).toMatch(/for approval/);
    const [card] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "team_change"), eq(tethrOutputs.status, "gated")));
    expect(card.sensitivity).toBe("spend");
    const smaller = await tool("update_agent", { agent: "@review-digest", title: "Weekly review digest" });
    expect(smaller.text).toMatch(/^Updated @review-digest/);
    await updateIntegrations(companyId, { team: { newAgents: "ask", maxAgents: 6, monthlyBudgetUsd: 100 } });
  });

  it("keeps team tools away from an agent's own chat, and holds it to its connectors", async () => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const app = express();
    app.use(express.json());
    app.use("/api", tethrRoutes(db));
    const agentToken = issueHookToken({ companyId, threadId: scout.threadId, runId: "00000000-0000-4000-8000-000000000001" });
    const mainToken = issueHookToken({ companyId, threadId: companyId, runId: "00000000-0000-4000-8000-000000000002" });
    try {
      const list = await request(app).post("/api/tethr/assistant/tools/list").set("authorization", `Bearer ${agentToken}`).expect(200);
      const names = list.body.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("make_document");
      expect(names).not.toContain("create_agent");
      const refused = await request(app)
        .post("/api/tethr/assistant/tools/call")
        .set("authorization", `Bearer ${agentToken}`)
        .send({ name: "team_list", arguments: {} })
        .expect(200);
      expect(refused.body.isError).toBe(true);
      expect(refused.body.content[0].text).toMatch(/Only tethr/);
      const allowed = await request(app)
        .post("/api/tethr/assistant/tools/call")
        .set("authorization", `Bearer ${mainToken}`)
        .send({ name: "team_list", arguments: {} })
        .expect(200);
      expect(allowed.body.content[0].text).toContain("@price-scout");

      const ctx = { companyId, threadId: scout.threadId, runId: "00000000-0000-4000-8000-000000000001" };
      const gmail = await handlePreToolUse(db, ctx, { tool_name: "mcp__claude_ai_Gmail__search_threads", tool_input: { query: "x" } });
      expect(gmail.stdout).toMatch(/isn't set up to use Gmail/);
      const shell = await handlePreToolUse(db, ctx, { tool_name: "Bash", tool_input: { command: "ls" } });
      expect(shell.stdout).toMatch(/can't use the shell/);
    } finally {
      revokeHookToken(agentToken);
      revokeHookToken(mainToken);
    }
  });

  it("reports to the owner on Slack (else the admin, else #tethr), with only the headline and summary", async () => {
    await setRoster(companyId, { growth: { name: "Mark", slackId: "U0GROWTH" } });
    const posts: Array<{ channel?: string; text: string }> = [];
    const post = async (m: { channel?: string; text: string }) => {
      posts.push(m);
      return { ok: true };
    };
    await deliverAgentReport(
      db,
      { companyId, agent: scout, title: "Check prices", identifier: "WD-50", outcome: "done", text: "Acme raised prices for customer jane@x.com.\n\nSlack summary: One competitor raised prices.", runId: null },
      { post },
    );
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("U0GROWTH");
    expect(posts[0].text).toContain("@price-scout finished WD-50: Check prices");
    expect(posts[0].text).toContain("One competitor raised prices.");
    expect(posts[0].text).not.toContain("jane@x.com");
    expect(reportHeadline({ agent: scout, title: "Check prices", identifier: null, outcome: "waiting" })).toBe("@price-scout needs your approval to finish Check prices");
  });

  it("reports an agent's follow-up after an approval, and writes the team into CLAUDE.md", async () => {
    const before = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
    await getAssistantRunner(db).send({ companyId, threadId: scout.threadId, kind: "system", text: "Approved: Share the pricing table with the team" });
    const after = await waitFor(async () => {
      const rows = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
      return rows.length > before.length ? rows : null;
    });
    expect(after.some((r) => r.requestText === "@price-scout finished Share the pricing table with the team (after your approval)")).toBe(true);
    const claudeMd = fs.readFileSync(path.join(dir, "workspace", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("## Your team");
    expect(claudeMd).toContain("- @price-scout (Price Scout): Competitor pricing watch.");
    expect(claudeMd).toContain("## Running the team");
  }, 30_000);
});

describe("phase 27: tags and the run page", () => {
  it("cuts a long agent tag at a whole word", async () => {
    const { tagFromName } = await import("../tethr/team-spec.ts");
    expect(tagFromName("Competitor Scout")).toBe("@competitor-scout");
    expect(tagFromName("Paid Ads Keyword Research")).toBe("@paid-ads-keyword");
    expect(tagFromName("Paid Ads Reporting")).toBe("@paid-ads-reporting");
    // Exactly at the limit, and one long word with nowhere to cut.
    expect(tagFromName("abcdefghijk lmnopqrstuv")).toBe("@abcdefghijk-lmnopqrstuv");
    expect(tagFromName("Supercalifragilisticexpialidocious")).toBe("@supercalifragilisticexp");
    expect(tagFromName("!!!")).toBe("@agent");
  });

  it("says what a run with no task did, so the run page doesn't read like an error", async () => {
    const { idleRunSummary } = await import("../tethr/adapter.ts");
    const scheduled = idleRunSummary("Sage", "no-such-company", { engine: "session", schedule: { cron: "0 10 * * 3", brief: "Study." } });
    expect(scheduled).toContain("Sage had no task for this run, so nothing ran and nothing was spent.");
    expect(scheduled).toMatch(/scheduled runs are .*Wednesday/);
    expect(idleRunSummary("Scout", "no-such-company", { engine: "session" })).toContain("It has no schedule; give it a task from tethr's chat.");
  });
});
