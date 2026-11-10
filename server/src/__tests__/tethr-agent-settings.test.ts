import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import {
  AgentSettingsError,
  defaultToolSetting,
  effectiveSettings,
  parseAgentSettings,
  settingsForTools,
  settingsOwner,
  settingsSummary,
  widensSettings,
  widensSpending,
} from "../tethr/agent-settings.ts";
import { DEFAULT_CONNECTOR_AUTONOMY, getIntegrations, updateIntegrations } from "../tethr/integrations.ts";
import { teamSpecText, validateTeamSpec } from "../tethr/team-spec.ts";
import { teamConnectorLabels, teamService } from "../tethr/team.ts";
import { runTethrTool } from "../tethr/assistant/tethr-tools.ts";
import { handlePreToolUse } from "../tethr/assistant/hook-handler.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { tethrRoutes } from "../routes/tethr.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Mark, 2026-11-10: "nesting settings for the agent within the agent panes
// themselves is better… if there's a paid ad agent that's the head that's where
// all the settings should live", and new agents come with settings that can be
// adjusted, auto or manual (approval needed).

const AUTO_SPEND = { spend: { mode: "auto" as const, monthlyCapUsd: 500 }, outside: "auto" as const, deletes: "ask" as const };
const cfgWith = (connectors: Record<string, unknown>) => ({ ...getIntegrations("00000000-0000-4000-8000-0000000000aa"), connectors: connectors as never });

describe("an agent's own settings: the rules", () => {
  it("takes a mode per tool; only a person puts spending, outside people or deletes on Automatic", () => {
    const fromTethr = parseAgentSettings({ "Google Ads": { mode: "auto", autonomy: AUTO_SPEND }, Gmail: "read", "Tethr tools": "auto" }, ["Google Ads", "Gmail", "Tethr tools"], { byPerson: false });
    expect(fromTethr).toEqual({
      "Google Ads": { mode: "auto", autonomy: { spend: { mode: "ask", monthlyCapUsd: 500 }, outside: "ask", deletes: "ask" } },
      Gmail: { mode: "read", autonomy: DEFAULT_CONNECTOR_AUTONOMY },
    });
    const fromPerson = parseAgentSettings({ "Google Ads": { mode: "auto", autonomy: AUTO_SPEND } }, ["Google Ads"], { byPerson: true });
    expect(fromPerson["Google Ads"]!.autonomy).toEqual(AUTO_SPEND);
    // Automatic spending needs a cap.
    expect(parseAgentSettings({ Stripe: { mode: "auto", autonomy: { spend: { mode: "auto", monthlyCapUsd: null } } } }, ["Stripe"], { byPerson: true }).Stripe!.autonomy.spend.mode).toBe("ask");
    expect(() => parseAgentSettings({ Stripe: "auto" }, ["Gmail"], { byPerson: true })).toThrow(AgentSettingsError);
    expect(() => parseAgentSettings({ Gmail: "yolo" }, ["Gmail"], { byPerson: true })).toThrow(/read, ask/);
  });

  it("starts new tools on Approval needed and tells when a change lets it do more", () => {
    expect(settingsForTools(["Gmail", "Tethr tools"])).toEqual({ Gmail: defaultToolSetting() });
    const before = settingsForTools(["Gmail", "Google Ads"]);
    expect(widensSettings(before, { Gmail: { mode: "read", autonomy: DEFAULT_CONNECTOR_AUTONOMY } })).toBe(false);
    expect(widensSettings(before, { Gmail: { mode: "auto", autonomy: DEFAULT_CONNECTOR_AUTONOMY } })).toBe(true);
    expect(widensSpending(before, { "Google Ads": { mode: "auto", autonomy: { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto", monthlyCapUsd: 100 } } } })).toBe(true);
    const raised = { "Google Ads": { mode: "auto" as const, autonomy: { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto" as const, monthlyCapUsd: 900 } } } };
    expect(widensSpending({ "Google Ads": { mode: "auto", autonomy: { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto", monthlyCapUsd: 500 } } } }, raised)).toBe(true);
  });

  it("applies its own settings, a lead's to its sub-team, tethr's when it has none, and Off for everyone", () => {
    const cfg = cfgWith({ Gmail: { mode: "auto" }, Stripe: { mode: "off" } });
    const lead = { leadTag: null, settings: { Gmail: { mode: "ask" as const, autonomy: DEFAULT_CONNECTOR_AUTONOMY }, Stripe: { mode: "auto" as const, autonomy: DEFAULT_CONNECTOR_AUTONOMY } } };
    const sub = { leadTag: "@lead", settings: {} };
    expect(settingsOwner(sub, lead)).toBe(lead);
    expect(effectiveSettings(cfg, settingsOwner(sub, lead), "Gmail")).toMatchObject({ mode: "ask", source: "agent" });
    expect(effectiveSettings(cfg, { settings: {} }, "Gmail")).toMatchObject({ mode: "auto", source: "tethr" });
    expect(effectiveSettings(cfg, lead, "Stripe")).toMatchObject({ mode: "off" });
  });

  it("says in words what runs on its own and what needs approval", () => {
    const s = settingsSummary(
      {
        "Google Ads": { mode: "auto", autonomy: AUTO_SPEND },
        Gmail: { mode: "ask", autonomy: DEFAULT_CONNECTOR_AUTONOMY },
        Stripe: { mode: "read", autonomy: DEFAULT_CONNECTOR_AUTONOMY },
      },
      ["Google Ads", "Gmail", "Stripe", "Slack", "Tethr tools"],
    );
    expect(s.onItsOwn).toEqual(["Changes in Google Ads", "Spending in Google Ads up to $500 a month"]);
    expect(s.needsApproval).toEqual(["Spending in Google Ads past $500 a month", "Every change in Gmail", "Slack: follows tethr's settings", "Anything medical"]);
    expect(s.lookOnly).toEqual(["Stripe"]);
  });

  it("gives a new agent settings on its card; a sub-agent works under its lead's", () => {
    const base = { name: "Paid Ads", title: "Paid search lead", mission: "Owns paid search.", instructions: "Plan and run paid search campaigns well.", connectors: ["Google Ads", "Gmail"] };
    const spec = validateTeamSpec({ ...base, settings: { "Google Ads": "auto" } }, { takenTags: [], connectors: ["Google Ads", "Gmail", "Tethr tools"] });
    expect(spec.settings).toEqual({ "Google Ads": { mode: "auto", autonomy: DEFAULT_CONNECTOR_AUTONOMY }, Gmail: defaultToolSetting() });
    const card = teamSpecText(spec);
    expect(card).toContain("Runs on its own: Changes in Google Ads");
    expect(card).toContain("Needs your approval: Spending in Google Ads; Every change in Gmail; Anything medical");
    const sub = validateTeamSpec({ ...base, name: "Keywords", connectors: ["Google Ads"], settings: { "Google Ads": "auto" } }, {
      takenTags: [],
      connectors: ["Google Ads", "Gmail"],
      lead: { tag: "@paid-ads", connectors: ["Google Ads", "Gmail"] },
    });
    expect(sub.settings).toEqual({});
    expect(teamSpecText(sub, { leadTag: "@paid-ads" })).toContain("Settings: @paid-ads's (a sub-agent works under its lead's settings).");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("an agent's own settings: in its pane and at the gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  let app!: express.Express;
  const PERSON = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Done.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };
  const appFor = (actor: Record<string, unknown>) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    a.use("/api", tethrRoutes(db));
    return a;
  };
  const tool = (name: string, args: Record<string, unknown>) =>
    runTethrTool(name, args, { workspaceDir: path.join(dir, "workspace"), db, companyId, threadId: companyId });
  const decisionIn = async (threadId: string, toolName: string, input: Record<string, unknown>) => {
    const [run] = await db.insert(tethrRouteRuns).values({ companyId, requestText: "x", invocationSource: "chat", threadId, status: "running", hops: [] }).returning();
    const reply = await handlePreToolUse(db, { companyId, threadId, runId: run!.id }, { tool_name: toolName, tool_input: input });
    return (JSON.parse(reply.stdout ?? "{}").hookSpecificOutput as { permissionDecision: string }).permissionDecision;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-agent-settings-"));
    for (const [key, name] of [
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_PAUSED_FILE", "paused.json"],
      ["TETHR_CONNECTOR_CHANGES_FILE", "changes.json"],
      ["TETHR_QUESTIONS_FILE", "questions.json"],
      ["TETHR_SETUP_FILE", "setup.json"],
    ]) {
      process.env[key!] = path.join(dir, name!);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    delete process.env.SLACK_BOT_TOKEN;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-agent-settings-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    app = appFor(PERSON);
  }, 60_000);

  afterAll(async () => {
    setAssistantRunnerForTests(null);
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
  });

  it("keeps a lead's settings for its team, and lets a person change them in its pane", async () => {
    const team = teamService(db);
    const labels = teamConnectorLabels(companyId);
    const lead = await team.create(
      companyId,
      validateTeamSpec(
        { name: "Paid Ads", title: "Paid search lead", mission: "Owns paid search.", instructions: "Plan and run paid search campaigns well.", connectors: ["Gmail", "Google Calendar"], lead: true },
        { takenTags: await team.takenTags(companyId), connectors: labels },
      ),
      { userId: "mark", via: "approval" },
    );
    expect(lead.settings).toEqual({ Gmail: defaultToolSetting(), "Google Calendar": defaultToolSetting() });
    const sub = await team.create(
      companyId,
      validateTeamSpec(
        { name: "Keyword Scout", title: "Keyword research", mission: "Finds keywords.", instructions: "Find the highest-intent search terms.", connectors: ["Gmail"] },
        { takenTags: await team.takenTags(companyId), connectors: labels, lead: { tag: lead.tag, connectors: lead.connectors } },
      ),
      { userId: "mark", via: "approval" },
      { lead },
    );
    expect(sub.settings).toEqual({});

    const pane = (await request(app).get(`/api/tethr/${companyId}/team/${lead.tag}/settings`).expect(200)).body;
    expect(pane).toMatchObject({ settingsFrom: null, summary: { onItsOwn: [], needsApproval: expect.arrayContaining(["Every change in Gmail", "Anything medical"]) } });
    expect(pane.subTeam.map((s: { tag: string }) => s.tag)).toEqual([sub.tag]);
    const subPane = (await request(app).get(`/api/tethr/${companyId}/team/${sub.tag}/settings`).expect(200)).body;
    expect(subPane.settingsFrom).toBe(lead.tag);

    // Only a person; a sub-agent's tool settings live on its lead; its tools stay within the lead's.
    await request(appFor({ type: "agent", agentId: lead.agentId, companyId })).put(`/api/tethr/${companyId}/team/${lead.tag}/settings`).send({ tools: { Gmail: "auto" } }).expect(403);
    expect((await request(app).put(`/api/tethr/${companyId}/team/${sub.tag}/settings`).send({ tools: { Gmail: "auto" } }).expect(409)).body.settingsFrom).toBe(lead.tag);
    await request(app).put(`/api/tethr/${companyId}/team/${sub.tag}/settings`).send({ connectors: ["Gmail", "Stripe"] }).expect(400);

    const saved = await request(app)
      .put(`/api/tethr/${companyId}/team/${lead.tag}/settings`)
      .send({ tools: { Gmail: { mode: "auto", autonomy: { spend: { mode: "ask", monthlyCapUsd: null }, outside: "auto", deletes: "ask" } } }, budgetMonthlyUsd: 40, maxRunsPerDay: 6 })
      .expect(200);
    expect(saved.body.settings.Gmail).toEqual({ mode: "auto", autonomy: { spend: { mode: "ask", monthlyCapUsd: null }, outside: "auto", deletes: "ask" } });
    const after = await team.get(companyId, lead.tag);
    expect(after).toMatchObject({ budgetMonthlyCents: 4000, maxRunsPerDay: 6 });
    const roster = (await request(app).get(`/api/tethr/${companyId}/team`).expect(200)).body.agents as Array<{ tag: string; settingsSummary: { onItsOwn: string[] } }>;
    expect(roster.find((a) => a.tag === sub.tag)!.settingsSummary.onItsOwn).toEqual(["Changes in Gmail", "Reaching people outside the company through Gmail"]);

    // At the gate: the sub-agent's email to an outsider follows the lead's settings (on its own);
    // tethr's own chat still asks (Gmail is on Ask in Integrations).
    const email = { to: ["someone@partner.com"], subject: "Hello", body: "A note." };
    expect(await decisionIn(sub.threadId, "mcp__claude_ai_Gmail__send_message", email)).toBe("allow");
    expect(await decisionIn(companyId, "mcp__claude_ai_Gmail__send_message", { ...email, subject: "From tethr" })).toBe("deny");
    // Off in Integrations is off for everyone.
    await updateIntegrations(companyId, { connectors: { Gmail: { mode: "off" } } });
    expect(await decisionIn(sub.threadId, "mcp__claude_ai_Gmail__send_message", { ...email, subject: "Again" })).toBe("deny");
    await updateIntegrations(companyId, { connectors: { Gmail: { mode: "ask" } } });
  });

  it("an agent proposed with anything on Automatic is a card, even when new agents are automatic; widening an agent is too", async () => {
    await updateIntegrations(companyId, { team: { newAgents: "auto" } as never });
    const made = await tool("create_agent", {
      name: "Inbox Helper",
      title: "Inbox triage",
      mission: "Keeps the shared inbox tidy.",
      instructions: "Label and summarize new mail each morning for the team.",
      connectors: ["Gmail"],
      settings: { Gmail: "auto" },
    });
    expect(made.text).toMatch(/^Sent @inbox-helper for approval \(it would change things on its own/);
    const plain = await tool("create_agent", {
      name: "Calendar Helper",
      title: "Calendar keeper",
      mission: "Keeps the team calendar tidy.",
      instructions: "Look for clashes in the calendar every morning.",
      connectors: ["Google Calendar"],
    });
    expect(plain.text).toMatch(/^Created @calendar-helper/);
    const team = teamService(db);
    expect((await team.get(companyId, "@calendar-helper"))!.settings).toEqual({ "Google Calendar": defaultToolSetting() });

    const widen = await tool("update_agent", { agent: "@calendar-helper", settings: { "Google Calendar": "auto" } });
    expect(widen.text).toMatch(/for approval/);
    const narrow = await tool("update_agent", { agent: "@calendar-helper", settings: { "Google Calendar": "read" } });
    expect(narrow.text).toMatch(/^Updated @calendar-helper/);
    expect((await team.get(companyId, "@calendar-helper"))!.settings["Google Calendar"]!.mode).toBe("read");
    const cards = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.status, "gated")));
    expect(cards.some((c) => c.title.startsWith("Change @calendar-helper") && c.body.includes("Runs on its own: Changes in Google Calendar"))).toBe(true);
  });
});
