import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routines, routineTriggers, tethrAgentProfiles, tethrOutputs } from "@paperclipai/db";
import { GROWTH_WORKFLOWS } from "./seed/growth-workflows.js";

// Phase 16 — the growth board: one read model for the COO view. Which growth
// workflows exist (and whether they're switched on), and every task the
// agents are carrying, sorted by what needs attention: waiting on a human,
// working, blocked on sub-tasks, queued, and done this week.

export interface GrowthTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeTag: string | null;
  parentId: string | null;
  parentTitle: string | null;
  childCount: number;
  doneChildCount: number;
  /** For tasks in review: the Queue item waiting on a decision. */
  pendingOutputId: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface GrowthWorkflowRow {
  routineId: string;
  key: string | null;
  title: string;
  ownerTag: string | null;
  /** Routine status (active / paused / archived). */
  status: string;
  /** Whether its schedule trigger is enabled. "On" = active AND enabled. */
  scheduleEnabled: boolean;
  cadence: string | null;
  lastTriggeredAt: string | null;
}

export interface GrowthBoard {
  workflows: GrowthWorkflowRow[];
  lanes: {
    waitingOnYou: GrowthTask[];
    working: GrowthTask[];
    blocked: GrowthTask[];
    queued: GrowthTask[];
    doneThisWeek: GrowthTask[];
  };
  counts: {
    open: number;
    waitingOnYou: number;
    doneThisWeek: number;
    workflowsOn: number;
    workflowsTotal: number;
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Which lane a task belongs in. Pure. */
export function growthLane(
  status: string,
): keyof GrowthBoard["lanes"] | null {
  switch (status) {
    case "in_review":
      return "waitingOnYou";
    case "in_progress":
      return "working";
    case "blocked":
      return "blocked";
    case "todo":
    case "backlog":
      return "queued";
    case "done":
      return "doneThisWeek";
    default:
      return null; // cancelled and anything unknown stay off the board
  }
}

export async function growthBoard(db: Db, companyId: string, now = new Date()): Promise<GrowthBoard> {
  const profiles = await db
    .select({ agentId: tethrAgentProfiles.agentId, tag: tethrAgentProfiles.tag })
    .from(tethrAgentProfiles)
    .where(eq(tethrAgentProfiles.companyId, companyId));
  const tagByAgent = new Map(profiles.map((p) => [p.agentId, p.tag]));
  const agentIds = profiles.map((p) => p.agentId);

  const lanes: GrowthBoard["lanes"] = { waitingOnYou: [], working: [], blocked: [], queued: [], doneThisWeek: [] };
  const workflows: GrowthWorkflowRow[] = [];
  if (agentIds.length === 0) {
    return { workflows, lanes, counts: { open: 0, waitingOnYou: 0, doneThisWeek: 0, workflowsOn: 0, workflowsTotal: 0 } };
  }

  // Tasks the agents carry (cancelled ones and anything done > a week ago drop off).
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.assigneeAgentId, agentIds),
        sql`${issues.status} <> 'cancelled'`,
        sql`(${issues.status} <> 'done' OR ${issues.completedAt} >= ${weekAgo.toISOString()}::timestamptz)`,
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(200);

  const ids = rows.map((r) => r.id);
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((p): p is string => Boolean(p)))];
  const parentTitles = new Map<string, string>();
  if (parentIds.length) {
    const parents = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(inArray(issues.id, parentIds));
    for (const p of parents) parentTitles.set(p.id, p.title);
  }
  const childCounts = new Map<string, { total: number; done: number }>();
  if (ids.length) {
    const kids = await db
      .select({ parentId: issues.parentId, status: issues.status })
      .from(issues)
      .where(inArray(issues.parentId, ids));
    for (const k of kids) {
      if (!k.parentId) continue;
      const c = childCounts.get(k.parentId) ?? { total: 0, done: 0 };
      c.total += 1;
      if (k.status === "done") c.done += 1;
      childCounts.set(k.parentId, c);
    }
  }
  const reviewIds = rows.filter((r) => r.status === "in_review").map((r) => r.id);
  const pendingByTask = new Map<string, string>();
  if (reviewIds.length) {
    const pending = await db
      .select({ id: tethrOutputs.id, taskIssueId: sql<string>`${tethrOutputs.meta} ->> 'taskIssueId'` })
      .from(tethrOutputs)
      .where(
        and(
          eq(tethrOutputs.companyId, companyId),
          inArray(tethrOutputs.status, ["gated", "changes_requested"]),
          inArray(sql<string>`${tethrOutputs.meta} ->> 'taskIssueId'`, reviewIds),
        ),
      )
      .orderBy(desc(tethrOutputs.createdAt));
    for (const p of pending) if (!pendingByTask.has(p.taskIssueId)) pendingByTask.set(p.taskIssueId, p.id);
  }

  for (const r of rows) {
    const lane = growthLane(r.status);
    if (!lane) continue;
    const counts = childCounts.get(r.id) ?? { total: 0, done: 0 };
    lanes[lane].push({
      id: r.id,
      identifier: r.identifier ?? null,
      title: r.title,
      status: r.status,
      priority: r.priority,
      assigneeTag: r.assigneeAgentId ? (tagByAgent.get(r.assigneeAgentId) ?? null) : null,
      parentId: r.parentId ?? null,
      parentTitle: r.parentId ? (parentTitles.get(r.parentId) ?? null) : null,
      childCount: counts.total,
      doneChildCount: counts.done,
      pendingOutputId: pendingByTask.get(r.id) ?? null,
      updatedAt: r.updatedAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    });
  }

  // Workflows: every routine an agent owns; the growth ones carry their key.
  const routineRows = await db
    .select()
    .from(routines)
    .where(and(eq(routines.companyId, companyId), inArray(routines.assigneeAgentId, agentIds)))
    .orderBy(routines.createdAt);
  const routineIds = routineRows.map((r) => r.id);
  const triggers = routineIds.length
    ? await db
        .select()
        .from(routineTriggers)
        .where(and(inArray(routineTriggers.routineId, routineIds), eq(routineTriggers.kind, "schedule")))
    : [];
  const keyByTitle = new Map(GROWTH_WORKFLOWS.map((w) => [w.title, w.key]));
  for (const r of routineRows) {
    if (r.status === "archived") continue;
    const trig = triggers.find((t) => t.routineId === r.id);
    workflows.push({
      routineId: r.id,
      key: keyByTitle.get(r.title) ?? null,
      title: r.title,
      ownerTag: r.assigneeAgentId ? (tagByAgent.get(r.assigneeAgentId) ?? null) : null,
      status: r.status,
      scheduleEnabled: Boolean(trig?.enabled),
      cadence: trig?.label ?? trig?.cronExpression ?? null,
      lastTriggeredAt: r.lastTriggeredAt ? r.lastTriggeredAt.toISOString() : null,
    });
  }
  // Growth workflows first, in playbook order; others (e.g. a CEO heartbeat) after.
  const order = new Map(GROWTH_WORKFLOWS.map((w, i) => [w.key, i]));
  workflows.sort((a, b) => (order.get(a.key ?? "") ?? 99) - (order.get(b.key ?? "") ?? 99));

  const open = lanes.waitingOnYou.length + lanes.working.length + lanes.blocked.length + lanes.queued.length;
  return {
    workflows,
    lanes,
    counts: {
      open,
      waitingOnYou: lanes.waitingOnYou.length,
      doneThisWeek: lanes.doneThisWeek.length,
      workflowsOn: workflows.filter((w) => w.status === "active" && w.scheduleEnabled).length,
      workflowsTotal: workflows.length,
    },
  };
}
