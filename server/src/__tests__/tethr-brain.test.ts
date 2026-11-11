import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { agents, createDb, issues, tethrMembers, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { initTethrAdapter } from "../tethr/adapter.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { runTethrTool } from "../tethr/assistant/tethr-tools.ts";
import { gatingService, approvalDmText } from "../tethr/gating.ts";
import { goalsService } from "../tethr/goals.ts";
import { updateIntegrations } from "../tethr/integrations.ts";
import { resolveOverseer } from "../tethr/slack.ts";
import { reportHeadline } from "../tethr/team-report.ts";
import { setThrottle } from "../tethr/throttle.ts";
import { brainService, checkInBrief, localClock, noteReport, reviewDue } from "../tethr/team-brain.ts";
import {
  agentDenyRules,
  agentIdentityText,
  agentRollupText,
  agentToolRefusal,
  teamSpecText,
  validateTeamSpec,
} from "../tethr/team-spec.ts";
import { teamService } from "../tethr/team.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 24: tethr is the brain. Agents can own goals, leads run sub-teams
// (sub-tasks are core child issues, rolled up by the lead), tethr checks in on
// reports and runs a daily review when switched on, and every card that needs
// a person reaches one on Slack.

const LABELS = ["Gmail", "Google Drive", "Stripe", "Tethr tools"];
const LEAD = {
  name: "Paid Ads",
  title: "Paid acquisition lead",
  mission: "Finds out whether paid search can bring customers at a good cost; moves New customers.",
  instructions: "Run small paid search tests. Split the work: keywords and strategy go to your sub-team. Deliver files/paid-ads/<date>.md.",
  lead: true,
  connectors: ["Tethr tools"],
  new_goal: {
    title: "Paid acquisition",
    description: "Customers from paid search at a sustainable cost.",
    metric: { name: "Cost per new customer", unit: "usd", source: "google_ads", method: "Google Ads spend / new paying customers, last 30 days", target: 40, target_date: "2027-03-31", direction: "down" },
  },
};

describe("tethr brain — the spec, in words", () => {
  it("checks goals, leads and the sub-team rules", () => {
    const goals = new Map([["g1", "Revenue"]]);
    const lead = validateTeamSpec(LEAD, { takenTags: [], connectors: LABELS, goals });
    expect(lead).toMatchObject({ lead: true, goal: { kind: "new", title: "Paid acquisition", metric: { target: 40, targetDate: "2027-03-31", direction: "down" } } });
    expect(validateTeamSpec({ ...LEAD, new_goal: undefined, goal_id: "g1" }, { takenTags: [], connectors: LABELS, goals }).goal).toEqual({
      kind: "existing",
      goalId: "g1",
      title: "Revenue",
    });
    const bad = (patch: Record<string, unknown>, lead?: { tag: string; connectors: string[] }) => () =>
      validateTeamSpec({ ...LEAD, ...patch }, { takenTags: [], connectors: LABELS, goals, lead });
    expect(bad({ new_goal: undefined, goal_id: "nope" })).toThrow(/no goal nope/);
    expect(bad({ new_goal: { title: "Paid", metric: { name: "CPA", method: "spend / customers", target: 40, target_date: "March" } } })).toThrow(/YYYY-MM-DD/);
    expect(bad({}, { tag: "@paid-ads", connectors: ["Tethr tools"] })).toThrow(/can't be a lead/);
    expect(bad({ lead: false, connectors: ["Gmail"] }, { tag: "@paid-ads", connectors: ["Tethr tools"] })).toThrow(/doesn't have Gmail/);
  });

  it("puts the goal, the lead's role and the sub-team on the card and in the agent's turns", () => {
    const spec = validateTeamSpec(LEAD, { takenTags: [], connectors: LABELS });
    const card = teamSpecText(spec);
    expect(card).toContain("New goal: Paid acquisition, measured as Cost per new customer: ? → 40 by 2027-03-31 (saved when you approve)");
    expect(card).toContain("Lead: it can build and run a small sub-team");
    const sub = validateTeamSpec({ ...LEAD, name: "Ad Keywords", lead: false, new_goal: undefined }, { takenTags: [], connectors: LABELS, lead: { tag: "@paid-ads", connectors: ["Tethr tools"] } });
    expect(teamSpecText(sub, { leadTag: "@paid-ads" })).toContain("Part of @paid-ads's team: it reports to @paid-ads, which reports to tethr.");

    const leadIdentity = agentIdentityText({ ...spec, goalTitle: "Paid acquisition", subTeam: ["@ad-keywords"] });
    expect(leadIdentity).toContain("You lead a small sub-team");
    expect(leadIdentity).toContain("Your goal: Paid acquisition.");
    expect(leadIdentity).toContain("Your sub-team: @ad-keywords.");
    expect(agentIdentityText({ ...sub, leadTag: "@paid-ads" })).toContain("You're on @paid-ads's sub-team");
    const rollup = agentRollupText({ ...spec }, { identifier: "WD-3", title: "Plan the first campaign" }, [
      { identifier: "WD-4", title: "Find keywords", assigneeTag: "@ad-keywords", status: "done", lastComment: "20 keywords, 3 worth testing." },
    ]);
    expect(rollup.split("\n")[0]).toBe("Roll-up WD-3: Plan the first campaign");
    expect(rollup).toContain("- WD-4 Find keywords (@ad-keywords, done): 20 keywords, 3 worth testing.");
  });

  it("lets a lead use the team tools, and nobody else on the team", () => {
    const others = ["score_list", "goals_list", "make_document"];
    const leadRules = agentDenyRules([], LABELS, { lead: true, otherTethrTools: others });
    expect(leadRules).not.toContain("mcp__tethr");
    expect(leadRules).toEqual(expect.arrayContaining(["mcp__tethr__score_list", "mcp__claude_ai_Gmail", "Bash"]));
    expect(leadRules).not.toContain("mcp__tethr__create_agent");
    expect(agentDenyRules(["Tethr tools"], LABELS, { lead: true })).not.toContain("mcp__tethr__assign_task");
    expect(agentToolRefusal({ tag: "@paid-ads", connectors: [], lead: true }, "mcp__tethr__create_agent", "Tethr tools")).toBeNull();
    expect(agentToolRefusal({ tag: "@paid-ads", connectors: [], lead: true }, "mcp__tethr__score_list", "Tethr tools")).toMatch(/isn't set up to use Tethr tools/);
    expect(agentToolRefusal({ tag: "@ad-keywords", connectors: ["Tethr tools"] }, "mcp__tethr__assign_task", "Tethr tools")).toMatch(/Only tethr and team leads/);
  });

  it("knows when the daily review is due, in the person's time zone", () => {
    const review = { enabled: true, time: "08:30", weekdaysOnly: true };
    const monday = localClock(new Date("2026-11-09T14:40:00Z"), "America/Chicago");
    expect(monday).toEqual({ day: "2026-11-09", minutes: 8 * 60 + 40, weekday: 1 });
    expect(reviewDue(review, monday, null)).toBe(true);
    expect(reviewDue(review, monday, "2026-11-09")).toBe(false);
    expect(reviewDue(review, localClock(new Date("2026-11-09T14:20:00Z"), "America/Chicago"), null)).toBe(false);
    expect(reviewDue(review, localClock(new Date("2026-11-09T19:00:00Z"), "America/Chicago"), null)).toBe(false);
    expect(reviewDue(review, localClock(new Date("2026-11-07T14:40:00Z"), "America/Chicago"), null)).toBe(false);
    expect(reviewDue({ ...review, weekdaysOnly: false }, localClock(new Date("2026-11-07T14:40:00Z"), "America/Chicago"), null)).toBe(true);
    expect(reviewDue({ ...review, enabled: false }, monday, null)).toBe(false);
    expect(checkInBrief([{ tag: "@a", title: "X", outcome: "done", at: "" }, { tag: "@b", title: "Y", outcome: "done", at: "" }]).split("\n")[0]).toBe("Check-in: 2 reports from @a, @b");
    expect(reportHeadline({ agent: { tag: "@paid-ads" } as never, title: "WD-2 Keywords (from @kw)", identifier: null, outcome: "update" })).toBe(
      "@paid-ads has an update: WD-2 Keywords (from @kw)",
    );
  });

  it("puts a link to the card in the approval DM when tethr has a public address", () => {
    expect(approvalDmText("@paid-ads", "New agent: Ad Keywords", "o1")).toBe("@paid-ads needs your approval: *New agent: Ad Keywords*. Review it in tethr's Queue or the chat.");
    process.env.PAPERCLIP_PUBLIC_URL = "https://tethr.example.com/";
    try {
      expect(approvalDmText("@tethr", "New agent", "o1")).toBe("@tethr needs your approval: *New agent*. <https://tethr.example.com/queue/o1|Review it in tethr>");
    } finally {
      delete process.env.PAPERCLIP_PUBLIC_URL;
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr brain — sub-teams, goals, check-ins and buzzing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const tool = (name: string, args: Record<string, unknown>, threadId?: string, runId?: string) =>
    runTethrTool(name, args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId: threadId ?? companyId, runId });

  const approveLatest = async (kind: "team_agent" | "team_change") => {
    const [card] = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, kind), eq(tethrOutputs.status, "gated")));
    await gatingService(db).decide({ companyId, outputId: card.id, decision: "approve", reviewer: "mark" });
    return card;
  };

  // The fake Claude: a lead's task turn hands the work to its sub-agent (like
  // the real one calling assign_task); a roll-up and a sub-agent's turn report.
  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    // Only this turn's own request (the runner puts earlier turns and notes ahead of it).
    const full = String(ctx.context.tethrPrompt);
    const marker = "[From Tethr, not the user] ";
    const prompt = full.includes(marker) ? full.slice(full.lastIndexOf(marker) + marker.length) : full;
    let text = "Done.";
    if (prompt.includes("Roll-up ")) {
      text = "Working notes.\n\nReport:\nCampaign plan ready: 3 keywords to test at $20/day.\n\nSlack summary: Paid ads plan ready.";
    } else if (prompt.includes("Task ") && prompt.includes("You lead a small sub-team")) {
      const lead = (await teamService(db).byAgentId(companyId, ctx.agent.id))!;
      await runTethrTool(
        "assign_task",
        { agent: "@ad-keywords", title: "Find keywords", brief: "Find 20 search terms people use for travel pills." },
        { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId: lead.threadId, runId: ctx.runId },
      );
      text = "Handed keyword research to @ad-keywords.";
    } else if (prompt.includes("Task ")) {
      text = "Report:\nTop 20 keywords in files/keywords.csv.\n\nSlack summary: Found 20 keywords.";
    }
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: text, is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-brain-"));
    process.env.TETHR_SETUP_FILE = path.join(dir, "setup.json");
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_PAUSED_FILE = path.join(dir, "paused.json");
    process.env.TETHR_OVERSEERS_FILE = path.join(dir, "overseers.json");
    process.env.TETHR_ARCHIVE_FILE = path.join(dir, "archive.json");
    process.env.TETHR_MOUNTS_FILE = path.join(dir, "mounts.json");
    process.env.TETHR_BRAIN_FILE = path.join(dir, "brain.json");
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-brain-");
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

  it("turns a suggestion into a lead that owns a new goal, once it's approved", async () => {
    const res = await tool("create_agent", { ...LEAD, why: "Paid ads look worth a small test." });
    expect(res.text).toMatch(/^Sent @paid-ads for approval: a card with its full spec and its goal/);
    await approveLatest("team_agent");
    const lead = (await teamService(db).get(companyId, "@paid-ads"))!;
    expect(lead).toMatchObject({ lead: true, leadTag: null, goalTitle: "Paid acquisition" });
    const { goals } = await goalsService(db).list(companyId);
    const goal = goals.find((g) => g.id === lead.goalId)!;
    expect(goal.title).toBe("Paid acquisition");
    expect(goal.metrics[0]).toMatchObject({ name: "Cost per new customer", target: 40, direction: "down" });
  });

  it("lets a lead build its own sub-team, inside its tools, and nobody else", async () => {
    const lead = (await teamService(db).get(companyId, "@paid-ads"))!;
    const sub = { name: "Ad Keywords", title: "Keyword research", mission: "Finds the search terms worth paying for.", instructions: "Find terms with intent and volume; write files/keywords.csv." };
    expect((await tool("create_agent", { ...sub, connectors: ["Gmail"] }, lead.threadId)).text).toMatch(/doesn't have Gmail/);
    const sent = await tool("create_agent", { ...sub, connectors: ["Tethr tools"] }, lead.threadId);
    expect(sent.text).toMatch(/^Sent @ad-keywords for approval/);
    const card = await approveLatest("team_agent");
    expect(card.title).toBe("New agent for @paid-ads's team: Ad Keywords (@ad-keywords), Keyword research");
    const kw = (await teamService(db).get(companyId, "@ad-keywords"))!;
    expect(kw).toMatchObject({ lead: false, leadTag: "@paid-ads", goalId: lead.goalId });
    const [row] = await db.select().from(agents).where(eq(agents.id, kw.agentId));
    expect(row.reportsTo).toBe(lead.agentId);
    // It had no first task, so its lead is woken to hand it one.
    await waitFor(async () => {
      const rows = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.threadId, lead.threadId));
      return rows.find((r) => r.requestText.startsWith("@ad-keywords joined your team") && r.status === "done");
    });

    // A sub-agent can't build a team; the lead sees only its own sub-team.
    expect((await tool("create_agent", { ...sub, name: "Another" }, kw.threadId)).text).toMatch(/isn't a lead/);
    const list = await tool("team_list", {}, lead.threadId);
    expect(list.text).toMatch(/^Your sub-team: 1 of 4/);
    expect(list.text).toContain("@ad-keywords");
  });

  it("hands the lead's work to its sub-team as sub-tasks, then rolls up and reports to tethr", async () => {
    const assigned = await tool("assign_task", { agent: "@paid-ads", title: "Plan the first campaign", brief: "Plan a small paid search test for travel pills." });
    expect(assigned.text).toMatch(/^Assigned WD-\d+ to @paid-ads/);
    const lead = (await teamService(db).get(companyId, "@paid-ads"))!;
    const kw = (await teamService(db).get(companyId, "@ad-keywords"))!;
    const [parent] = await db.select().from(issues).where(and(eq(issues.assigneeAgentId, lead.agentId), eq(issues.title, "Plan the first campaign")));

    // The sub-task is a child of the lead's task; the sub-agent works it and closes it.
    const child = await waitFor(async () => {
      const [c] = await db.select().from(issues).where(eq(issues.parentId, parent.id));
      return c?.status === "done" ? c : null;
    });
    expect(child.assigneeAgentId).toBe(kw.agentId);
    // The sub-agent reports to its lead's chat, not the main chat.
    const subCard = await waitFor(async () => {
      const [c] = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.agentId, kw.agentId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
      return c;
    });
    expect(subCard.threadId).toBe(lead.threadId);

    // The last sub-task closing wakes the lead: it rolls up, closes its task and reports to tethr.
    await waitFor(async () => {
      const [p] = await db.select().from(issues).where(eq(issues.id, parent.id));
      return p.status === "done";
    });
    const leadCard = await waitFor(async () => {
      const [c] = await db
        .select()
        .from(tethrRouteRuns)
        .where(and(eq(tethrRouteRuns.agentId, lead.agentId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report"), eq(tethrRouteRuns.threadId, companyId)));
      return c;
    });
    expect(leadCard.requestText).toBe(`@paid-ads finished ${parent.identifier}: Plan the first campaign`);
    expect(leadCard.resultText).toBe("Campaign plan ready: 3 keywords to test at $20/day.");
    const mainCards = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")));
    expect(mainCards.every((c) => c.agentId === lead.agentId)).toBe(true);
  }, 60_000);

  it("wakes the lead when a sub-agent reports on its own, and tells tethr only when the lead has a report", async () => {
    const lead = (await teamService(db).get(companyId, "@paid-ads"))!;
    const mainCardsFromLead = async () =>
      (await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, companyId), eq(tethrRouteRuns.agentId, lead.agentId), eq(tethrRouteRuns.sourceKey, "tethr-agent-report")))).length;
    const before = await mainCardsFromLead();
    await tool("assign_task", { agent: "@ad-keywords", title: "Check new terms", brief: "Check three new search terms for volume." });
    const nudge = await waitFor(async () => {
      const rows = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.threadId, lead.threadId), eq(tethrRouteRuns.sourceKey, "chat-system")));
      const r = rows.find((x) => x.requestText.startsWith("Report from @ad-keywords"));
      return r?.status === "done" ? r : null;
    });
    expect(nudge.requestText.split("\n")[0]).toMatch(/^Report from @ad-keywords: WD-\d+ Check new terms$/);
    // The fake lead answered without a "Report:", so nothing new went to tethr.
    expect(await mainCardsFromLead()).toBe(before);
  }, 30_000);

  it("checks in on reports and runs a daily review only when switched on, within its cap", async () => {
    const sent: string[] = [];
    const brain = brainService(db, { send: async (input) => void sent.push(input.text) });
    const t0 = new Date("2026-11-09T15:00:00Z");

    // Off by default: nothing is remembered, nothing runs.
    await noteReport(companyId, { tag: "@paid-ads", title: "Plan", outcome: "done" }, t0);
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 10 * 60_000))).toBeNull();

    await updateIntegrations(companyId, { team: { autonomy: { actOnReports: true, maxSelfTurnsPerDay: 2 } } as never });
    await noteReport(companyId, { tag: "@paid-ads", title: "Plan", outcome: "done" }, t0);
    await noteReport(companyId, { tag: "@ad-keywords", title: "Keywords", outcome: "done" }, new Date(t0.getTime() + 60_000));
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 2 * 60_000))).toBeNull(); // still arriving
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 5 * 60_000))).toBe("check-in");
    expect(sent[0]!.split("\n")[0]).toBe("Check-in: 2 reports from @paid-ads, @ad-keywords");
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 6 * 60_000))).toBeNull(); // nothing pending

    // Paused agents stop it.
    await noteReport(companyId, { tag: "@paid-ads", title: "Again", outcome: "done" }, new Date(t0.getTime() + 7 * 60_000));
    await setThrottle(companyId, true);
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 20 * 60_000))).toBeNull();
    await setThrottle(companyId, false);

    // The daily review (08:30 Chicago = 14:30 UTC in November), once, within the cap.
    await updateIntegrations(companyId, { team: { autonomy: { dailyReview: { enabled: true, time: "08:30", weekdaysOnly: true } } } as never });
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 21 * 60_000))).toBe("check-in"); // the pending one first
    expect(await brain.tickCompany(companyId, new Date(t0.getTime() + 22 * 60_000))).toBeNull(); // cap of 2 reached
    const tomorrow = new Date("2026-11-10T14:40:00Z");
    expect(await brain.tickCompany(companyId, tomorrow)).toBe("review");
    expect(sent.at(-1)!.split("\n")[0]).toBe("Daily review");
    expect(await brain.tickCompany(companyId, new Date(tomorrow.getTime() + 60_000))).toBeNull();
    await updateIntegrations(companyId, { team: { autonomy: { actOnReports: false, dailyReview: { enabled: false } } } as never });
  });

  it("buzzes the admin on Slack when nobody is set for the role", async () => {
    // Clear any roster defaults this machine's environment carries.
    const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^TETHR_(OVERSEER|DEFAULT_OVERSEER)_/.test(k)));
    for (const key of Object.keys(saved)) delete process.env[key];
    try {
      expect((await resolveOverseer(db, companyId, "@paid-ads")).slackId).toBeUndefined();
      await db.insert(tethrMembers).values({ companyId, name: "Mark Karam", role: "admin", position: "coo", slackUserId: "U0ADMIN" });
      expect(await resolveOverseer(db, companyId, "@paid-ads")).toEqual({ slackId: "U0ADMIN", name: "Mark Karam" });
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
