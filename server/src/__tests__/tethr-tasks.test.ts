import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  agents,
  createDb,
  issueComments,
  issues,
  routines,
  routineTriggers,
  tethrAgentProfiles,
  tethrOutputs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedRankAgent } from "../tethr/seed/rank.ts";
import { seedTankAgent } from "../tethr/seed/tank.ts";
import { seedTinkrAgent } from "../tethr/seed/tinkr.ts";
import { gatingService } from "../tethr/gating.ts";
import { CEO_GROWTH_TITLE, GROWTH_WORKFLOWS, seedGrowthWorkflows } from "../tethr/seed/growth-workflows.ts";
import { growthBoard, growthLane } from "../tethr/growth.ts";
import { routingService } from "../tethr/routing.ts";
import { initTethrAdapter } from "../tethr/adapter.ts";
import { parseDelegations } from "../tethr/llm/mock.ts";
import {
  TASK_LIMITS,
  TETHR_DELEGATION_ORIGIN,
  buildTaskRequest,
  buildTaskResultComment,
  newTaskRunState,
  nextTaskStatus,
  taskService,
  titleFromRequest,
} from "../tethr/tasks.ts";

// Phase 16a — the delegation backbone: Tethr agents work Paperclip tasks,
// delegate sub-tasks to each other, and roll up when the children finish.

describe("tethr tasks — pure helpers", () => {
  it("parses a delegation request into one task per agent", () => {
    expect(
      parseDelegations(
        "Plan our spring-break malaria push: delegate keyword research to @rank and a GEO audit of the malaria page to @tank.",
      ),
    ).toEqual([
      { to: "@rank", title: "Keyword research" },
      { to: "@tank", title: "A GEO audit of the malaria page" },
    ]);
    expect(parseDelegations("what's our ad spend?")).toEqual([]);
  });

  it("moves a task to the right status after a run", () => {
    expect(nextTaskStatus({ runStatus: "done", anyGated: false, delegatedThisRun: 0, openChildren: 0 })).toBe("done");
    expect(nextTaskStatus({ runStatus: "gated", anyGated: true, delegatedThisRun: 0, openChildren: 0 })).toBe("in_review");
    expect(nextTaskStatus({ runStatus: "done", anyGated: false, delegatedThisRun: 2, openChildren: 0 })).toBe("blocked");
    expect(nextTaskStatus({ runStatus: "done", anyGated: false, delegatedThisRun: 0, openChildren: 1 })).toBe("blocked");
    expect(nextTaskStatus({ runStatus: "failed", anyGated: false, delegatedThisRun: 0, openChildren: 0 })).toBeNull();
  });

  it("builds the task request, with a roll-up instruction when children finished", () => {
    const ctx = {
      issue: {
        id: "11111111-1111-1111-1111-111111111111",
        identifier: "WD-7",
        title: "Spring-break malaria push",
        description: "Get more travelers to buy malaria pills before March.",
        priority: "high",
      },
      parent: null,
      comments: [{ author: "@ceo", body: "Kicking this off." }],
      children: [
        { identifier: "WD-8", title: "Keyword research", status: "done", assigneeTag: "@rank", lastComment: "Top term: malaria pills for travel." },
      ],
    } as unknown as Parameters<typeof buildTaskRequest>[0];
    const text = buildTaskRequest(ctx, { agentTag: "@ceo", wakeReason: "issue_children_completed" });
    expect(text).toContain("task WD-7");
    expect(text).toContain("Get more travelers");
    expect(text).toContain("WD-8 (@rank, done): Keyword research — Top term");
    expect(text).toMatch(/Do not delegate again/);
    expect(buildTaskRequest(ctx, { agentTag: "@ceo" })).not.toMatch(/Do not delegate again/);
  });

  it("sorts tasks into growth-board lanes; cancelled stays off the board", () => {
    expect(growthLane("in_review")).toBe("waitingOnYou");
    expect(growthLane("in_progress")).toBe("working");
    expect(growthLane("blocked")).toBe("blocked");
    expect(growthLane("todo")).toBe("queued");
    expect(growthLane("done")).toBe("doneThisWeek");
    expect(growthLane("cancelled")).toBeNull();
  });

  it("writes a result comment listing outputs and delegations", () => {
    const body = buildTaskResultComment({
      agentTag: "@ceo",
      resultText: "Split the push in two.",
      outputs: [{ title: "Growth brief", status: "published", gated: false }],
      delegated: [{ identifier: "WD-8", toTag: "@rank" }],
    });
    expect(body).toContain("Growth brief — published");
    expect(body).toContain("WD-8 → @rank");
    expect(body.trim().endsWith("— @ceo")).toBe(true);
    expect(titleFromRequest("  Plan the push\nmore detail")).toBe("Plan the push");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tethr tasks — delegation on Paperclip issues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  const agentIdByTag = async (tag: string) => {
    const [p] = await db
      .select({ agentId: tethrAgentProfiles.agentId })
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    return p!.agentId;
  };

  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> => {
    const start = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v as T;
      if (Date.now() - start > ms) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-tasks-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock
    process.env.TETHR_LIVE_FETCH = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-tasks-");
    db = createDb(tempDb.connectionString);
    initTethrAdapter(db);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    await seedCeoAgent(db, companyId);
    await seedRankAgent(db, companyId);
    await seedTankAgent(db, companyId);
    await seedTinkrAgent(db, companyId);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("refuses bad delegations: self, unknown agent, roll-up runs", async () => {
    const tasks = taskService(db);
    const ceoId = await agentIdByTag("@ceo");
    const self = await tasks.delegate({
      companyId,
      fromAgentId: ceoId,
      fromTag: "@ceo",
      state: newTaskRunState({ requestText: "x" }),
      toTag: "@ceo",
      title: "Do it",
      brief: "",
    });
    expect(self.ok).toBe(false);
    const ghost = await tasks.delegate({
      companyId,
      fromAgentId: ceoId,
      fromTag: "@ceo",
      state: newTaskRunState({ requestText: "x" }),
      toTag: "@ghost",
      title: "Do it",
      brief: "",
    });
    expect(ghost.ok).toBe(false);
    const rollup = await tasks.delegate({
      companyId,
      fromAgentId: ceoId,
      fromTag: "@ceo",
      state: newTaskRunState({ requestText: "x", allowDelegation: false }),
      toTag: "@rank",
      title: "Do it",
      brief: "",
    });
    expect(rollup.ok).toBe(false);
    // None of the refusals created a task.
    const created = await db.select().from(issues).where(eq(issues.originId, TETHR_DELEGATION_ORIGIN));
    expect(created).toHaveLength(0);
  });

  it("caps fan-out per task", async () => {
    const tasks = taskService(db);
    const ceoId = await agentIdByTag("@ceo");
    const state = newTaskRunState({ requestText: "Fan-out cap check" });
    const results = [];
    for (let i = 0; i < TASK_LIMITS.maxChildren + 1; i++) {
      results.push(
        await tasks.delegate({
          companyId,
          fromAgentId: ceoId,
          fromTag: "@ceo",
          state,
          toTag: i % 2 ? "@rank" : "@tank",
          title: `Piece ${i + 1}`,
          brief: "cap test",
        }),
      );
    }
    expect(results.filter((r) => r.ok)).toHaveLength(TASK_LIMITS.maxChildren);
    expect(results.at(-1)!.ok).toBe(false);
    // Clean up so the end-to-end test below starts from a quiet org.
    const rootId = state.issueId!;
    const kids = await db.select().from(issues).where(eq(issues.parentId, rootId));
    for (const k of kids) await taskService(db).setStatus(k.id, "cancelled");
    await taskService(db).setStatus(rootId, "cancelled");
  });

  it("end to end: @ceo delegates to @rank and @tank, they work their tasks, @ceo rolls up", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText:
        "Plan our spring-break malaria push: delegate keyword research to @rank and a GEO audit of the malaria page to @tank.",
    });
    expect(result.status).not.toBe("failed");
    // An explicit hand-off goes to the head of growth, not the first named specialist.
    expect(result.hops[0]).toMatchObject({ layer: "helm", decision: "route → @ceo" });

    // A root task owned by @ceo, parked while its two sub-tasks run.
    const [root] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originId, TETHR_DELEGATION_ORIGIN),
          isNull(issues.parentId),
          ne(issues.status, "cancelled"),
        ),
      );
    expect(root).toBeTruthy();
    expect(root.assigneeAgentId).toBe(await agentIdByTag("@ceo"));
    const children = await db.select().from(issues).where(eq(issues.parentId, root.id)).orderBy(asc(issues.createdAt));
    expect(children.map((c) => c.assigneeAgentId)).toEqual([await agentIdByTag("@rank"), await agentIdByTag("@tank")]);
    expect(children.every((c) => c.requestDepth === 1)).toBe(true);

    // Core wakes each assignee; the tethr_llm adapter works the task and closes it.
    const doneKids = await waitFor(async () => {
      const rows = await db.select().from(issues).where(eq(issues.parentId, root.id));
      return rows.every((r) => r.status === "done") ? rows : null;
    });
    expect(doneKids).toHaveLength(2);
    for (const kid of doneKids) {
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, kid.id));
      expect(comments.some((c) => c.authorAgentId === kid.assigneeAgentId)).toBe(true);
      // Their deliverables are linked back to the task.
      const outs = await db.select().from(tethrOutputs).where(eq(tethrOutputs.agentId, kid.assigneeAgentId!));
      expect(outs.some((o) => (o.meta as Record<string, unknown>).taskIssueId === kid.id)).toBe(true);
    }

    // The last child finishing wakes @ceo, who writes the roll-up and closes the root.
    const doneRoot = await waitFor(async () => {
      const [r] = await db.select().from(issues).where(eq(issues.id, root.id));
      return r.status === "done" ? r : null;
    });
    expect(doneRoot.status).toBe("done");
    const rootComments = await db.select().from(issueComments).where(eq(issueComments.issueId, root.id));
    expect(rootComments.length).toBeGreaterThan(0);
    // The roll-up did not delegate again.
    const after = await db.select().from(issues).where(eq(issues.parentId, root.id));
    expect(after).toHaveLength(2);
  }, 90_000);

  it("a gated sub-task waits in review; approving it in the Queue closes it and wakes the parent", async () => {
    await routingService(db).routeRequest({
      companyId,
      requestText: "Tidy the org: delegate pause @rank to @tinkr.",
      startAtAgentTag: "@ceo",
    });
    const tinkrId = await agentIdByTag("@tinkr");
    const child = await waitFor(async () => {
      const [row] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.assigneeAgentId, tinkrId), eq(issues.status, "in_review")));
      return row ?? null;
    });
    // Tinkr staged a gated org change linked to its task.
    const [staged] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.agentId, tinkrId), eq(tethrOutputs.status, "gated")));
    expect((staged.meta as Record<string, unknown>).taskIssueId).toBe(child.id);

    await gatingService(db).decide({ companyId, outputId: staged.id, decision: "approve", reviewer: "Mark" });
    const [closed] = await db.select().from(issues).where(eq(issues.id, child.id));
    expect(closed.status).toBe("done");
    // The parent (@ceo's root) is woken for the roll-up and closes too.
    const parent = await waitFor(async () => {
      const [p] = await db.select().from(issues).where(eq(issues.id, child.parentId!));
      return p.status === "done" ? p : null;
    });
    expect(parent.status).toBe("done");
  }, 90_000);

  it("seeds the growth workflows paused with schedules off, idempotently, and frames the CEO as head of growth", async () => {
    const first = await seedGrowthWorkflows(db, companyId);
    expect(first.created.sort()).toEqual(GROWTH_WORKFLOWS.map((w) => w.key).sort());
    expect(first.ceoReframed).toBe(true);
    const again = await seedGrowthWorkflows(db, companyId);
    expect(again.created).toEqual([]);

    for (const wf of GROWTH_WORKFLOWS) {
      const [r] = await db.select().from(routines).where(and(eq(routines.companyId, companyId), eq(routines.title, wf.title)));
      expect(r.status).toBe("paused");
      expect(r.assigneeAgentId).toBe(await agentIdByTag(wf.ownerTag));
      expect(r.description).toBe(wf.description);
      const trig = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, r.id));
      expect(trig).toHaveLength(1);
      expect(trig[0].enabled).toBe(false);
      expect(trig[0].cronExpression).toBe(wf.cron);
    }
    const [ceo] = await db.select().from(agents).where(eq(agents.id, await agentIdByTag("@ceo")));
    expect(ceo.title).toBe(CEO_GROWTH_TITLE);
  });

  it("the growth board shows every workflow (none on) and the week's tasks by lane", async () => {
    const board = await growthBoard(db, companyId);
    expect(board.counts.workflowsTotal).toBeGreaterThanOrEqual(GROWTH_WORKFLOWS.length);
    expect(board.counts.workflowsOn).toBe(0);
    expect(board.workflows.slice(0, GROWTH_WORKFLOWS.length).map((w) => w.key)).toEqual(GROWTH_WORKFLOWS.map((w) => w.key));
    // The delegation chains above finished: their tasks are in "done this week".
    expect(board.lanes.doneThisWeek.length).toBeGreaterThanOrEqual(4);
    const root = board.lanes.doneThisWeek.find((t) => t.childCount === 2);
    expect(root?.doneChildCount).toBe(2);
    expect(board.lanes.doneThisWeek.some((t) => t.parentTitle && t.assigneeTag === "@rank")).toBe(true);
    // Cancelled (the fan-out cap test) never shows.
    const all = Object.values(board.lanes).flat();
    expect(all.every((t) => t.status !== "cancelled")).toBe(true);
  });

  it("lists what waits on a person first, even past the limit, and the board counts all of it", async () => {
    const agentId = await agentIdByTag("@tethr");
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // An old item waiting for approval (say, from the chat), behind newer finished ones.
    const [waiting] = await db
      .insert(tethrOutputs)
      .values({ companyId, agentId, kind: "external_action", title: "Old approval", body: "x", status: "gated", sensitivity: "external", createdAt: old })
      .returning();
    await db.insert(tethrOutputs).values(
      Array.from({ length: 3 }, (_, i) => ({ companyId, agentId, title: `Done ${i}`, body: "x", status: "published" })),
    );
    const listed = await gatingService(db).listOutputs(companyId, { limit: 2 });
    expect(listed[0].id).toBe(waiting.id);

    const pending = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), inArray(tethrOutputs.status, ["gated", "changes_requested"])));
    const board = await growthBoard(db, companyId);
    expect(board.counts.pendingDecisions).toBe(pending.length);
    expect(board.counts.pendingDecisions).toBeGreaterThan(board.counts.waitingOnYou);
  });
});
