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
import { classify, decide, kindsForConnector, type Classified } from "../tethr/assistant/policy.ts";
import { autonomyFor, DEFAULT_CONNECTOR_AUTONOMY, getIntegrations, integrationRulesText, sanitizeIntegrationsPatch, updateIntegrations } from "../tethr/integrations.ts";
import { monthlyAmountOf } from "../tethr/spend/amount.ts";
import { checkSpend } from "../tethr/spend/guard.ts";
import { setSpendAdapterForTests, type SpendAdapter } from "../tethr/spend/adapters.ts";
import { changeStore, recentChanges, recordChange, spentThisMonth } from "../tethr/spend/log.ts";
import { AdsInputError, buildCreateCampaign, parseCampaign, parseChanges, plannedFromBudgets } from "../tethr/tools/google-ads-ops.ts";
import { setAdsBackendForTests, type AdsBackend } from "../tethr/tools/google-ads-write.ts";
import { connectionsContextText } from "../tethr/connections.ts";
import type { MutateOperation } from "../tethr/tools/google-ads-ops.ts";
import { agentDenyRules, agentToolRefusal } from "../tethr/team-spec.ts";
import { issueHookToken } from "../tethr/assistant/gate.ts";
import { handlePostToolUse, handlePreToolUse } from "../tethr/assistant/hook-handler.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import { gatingService } from "../tethr/gating.ts";
import { tethrRoutes } from "../routes/tethr.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Mark, 2026-11-10: "any connector needs to have ability to be autonomous or
// manual with approval", budgets "approved by admin or set to auto in
// settings", and Google Ads that can actually make campaigns.

const CTX = { workspaceDir: "/w", readableRoots: ["/w"], internalAddresses: ["travelwithwandr.com"] };
const AUTO = { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto" as const, monthlyCapUsd: 500 }, outside: "auto" as const, deletes: "auto" as const };
const call = (c: Classified, withinCap = true) => decide(c, { mode: "auto", shell: "off", autonomy: AUTO, withinCap });

describe("autonomy: the gate, per connector", () => {
  it("lets each sensitive kind run on its own only when its setting says so; medical always asks", () => {
    const outsider = classify("mcp__claude_ai_Gmail__send_message", { to: ["a@other.com"], subject: "Hi", body: "Hello" }, CTX);
    expect(outsider.cls).toBe("public");
    expect(decide(outsider, { mode: "auto", shell: "off" }).action).toBe("ask");
    expect(decide(outsider, { mode: "auto", shell: "off", autonomy: DEFAULT_CONNECTOR_AUTONOMY }).action).toBe("ask");
    expect(call(outsider)).toEqual({ action: "allow", note: "auto" });
    // Under Ask, nothing runs on its own whatever the autonomy.
    expect(decide(outsider, { mode: "ask", shell: "off", autonomy: AUTO }).action).toBe("ask");

    const trash = classify("mcp__claude_ai_Gmail__trash_message", { id: "1" }, CTX);
    expect(trash.cls).toBe("destructive");
    expect(call(trash).action).toBe("allow");

    const medical = classify("mcp__claude_ai_Gmail__send_message", { to: ["mark@travelwithwandr.com"], body: "Her diagnosis came back" }, CTX);
    expect(medical.cls).toBe("medical");
    expect(call(medical).action).toBe("ask");

    const pay = classify("mcp__claude_ai_Stripe__stripe_api_write", { amount: 50 }, CTX);
    expect(call(pay, true).action).toBe("allow");
    expect(call(pay, false).action).toBe("ask");
    // Automatic spending needs a cap, even if the setting says auto.
    expect(decide(pay, { mode: "auto", shell: "off", autonomy: { ...AUTO, spend: { mode: "auto", monthlyCapUsd: null } }, withinCap: true }).action).toBe("ask");
    const held = decide(pay, { mode: "auto", shell: "off", autonomy: DEFAULT_CONNECTOR_AUTONOMY, spendNote: "$900 a month planned after this; the cap is $500 a month" });
    expect(held).toMatchObject({ action: "ask" });
    expect((held as { reason: string }).reason).toContain("spends money; $900 a month planned after this");
  });

  it("sorts a connector it has no rules for (Meta Ads) by name and what a call sets", () => {
    const meta = (name: string, input: Record<string, unknown> = {}) => classify(`mcp__claude_ai_Meta_Ads__${name}`, input, CTX);
    expect(meta("get_campaigns").cls).toBe("read");
    expect(meta("update_campaign_budget", { daily_budget: 20 }).cls).toBe("money");
    expect(meta("updateAdSetBid", {}).cls).toBe("money");
    expect(meta("create_ad", { name: "Spring", status: "ACTIVE" }).cls).toBe("money");
    expect(meta("create_ad", { name: "Spring", status: "PAUSED", body: "Malaria pills, prescribed online" }).cls).toBe("write");
    expect(meta("create_ad", { name: "Spring", status: "PAUSED", body: "Cures malaria in a day" }).cls).toBe("medical");
    const del = meta("delete_ad", { id: "1" });
    expect(del).toMatchObject({ cls: "destructive", adPlatform: true });
    // Nothing in an ad account is deleted on its own, whatever the setting.
    expect(call(del).action).toBe("ask");
    expect(kindsForConnector("Meta Ads")).toEqual(["spend", "outside"]);
    expect(kindsForConnector("Some New Tool")).toEqual(["spend", "outside", "deletes"]);
    expect(kindsForConnector("Gmail")).toEqual(["outside", "deletes"]);
    expect(kindsForConnector("Stripe")).toEqual(["spend"]);
    expect(kindsForConnector("Google Ads")).toEqual(["spend"]);
    expect(kindsForConnector("Slack")).toEqual([]);
  });

  it("treats tethr's Google Ads tools as their own connector", () => {
    const budget = classify("mcp__tethr__ads_set_budget", { campaign_id: "1", daily_budget: 20 }, CTX);
    expect(budget).toMatchObject({ connector: "Google Ads", cls: "money", summary: "Setting a Google Ads budget: campaign 1 to 20/day" });
    const change = classify("mcp__tethr__ads_change", { changes: [{ action: "pause", target: "campaign", id: "1" }] }, CTX);
    expect(change).toMatchObject({ connector: "Google Ads", cls: "write", summary: "Changing Google Ads: pause campaign 1" });
    const claim = classify("mcp__tethr__ads_create_campaign", { name: "x", headlines: ["Prevents malaria for sure"] }, CTX);
    expect(claim.cls).toBe("medical");
    // An agent needs Google Ads itself; Tethr tools don't cover it.
    const agent = { tag: "@paid-ads", connectors: ["Tethr tools"] };
    expect(agentToolRefusal(agent, "mcp__tethr__ads_change", "Google Ads")).toMatch(/isn't set up to use Google Ads/);
    expect(agentToolRefusal({ ...agent, connectors: ["Google Ads"] }, "mcp__tethr__ads_change", "Google Ads")).toBeNull();
    const rules = agentDenyRules(["Google Ads"], ["Gmail", "Google Ads", "Tethr tools"], { otherTethrTools: ["score_list", "ads_change", "ads_set_budget", "ask"] });
    expect(rules).toContain("mcp__tethr__score_list");
    expect(rules).not.toContain("mcp__tethr__ads_change");
    expect(agentDenyRules([], ["Google Ads"], { otherTethrTools: [] })).toContain("mcp__tethr__ads_change");
  });

  it("keeps spending on ask until a cap is set, and says so in tethr's rules", () => {
    const patch = sanitizeIntegrationsPatch({
      connectors: {
        "Google Ads": { mode: "auto", autonomy: { spend: { mode: "auto", monthlyCapUsd: null }, outside: "auto", deletes: "nope" } },
        "Meta Ads": { autonomy: { spend: { mode: "auto", monthlyCapUsd: "750.4" } } },
      },
    });
    expect(patch.connectors!["Google Ads"]).toEqual({ mode: "auto", autonomy: { spend: { mode: "ask", monthlyCapUsd: null }, outside: "auto", deletes: "ask" } });
    expect(patch.connectors!["Meta Ads"]).toEqual({ autonomy: { spend: { mode: "auto", monthlyCapUsd: 750 }, outside: "ask", deletes: "ask" } });
  });

  it("reads what a call spends a month from its input", () => {
    expect(monthlyAmountOf({ daily_budget: 20 })).toBeCloseTo(608);
    expect(monthlyAmountOf({ amount_micros: "15000000" })).toBe(15);
    expect(monthlyAmountOf({ unit_amount_cents: 1999 })).toBeCloseTo(19.99);
    expect(monthlyAmountOf({ campaign: { budget: "$50" } })).toBe(50);
    expect(monthlyAmountOf({ name: "Spring", status: "ACTIVE" })).toBeNull();
  });
});

describe("Google Ads changes as operations", () => {
  const DOMAINS = ["travelwithwandr.com"];
  const spec = {
    name: "Malaria · Exact",
    daily_budget: 15,
    final_url: "https://travelwithwandr.com/malaria",
    keywords: ["[malaria pills]", { text: "malaria prescription online", match: "exact" }, "travel malaria tablets"],
    negatives: ["free", "\"side effects\""],
    headlines: ["Malaria Pills Online", "Prescribed in Minutes", "Travel Clinic, No Wait"],
    descriptions: ["Get malaria pills prescribed online before your trip.", "A US clinician reviews your trip and prescribes."],
    max_cpc: 3,
  };

  it("builds a whole paused Search campaign in one batch", () => {
    const ops = buildCreateCampaign("123", parseCampaign(spec, DOMAINS), "2026-11-10T12:00");
    const budget = ops[0]!.campaignBudgetOperation as { create: Record<string, unknown> };
    expect(budget.create).toMatchObject({ resourceName: "customers/123/campaignBudgets/-1", amountMicros: "15000000", explicitlyShared: false });
    const campaign = (ops[1]!.campaignOperation as { create: Record<string, unknown> }).create;
    expect(campaign).toMatchObject({
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      campaignBudget: "customers/123/campaignBudgets/-1",
      targetSpend: { cpcBidCeilingMicros: "3000000" },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    });
    const keywords = ops.filter((o) => o.adGroupCriterionOperation).map((o) => (o.adGroupCriterionOperation as { create: { keyword: unknown } }).create.keyword);
    expect(keywords).toEqual([
      { text: "malaria pills", matchType: "EXACT" },
      { text: "malaria prescription online", matchType: "EXACT" },
      { text: "travel malaria tablets", matchType: "PHRASE" },
    ]);
    const negatives = ops.filter((o) => (o.campaignCriterionOperation as { create: { negative?: boolean } } | undefined)?.create.negative);
    expect(negatives).toHaveLength(2);
    expect(JSON.stringify(ops)).not.toMatch(/"remove"/);
  });

  it("refuses an off-site landing page, plain http, and copy over Google's limits", () => {
    expect(() => parseCampaign({ ...spec, final_url: "https://evil.example/malaria" }, DOMAINS)).toThrow(/own website/);
    expect(() => parseCampaign({ ...spec, final_url: "http://travelwithwandr.com/" }, DOMAINS)).toThrow(/https/);
    expect(() => parseCampaign({ ...spec, headlines: ["Only one"] }, DOMAINS)).toThrow(/3 to 15 headlines/);
    expect(() => parseCampaign({ ...spec, headlines: ["x".repeat(31), "b", "c"] }, DOMAINS)).toThrow(/30/);
    expect(() => parseCampaign({ ...spec, daily_budget: 0 }, DOMAINS)).toThrow(AdsInputError);
  });

  it("turns changes into operations, and never removes anything", () => {
    const changes = parseChanges(
      "123",
      [
        { action: "pause", target: "campaign", id: "111" },
        { action: "add_negatives", campaign_id: "111", keywords: ["free"] },
        { action: "set_keyword_bid", keyword_id: "55~66", max_cpc: 2.5 },
      ],
      DOMAINS,
    );
    expect(changes.map((c) => c.summary)).toEqual(["Pause campaign 111", "Add 1 negative keyword", "Set keyword 55~66's bid to $2.5"]);
    expect(changes[0]!.operations[0]).toEqual({ campaignOperation: { update: { resourceName: "customers/123/campaigns/111", status: "PAUSED" }, updateMask: "status" } });
    expect(() => parseChanges("123", [{ action: "remove", target: "campaign", id: "111" }], DOMAINS)).toThrow(/pause it instead/);
    expect(() => parseChanges("123", [{ action: "pause", target: "keyword", id: "66" }], DOMAINS)).toThrow(/adGroupId~id/);
    expect(plannedFromBudgets([{ budget: "b1", dailyAmount: 10 }, { budget: "b1", dailyAmount: 10 }, { budget: "b2", dailyAmount: 5 }])).toBeCloseTo(15 * 30.4);
  });
});

describe("spending: the cap check", () => {
  const C = "11111111-1111-4111-8111-111111111111";
  let dir!: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-spend-"));
    process.env.TETHR_CONNECTOR_CHANGES_FILE = path.join(dir, "changes.json");
  });
  afterAll(() => {
    setSpendAdapterForTests("Test Ads", null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("checks an account it can read: a cut isn't spending, a raise is checked against the cap, your edit wins", async () => {
    let assessment = { monthlyDelta: 0, personEdit: null as string | null };
    const adapter: SpendAdapter = {
      connector: "Test Ads",
      configured: () => true,
      plannedMonthly: async () => ({ amount: 400, currency: "USD" }),
      assess: async () => assessment,
    };
    setSpendAdapterForTests("Test Ads", adapter);
    const c: Classified = { tool: "mcp__claude_ai_Test_Ads__set_budget", connector: "Test Ads", server: "claude_ai_Test_Ads", cls: "money", summary: "x" };
    const autonomy = { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto" as const, monthlyCapUsd: 500 } };
    expect((await checkSpend(C, c, {}, autonomy)).classified.cls).toBe("write");
    assessment = { monthlyDelta: 60, personEdit: null };
    expect(await checkSpend(C, c, {}, autonomy)).toMatchObject({ withinCap: true, amount: 60, spendNote: "$460 a month planned after this; the cap is $500 a month" });
    assessment = { monthlyDelta: 200, personEdit: null };
    expect((await checkSpend(C, c, {}, autonomy)).withinCap).toBe(false);
    assessment = { monthlyDelta: 10, personEdit: "a person changed this budget in Google Ads on 2026-11-09" };
    const edited = await checkSpend(C, c, {}, autonomy);
    expect(edited.withinCap).toBe(false);
    expect(edited.spendNote).toMatch(/^a person changed this budget .*so tethr asks before changing it back/);
    adapter.assess = async () => {
      throw new Error("down");
    };
    expect(await checkSpend(C, { ...c, cls: "write" }, {}, autonomy)).toMatchObject({ withinCap: false, classified: { cls: "money" } });
  });

  it("counts what tethr's own calls committed this month for a connector it can't read", async () => {
    const c: Classified = { tool: "mcp__claude_ai_Shop__purchase", connector: "Shop", server: "claude_ai_Shop", cls: "money", summary: "Buy" };
    const autonomy = { ...DEFAULT_CONNECTOR_AUTONOMY, spend: { mode: "auto" as const, monthlyCapUsd: 100 } };
    expect(await checkSpend(C, c, { amount: 40 }, autonomy)).toMatchObject({ withinCap: true, amount: 40 });
    await recordChange(C, { connector: "Shop", tool: "purchase", summary: "Buy", cls: "money", how: "auto", by: "@tethr", amount: 80, hash: "h1", ok: true });
    await recordChange(C, { connector: "Shop", tool: "purchase", summary: "Buy", cls: "money", how: "auto", by: "@tethr", amount: 500, hash: "h2", ok: false });
    expect(spentThisMonth(C, "Shop")).toBe(80);
    expect((await checkSpend(C, c, { amount: 40 }, autonomy)).withinCap).toBe(false);
    expect((await checkSpend(C, c, { note: "no amount" }, autonomy)).spendNote).toMatch(/can't tell how much/);
    expect(recentChanges(C, "Shop").map((r) => r.hash)).toEqual(["h2", "h1"]);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("Google Ads on its own, through the gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  let app!: express.Express;
  const threadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  // A small fake account: Brand is live at $10/day, Malaria test is paused at $15/day.
  const account = {
    campaigns: new Map<string, { name: string; status: string; budget: string; daily: number }>(),
    edits: [] as Array<{ resource: string; client: string; at: string }>,
    batches: [] as Array<{ ops: MutateOperation[]; validateOnly: boolean }>,
  };
  const fake: AdsBackend = {
    configured: () => true,
    customerId: () => "123",
    search: async (gaql) => {
      if (/FROM customer/.test(gaql)) return [{ customer: { currencyCode: "USD" } }];
      if (/FROM change_event/.test(gaql)) {
        // Like Google: no filtering by the changed item's name (it's prohibited there).
        expect(gaql).not.toMatch(/change_resource_name =/);
        return account.edits.map((e) => ({ changeEvent: { clientType: e.client, changeDateTime: e.at, changeResourceName: e.resource } }));
      }
      if (/campaign\.status = 'ENABLED'/.test(gaql)) {
        return [...account.campaigns]
          .filter(([, c]) => c.status === "ENABLED")
          .map(([id, c]) => ({ campaign: { id, campaignBudget: c.budget }, campaignBudget: { amountMicros: String(c.daily * 1e6) } }));
      }
      const id = gaql.match(/campaign\.id = (\d+)/)?.[1];
      const c = id ? account.campaigns.get(id) : undefined;
      return c ? [{ campaign: { id, name: c.name, status: c.status, campaignBudget: c.budget }, campaignBudget: { amountMicros: String(c.daily * 1e6), explicitlyShared: false } }] : [];
    },
    mutate: async (ops, opts = {}) => {
      account.batches.push({ ops, validateOnly: opts.validateOnly === true });
      if (opts.validateOnly) return [];
      const names: string[] = [];
      for (const op of ops) {
        const campaign = op.campaignOperation as { update?: { resourceName: string; status?: string }; create?: unknown } | undefined;
        if (campaign?.update?.status) account.campaigns.get(campaign.update.resourceName.split("/").pop()!)!.status = campaign.update.status;
        if (campaign?.create) names.push("customers/123/campaigns/333");
        const budget = op.campaignBudgetOperation as { update?: { resourceName: string; amountMicros: string } } | undefined;
        if (budget?.update) for (const c of account.campaigns.values()) if (c.budget === budget.update.resourceName) c.daily = Number(budget.update.amountMicros) / 1e6;
        if ((op.adGroupOperation as { create?: unknown } | undefined)?.create) names.push("customers/123/adGroups/444");
      }
      return names;
    },
  };

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: "Done.", is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };

  async function turn() {
    const [row] = await db.insert(tethrRouteRuns).values({ companyId, requestText: "run the ads", invocationSource: "chat", threadId, status: "running", hops: [] }).returning();
    return row!;
  }
  const decisionOf = (reply: { stdout?: string }) => JSON.parse(reply.stdout ?? "{}").hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  const gate = async (tool: string, input: Record<string, unknown>) => {
    const run = await turn();
    return { run, decision: decisionOf(await handlePreToolUse(db, { companyId, threadId, runId: run.id }, { tool_name: tool, tool_input: input })) };
  };
  const runTool = async (runId: string, name: string, args: Record<string, unknown>) => {
    const token = issueHookToken({ companyId, threadId, runId });
    return (await request(app).post("/api/tethr/assistant/tools/call").set("authorization", `Bearer ${token}`).send({ name, arguments: args }).expect(200)).body as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
  };
  const setAds = (autonomy?: Record<string, unknown>) => updateIntegrations(companyId, { connectors: { "Google Ads": { mode: "auto", ...(autonomy ? { autonomy: autonomy as never } : {}) } } });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-autonomy-"));
    for (const [key, name] of [
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_PAUSED_FILE", "paused.json"],
      ["TETHR_CONNECTOR_CHANGES_FILE", "changes.json"],
      ["TETHR_QUESTIONS_FILE", "questions.json"],
    ]) {
      process.env[key!] = path.join(dir, name!);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    delete process.env.SLACK_BOT_TOKEN;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-autonomy-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    app = express();
    app.use(express.json());
    app.use("/api", tethrRoutes(db));
    setAdsBackendForTests(fake);
  }, 60_000);

  afterAll(async () => {
    setAdsBackendForTests(null);
    setAssistantRunnerForTests(null);
    await tempDb?.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    resetAssistantRunnerForTests();
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
    account.campaigns = new Map([
      ["111", { name: "Brand", status: "ENABLED", budget: "customers/123/campaignBudgets/900", daily: 10 }],
      ["222", { name: "Malaria test", status: "PAUSED", budget: "customers/123/campaignBudgets/901", daily: 15 }],
    ]);
    account.edits = [];
    account.batches = [];
    await changeStore.update(companyId, () => ({ changes: [] }));
    await setAds({ spend: { mode: "ask", monthlyCapUsd: null }, outside: "ask", deletes: "ask" });
  });

  it("lists the Google Ads tools only while Google Ads can change things", async () => {
    const run = await turn();
    const token = issueHookToken({ companyId, threadId, runId: run.id });
    const names = async () => ((await request(app).post("/api/tethr/assistant/tools/list").set("authorization", `Bearer ${token}`).expect(200)).body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(await names()).toEqual(expect.arrayContaining(["ads_create_campaign", "ads_change", "ads_set_budget"]));
    await updateIntegrations(companyId, { connectors: { "Google Ads": { mode: "read" } } });
    expect(await names()).not.toContain("ads_change");
    expect(integrationRulesText(getIntegrations(companyId))).toContain("Google Ads: reports only");
    await setAds();
    expect(integrationRulesText(getIntegrations(companyId))).toContain("Google Ads: change it with the ads_ tools");
    // Each connector says what it can do and how far it goes on its own (the Connections section).
    await updateIntegrations(companyId, { connectors: { Gmail: { mode: "auto" } } });
    const gmail = connectionsContextText(companyId).split("\n").find((l) => l.startsWith("- Gmail:"))!;
    expect(gmail).toContain("Automatic: changes run on their own, outside people ask, deletes ask. It can: Search and read mail");
    expect(gmail).not.toContain("..");
    expect(connectionsContextText(companyId)).toContain("- Google Ads: ");
  });

  it("builds a campaign on its own (paused), and logs it", async () => {
    const input = {
      name: "Malaria · Exact",
      daily_budget: 15,
      final_url: "https://travelwithwandr.com/malaria",
      keywords: ["[malaria pills]"],
      headlines: ["Malaria Pills Online", "Prescribed in Minutes", "Travel Clinic, No Wait"],
      descriptions: ["Get malaria pills prescribed online before your trip.", "A US clinician reviews your trip."],
    };
    const { run, decision } = await gate("mcp__tethr__ads_create_campaign", input);
    expect(decision.permissionDecision).toBe("allow");
    const result = await runTool(run.id, "ads_create_campaign", input);
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toMatch(/^Created campaign "Malaria · Exact" \(id 333\), paused/);
    expect(account.batches).toHaveLength(1);
    expect(recentChanges(companyId, "Google Ads")[0]).toMatchObject({ how: "auto", ok: true, by: "@tethr", tool: "ads_create_campaign" });
    // An off-site landing page is refused before anything is sent.
    const off = await runTool(run.id, "ads_create_campaign", { ...input, final_url: "https://elsewhere.example/x" });
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toMatch(/own website/);
    expect(account.batches).toHaveLength(1);
  });

  it("asks an admin before turning a campaign on; approving runs that exact call once", async () => {
    const input = { changes: [{ action: "enable", target: "campaign", id: "222" }] };
    const { run, decision } = await gate("mcp__tethr__ads_change", input);
    expect(decision.permissionDecision).toBe("deny");
    expect(decision.permissionDecisionReason).toMatch(/sent for approval/);
    const [card] = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "external_action"), eq(tethrOutputs.status, "gated")));
    expect(card).toMatchObject({ sensitivity: "spend" });
    // Planned now: Brand $10/day; after: + Malaria test $15/day = $760 a month.
    expect(card!.body).toContain("Spending: $760 a month planned after this; no monthly cap is set.");
    // In words, spending first, then exactly what runs.
    expect(card!.body.indexOf("Spending:")).toBeLessThan(card!.body.indexOf("- Turn on campaign 222"));
    // Not before it's approved.
    expect((await runTool(run.id, "ads_change", input)).isError).toBe(true);
    expect(account.campaigns.get("222")!.status).toBe("PAUSED");

    await gatingService(db).decide({ companyId, outputId: card!.id, decision: "approve", reviewer: "local-board" });
    const again = await gate("mcp__tethr__ads_change", input);
    expect(again.decision.permissionDecision).toBe("allow");
    const ran = await runTool(again.run.id, "ads_change", input);
    expect(ran.isError).toBe(false);
    expect(account.campaigns.get("222")!.status).toBe("ENABLED");
    expect(recentChanges(companyId, "Google Ads")[0]).toMatchObject({ how: "approved", cls: "money", ok: true });
    // Once only: paused again (by a person), the same approval can't turn it back on.
    account.campaigns.get("222")!.status = "PAUSED";
    expect((await runTool(again.run.id, "ads_change", input)).isError).toBe(true);
    expect(account.campaigns.get("222")!.status).toBe("PAUSED");
  });

  it("raises a budget on its own under the cap, asks above it, and asks when you changed it yourself", async () => {
    await setAds({ spend: { mode: "auto", monthlyCapUsd: 1000 }, outside: "ask", deletes: "ask" });
    // Planned: Brand $10/day = $304. $12/day adds $60.80: under the cap.
    const small = await gate("mcp__tethr__ads_set_budget", { campaign_id: "111", daily_budget: 12 });
    expect(small.decision.permissionDecision).toBe("allow");
    expect((await runTool(small.run.id, "ads_set_budget", { campaign_id: "111", daily_budget: 12 })).content[0]!.text).toBe('Set "Brand"\'s budget from $10 to $12 a day.');
    // $40/day would plan $1,216 a month: over the cap.
    expect((await gate("mcp__tethr__ads_set_budget", { campaign_id: "111", daily_budget: 40 })).decision.permissionDecision).toBe("deny");
    // A cut is a plain change, even with spending on ask.
    await setAds({ spend: { mode: "ask", monthlyCapUsd: 1000 }, outside: "ask", deletes: "ask" });
    expect((await gate("mcp__tethr__ads_set_budget", { campaign_id: "111", daily_budget: 8 })).decision.permissionDecision).toBe("allow");
    // You lowered it in Google Ads: tethr doesn't raise it back on its own.
    await setAds({ spend: { mode: "auto", monthlyCapUsd: 1000 }, outside: "ask", deletes: "ask" });
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    // tethr's own API changes and a person's edit to another budget don't count.
    account.edits.push({ resource: "customers/123/campaignBudgets/900", client: "GOOGLE_ADS_API", at: now });
    account.edits.push({ resource: "customers/123/campaignBudgets/901", client: "GOOGLE_ADS_WEB_CLIENT", at: now });
    // (Brand is at $12/day now: $14 is a raise, under the cap.)
    expect((await gate("mcp__tethr__ads_set_budget", { campaign_id: "111", daily_budget: 14 })).decision.permissionDecision).toBe("allow");
    account.edits.push({ resource: "customers/123/campaignBudgets/900", client: "GOOGLE_ADS_WEB_CLIENT", at: now });
    const undo = await gate("mcp__tethr__ads_set_budget", { campaign_id: "111", daily_budget: 13 });
    expect(undo.decision.permissionDecision).toBe("deny");
    const cards = await db.select().from(tethrOutputs).where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "external_action"), eq(tethrOutputs.status, "gated")));
    expect(cards.some((c) => /a person changed this budget in Google Ads/.test(c.body))).toBe(true);
  });

  it("holds any connector the same way: Meta Ads spending under its own cap, outside email by its own setting", async () => {
    await updateIntegrations(companyId, { connectors: { "Meta Ads": { mode: "auto" } } });
    const budget = { daily_budget: 20 };
    expect((await gate("mcp__claude_ai_Meta_Ads__update_budget", budget)).decision.permissionDecision).toBe("deny");
    await updateIntegrations(companyId, { connectors: { "Meta Ads": { mode: "auto", autonomy: { spend: { mode: "auto", monthlyCapUsd: 1000 }, outside: "ask", deletes: "ask" } } } });
    const first = await gate("mcp__claude_ai_Meta_Ads__update_budget", budget);
    expect(first.decision.permissionDecision).toBe("allow");
    await handlePostToolUse(db, { companyId, threadId, runId: first.run.id }, { tool_name: "mcp__claude_ai_Meta_Ads__update_budget", tool_input: budget, tool_response: { ok: true } });
    expect(spentThisMonth(companyId, "Meta Ads")).toBeCloseTo(608);
    // Another $608 would pass $1,000.
    expect((await gate("mcp__claude_ai_Meta_Ads__update_budget", budget)).decision.permissionDecision).toBe("deny");
    expect(autonomyFor(getIntegrations(companyId), "Meta Ads").spend.monthlyCapUsd).toBe(1000);

    const email = { to: ["someone@partner.com"], subject: "Hello", body: "A note." };
    await updateIntegrations(companyId, { connectors: { Gmail: { mode: "auto" } } });
    expect((await gate("mcp__claude_ai_Gmail__send_message", email)).decision.permissionDecision).toBe("deny");
    await updateIntegrations(companyId, { connectors: { Gmail: { autonomy: { spend: { mode: "ask", monthlyCapUsd: null }, outside: "auto", deletes: "ask" } } } });
    expect(getIntegrations(companyId).connectors.Gmail!.mode).toBe("auto");
    expect((await gate("mcp__claude_ai_Gmail__send_message", { ...email, subject: "Hello again" })).decision.permissionDecision).toBe("allow");
  });
});
