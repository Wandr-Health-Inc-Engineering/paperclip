import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  createDb,
  heartbeatRuns,
  routines,
  routineTriggers,
  tethrAgentProfiles,
} from "@paperclipai/db";
import { initTethrAdapter, tethrLlmAdapter } from "../tethr/adapter.ts";
import { setTethrLLMProvider } from "../tethr/llm/index.ts";
import { MockProvider } from "../tethr/llm/mock.ts";
import type { LLMProvider } from "../tethr/llm/types.ts";
import { validateAgentSpec, instantiateAgentFromSpec } from "../tethr/factory.ts";
import { routingService } from "../tethr/routing.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedFilerAgent } from "../tethr/seed/filer.ts";
import {
  ARCHIVE_PAUSE_REASON,
  SPECIALIST_TAGS,
  archiveSpecialists,
  archiveSpecialistsOnce,
  getArchiveRecord,
  restoreSpecialists,
} from "../tethr/seed/fresh-start.ts";
import { seedGrowthWorkflows } from "../tethr/seed/growth-workflows.ts";
import { seedPatchAgent } from "../tethr/seed/patch.ts";
import { seedRankAgent } from "../tethr/seed/rank.ts";
import { seedTankAgent } from "../tethr/seed/tank.ts";
import { healTethrRoutingCopy, seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedTinkrAgent } from "../tethr/seed/tinkr.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Phase 18 — the fresh start. The nine specialists are archived (paused,
// recoverable, never terminated), their routines + @tethr's weekly review are
// paused with triggers off, @tethr's routing rows to them are stripped, and the
// whole thing is stashed in an instance-dir JSON so restore puts it all back.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

type RoutingRow = { when: string[]; to: string; description?: string };

describeEmbeddedPostgres("tethr fresh start (archive / restore specialists)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let originalRouting: RoutingRow[] = [];
  let ceoHeartbeatId!: string;
  let ceoTriggerId!: string;

  async function profile(tag: string) {
    const [row] = await db
      .select({ profile: tethrAgentProfiles, agent: agents })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    return row ?? null;
  }

  async function tethrRouting(): Promise<RoutingRow[]> {
    return ((await profile("@tethr"))!.profile.routingTable ?? []) as RoutingRow[];
  }

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-fresh-start-test-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    process.env.TETHR_ARCHIVE_FILE = path.join(storageDir, "tethr-archive.json");
    process.env.TETHR_PAUSED_FILE = path.join(storageDir, "tethr-paused.json");
    delete process.env.ANTHROPIC_API_KEY;
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-fresh-start-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    // The live org as it stood before the fresh start: every specialist seeded…
    const ceo = await seedCeoAgent(db, companyId);
    await seedTinkrAgent(db, companyId);
    await seedPatchAgent(db, companyId);
    await seedFilerAgent(db, companyId);
    await seedRankAgent(db, companyId);
    await seedTankAgent(db, companyId);
    await seedGrowthWorkflows(db, companyId);
    // …plus a factory-made specialist (@radar exists only in the DB).
    const spec = validateAgentSpec(
      {
        codename: "Radar",
        role: "Market Research",
        mission: "Watch the market.",
        rationale: "We have no market read.",
        tools: ["web_fetch"],
        budgetMonthlyCents: 2000,
        heartbeatCron: "0 9 * * 1",
        subagents: [
          { key: "scan", name: "Scanner", job: "Scan competitors.", routeWhen: ["competitor"], steps: ["fetch"], output: "brief", guardrails: ["read-only"], sensitivity: "internal" },
        ],
      },
      { existingTags: new Set(["@tethr", "@ceo"]) },
    ).spec!;
    await instantiateAgentFromSpec(db, companyId, spec, { reportsTo: ceo.agentId });

    // Mark had switched the CEO's heartbeat on — archive must turn it off and
    // restore must turn it back on.
    const [hb] = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, "CEO heartbeat")))
      .limit(1);
    ceoHeartbeatId = hb.id;
    await db.update(routines).set({ status: "active" }).where(eq(routines.id, hb.id));
    const [trigger] = await db
      .select({ id: routineTriggers.id })
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, hb.id))
      .limit(1);
    ceoTriggerId = trigger.id;
    await db.update(routineTriggers).set({ enabled: true }).where(eq(routineTriggers.id, trigger.id));

    // Someone had paused @patch by hand — restore must bring back THAT reason.
    const patch = await profile("@patch");
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "Paused via Tinkr by mark" })
      .where(eq(agents.id, patch!.agent.id));

    originalRouting = await tethrRouting();
  }, 90_000);

  afterAll(async () => {
    setTethrLLMProvider(null);
    await tempDb?.cleanup();
    delete process.env.TETHR_ARCHIVE_FILE;
    delete process.env.TETHR_PAUSED_FILE;
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("starts from a routed org: @tethr has rows to the specialists", () => {
    const targets = originalRouting.map((r) => r.to);
    expect(targets[0]).toBe("@tethr");
    for (const tag of ["@ceo", "@tinkr", "@patch", "@filer", "@rank", "@tank", "@radar"]) {
      expect(targets).toContain(tag);
    }
    expect(getArchiveRecord(companyId)).toBeNull();
  });

  it("archives every specialist as PAUSED with the archive reason (never terminated); @tethr stays live", async () => {
    const result = await archiveSpecialists(db, companyId, { by: "test" });
    expect(result.alreadyArchived).toBe(false);
    expect(result.archived.sort()).toEqual(
      ["@ceo", "@tinkr", "@patch", "@filer", "@rank", "@tank", "@radar"].sort(),
    );
    const rows = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, tag: tethrAgentProfiles.tag })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
      .where(
        and(
          eq(tethrAgentProfiles.companyId, companyId),
          inArray(tethrAgentProfiles.tag, [...SPECIALIST_TAGS] as string[]),
        ),
      );
    expect(rows.length).toBe(7);
    for (const row of rows) {
      expect(row.status).toBe("paused");
      expect(row.pauseReason).toBe(ARCHIVE_PAUSE_REASON);
    }
    const tethr = await profile("@tethr");
    expect(tethr!.agent.status).not.toBe("paused");
  });

  it("pauses the specialists' routines + @tethr's weekly growth review, and turns their triggers off", async () => {
    const tethr = await profile("@tethr");
    const all = await db
      .select({ id: routines.id, title: routines.title, status: routines.status, assigneeAgentId: routines.assigneeAgentId })
      .from(routines)
      .where(eq(routines.companyId, companyId));
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) expect(r.status).toBe("paused");
    expect(all.some((r) => r.title === "Weekly growth review" && r.assigneeAgentId === tethr!.agent.id)).toBe(true);
    const triggers = await db
      .select({ enabled: routineTriggers.enabled })
      .from(routineTriggers)
      .where(eq(routineTriggers.companyId, companyId));
    expect(triggers.length).toBeGreaterThan(0);
    expect(triggers.every((t) => t.enabled === false)).toBe(true);
  });

  it("strips @tethr's routing rows to archived tags — and the routing-copy heal doesn't re-add @ceo", async () => {
    const rows = await tethrRouting();
    expect(rows.map((r) => r.to)).toEqual(["@tethr"]);
    await healTethrRoutingCopy(db);
    expect((await tethrRouting()).map((r) => r.to)).toEqual(["@tethr"]);
  });

  it("stashes what it changed in the instance-dir archive file", () => {
    const record = getArchiveRecord(companyId)!;
    expect(record.state).toBe("archived");
    expect(record.archivedBy).toBe("test");
    expect(record.agents.map((a) => a.tag).sort()).toEqual(
      ["@ceo", "@tinkr", "@patch", "@filer", "@rank", "@tank", "@radar"].sort(),
    );
    expect(record.routingRows.length).toBe(originalRouting.length - 1);
    expect(record.triggers.some((t) => t.triggerId === ceoTriggerId)).toBe(true);
    expect(record.routines.some((r) => r.routineId === ceoHeartbeatId && r.status === "active")).toBe(true);
    const patch = record.agents.find((a) => a.tag === "@patch")!;
    expect(patch.status).toBe("paused");
    expect(patch.pauseReason).toBe("Paused via Tinkr by mark");
  });

  it("is idempotent — a second archive changes nothing and leaves the stash alone", async () => {
    const before = fs.readFileSync(process.env.TETHR_ARCHIVE_FILE!, "utf8");
    const again = await archiveSpecialists(db, companyId);
    expect(again.alreadyArchived).toBe(true);
    expect(again.archived).toEqual([]);
    expect(again.routinesPaused).toBe(0);
    expect(again.triggersDisabled).toBe(0);
    expect(again.routingRowsRemoved).toBe(0);
    expect(fs.readFileSync(process.env.TETHR_ARCHIVE_FILE!, "utf8")).toBe(before);
    // The boot path is run-once: a company with a record is never touched again.
    expect(await archiveSpecialistsOnce(db, companyId)).toBeNull();
  });

  it("routes an ask aimed at an archived agent to @tethr instead", async () => {
    const routing = routingService(db);
    const direct = await routing.routeRequest({
      companyId,
      requestText: "What keywords should we rank for on malaria prophylaxis timing?",
      startAtAgentTag: "@rank",
      subagentChain: ["keywords"],
    });
    expect(direct.status).not.toBe("failed");
    expect(direct.hops.some((h) => h.decision === "fallback → @tethr")).toBe(true);
    expect(direct.hops.some((h) => h.actorTag === "@rank.keywords")).toBe(false);
    expect(direct.outputs.length).toBeGreaterThan(0);
    expect(direct.outputs.every((o) => o.agentTag === "@tethr")).toBe(true);
  });

  it("never reaches @ceo from a normal (Slack/chat) ask — even an explicit hand-off", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "plan our spring-break malaria push: delegate keyword research to @rank and a GEO audit to @tank",
      invocationSource: "slack",
    });
    expect(result.status).not.toBe("failed");
    expect(result.hops.some((h) => h.actorTag.startsWith("@ceo"))).toBe(false);
    expect(result.hops.some((h) => h.decision.includes("@ceo"))).toBe(false);
    expect(result.outputs.every((o) => o.agentTag === "@tethr")).toBe(true);
  });

  it("restore brings everything back exactly — statuses, routines, triggers, routing rows", async () => {
    const result = await restoreSpecialists(db, companyId, { by: "test" });
    expect(result.hadArchive).toBe(true);
    expect(result.restored.length).toBe(7);

    for (const tag of ["@ceo", "@tinkr", "@filer", "@rank", "@tank", "@radar"]) {
      const row = await profile(tag);
      expect(row!.agent.status).toBe("idle");
      expect(row!.agent.pauseReason).toBeNull();
    }
    const patch = await profile("@patch");
    expect(patch!.agent.status).toBe("paused");
    expect(patch!.agent.pauseReason).toBe("Paused via Tinkr by mark");

    const [hb] = await db.select().from(routines).where(eq(routines.id, ceoHeartbeatId));
    expect(hb.status).toBe("active");
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.id, ceoTriggerId));
    expect(trigger.enabled).toBe(true);
    // Workflows that were paused before the archive stay paused.
    const [review] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, "Weekly growth review")));
    expect(review.status).toBe("paused");

    expect(await tethrRouting()).toEqual(originalRouting);
  });

  it("marks the record restored, so the boot archive never re-runs; a second restore is a no-op", async () => {
    const record = getArchiveRecord(companyId)!;
    expect(record.state).toBe("restored");
    expect(record.restoredBy).toBe("test");
    expect(await archiveSpecialistsOnce(db, companyId)).toBeNull();
    expect((await profile("@ceo"))!.agent.status).toBe("idle");
    const again = await restoreSpecialists(db, companyId);
    expect(again.hadArchive).toBe(false);
  });

  it("can archive again after a restore (explicit route path), and routing falls back again", async () => {
    const result = await archiveSpecialists(db, companyId);
    expect(result.archived.length).toBe(7);
    expect((await tethrRouting()).map((r) => r.to)).toEqual(["@tethr"]);
    await restoreSpecialists(db, companyId);
    expect(await tethrRouting()).toEqual(originalRouting);
  });

  it("adapter reports a priced run's cost TOP-LEVEL (what core bills), not only in resultJson", async () => {
    // The mock's brain with a live provider's id + model, so the run is priced.
    const mock = new MockProvider();
    const priced: LLMProvider = {
      id: "claude",
      model: "claude-sonnet-4-6",
      classify: (i) => mock.classify(i),
      generate: (i) => mock.generate(i),
      runAgentic: (i) => mock.runAgentic(i),
      plan: (i) => mock.plan(i),
      proposeAgent: (i) => mock.proposeAgent(i),
    };
    setTethrLLMProvider(priced);
    initTethrAdapter(db);
    const tethr = await profile("@tethr");
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: tethr!.agent.id, invocationSource: "on_demand", status: "running", startedAt: new Date() })
      .returning();
    const result = await tethrLlmAdapter.execute({
      runId: run.id,
      agent: {
        ...tethr!.agent,
        adapterConfig: { agentTag: "@tethr", heartbeatRequest: "what do you do?" },
      },
      context: {},
      onLog: async () => {},
    } as never);
    setTethrLLMProvider(null);
    expect(result.exitCode).toBe(0);
    expect(typeof result.costUsd).toBe("number");
    expect(result.costUsd!).toBeGreaterThan(0);
    expect((result.resultJson as { costUsd?: number }).costUsd).toBe(result.costUsd);
  });
});
