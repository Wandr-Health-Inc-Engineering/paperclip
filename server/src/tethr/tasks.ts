import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues, tethrAgentProfiles } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import { issueService } from "../services/issues.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

// Phase 16a — Tethr on Paperclip tasks (the delegation backbone).
//
// Tethr used to run every request as a one-shot "route run" beside the engine,
// ignoring Paperclip's own task system. Now Tethr agents WORK tasks (issues):
// the tethr_llm adapter, woken with a task id, runs the assigned agent on it,
// comments the result and closes it (or parks it in review while a gated
// output waits in the Queue). Agents DELEGATE by creating child tasks for
// other agents; when every child is finished, core-style wakes bring the
// parent's owner back to write the roll-up. The Queue closes the loop: a
// decision on an output that belongs to a task updates that task.
//
// Everything here goes through core's issue service + wakeup helpers (no core
// edits), mirroring the side effects the issue routes perform.

/** Delegation guardrails: how deep a chain can go and how wide a task can fan out. */
export const TASK_LIMITS = {
  /** Root task is depth 0; its children 1; grandchildren 2. Nothing deeper. */
  maxDepth: 2,
  /** Children one task may have from delegation. */
  maxChildren: 6,
} as const;

export const TETHR_DELEGATION_ORIGIN = "tethr:delegation";

type IssueRow = typeof issues.$inferSelect;

export interface TaskChildSummary {
  identifier: string | null;
  title: string;
  status: string;
  assigneeTag: string | null;
  lastComment: string | null;
}

export interface TaskContext {
  issue: IssueRow;
  parent: { identifier: string | null; title: string } | null;
  comments: Array<{ author: string; body: string }>;
  children: TaskChildSummary[];
}

/** Mutable, per-run task state shared by the tools of one agent run. */
export { newTaskRunState, type TaskRunState } from "./task-run-state.js";
import type { TaskRunState } from "./task-run-state.js";

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+\n/g, "\n");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A short task title from a free-text request (first line, ≤ 100 chars). */
export function titleFromRequest(request: string): string {
  const first = (request ?? "").trim().split("\n")[0]!.trim();
  return clip(first || "Delegated work", 100);
}

/**
 * The request an agent sees when it works a task. Pure — unit-testable.
 * `wakeReason === "issue_children_completed"` turns it into a roll-up.
 */
export function buildTaskRequest(
  ctx: TaskContext,
  opts: { agentTag: string; wakeReason?: string | null; standingInstructions?: string | null },
): string {
  const { issue } = ctx;
  const id = issue.identifier ?? issue.id.slice(0, 8);
  const lines: string[] = [];
  lines.push(`You are working task ${id}: "${issue.title}" (priority ${issue.priority}), assigned to you (${opts.agentTag}).`);
  if (ctx.parent) {
    lines.push(`It is part of ${ctx.parent.identifier ?? "a parent task"}: "${ctx.parent.title}".`);
  }
  if (opts.standingInstructions?.trim()) {
    lines.push("", `Standing instructions for this recurring task: ${opts.standingInstructions.trim()}`);
  }
  if (issue.description?.trim()) {
    lines.push("", "Task brief:", clip(issue.description, 3000));
  }
  if (ctx.comments.length) {
    lines.push("", "Recent comments (newest last):");
    for (const c of ctx.comments) lines.push(`- ${c.author}: ${clip(c.body, 400)}`);
  }
  if (ctx.children.length) {
    lines.push("", "Sub-tasks:");
    for (const ch of ctx.children) {
      lines.push(
        `- ${ch.identifier ?? "task"} (${ch.assigneeTag ?? "unassigned"}, ${ch.status}): ${ch.title}` +
          (ch.lastComment ? ` — ${clip(ch.lastComment, 600)}` : ""),
      );
    }
  }
  if (opts.wakeReason === "issue_children_completed") {
    lines.push(
      "",
      "All sub-tasks are finished. Write the roll-up: what was done, the key results, and the recommended next steps. Do not delegate again.",
    );
  }
  return lines.join("\n");
}

/** The comment a finished run leaves on its task. Pure. */
export function buildTaskResultComment(input: {
  agentTag: string;
  resultText: string;
  outputs: Array<{ title: string; status: string; gated: boolean }>;
  delegated: Array<{ identifier: string | null; toTag: string }>;
}): string {
  const parts: string[] = [];
  const text = clip(input.resultText || "", 1500);
  if (text) parts.push(text);
  if (input.outputs.length) {
    parts.push(
      [
        "**Outputs**",
        ...input.outputs.map((o) =>
          `- ${o.title} — ${o.gated ? "waiting for approval in the Queue" : o.status}`,
        ),
      ].join("\n"),
    );
  }
  if (input.delegated.length) {
    parts.push(
      [
        "**Delegated**",
        ...input.delegated.map((d) => `- ${d.identifier ?? "sub-task"} → ${d.toTag}`),
      ].join("\n"),
    );
  }
  return `${parts.join("\n\n")}\n\n— ${input.agentTag}`;
}

/** Which status a task lands in after its agent's run. Pure. */
export function nextTaskStatus(input: {
  runStatus: string;
  anyGated: boolean;
  delegatedThisRun: number;
  openChildren: number;
}): "done" | "in_review" | "blocked" | null {
  if (input.runStatus === "failed") return null; // leave it to core recovery
  if (input.delegatedThisRun > 0 || input.openChildren > 0) return "blocked";
  if (input.anyGated) return "in_review";
  return "done";
}

export function taskService(db: Db) {
  const svc = issueService(db);

  async function heartbeat() {
    const { heartbeatService } = await import("../services/heartbeat.js");
    return heartbeatService(db);
  }

  async function tagByAgentId(companyId: string, agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const [row] = await db
      .select({ tag: tethrAgentProfiles.tag })
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.agentId, agentId)))
      .limit(1);
    if (row) return row.tag;
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
    return a?.name ?? null;
  }

  async function load(issueId: string): Promise<TaskContext | null> {
    const issue = await svc.getById(issueId);
    if (!issue) return null;
    const companyId = issue.companyId;

    let parent: TaskContext["parent"] = null;
    if (issue.parentId) {
      const p = await svc.getById(issue.parentId);
      if (p) parent = { identifier: p.identifier ?? null, title: p.title };
    }

    const rawComments = (await svc.listComments(issue.id, { order: "desc", limit: 6 })) as Array<{
      body: string;
      authorAgentId: string | null;
      authorUserId: string | null;
    }>;
    const comments: TaskContext["comments"] = [];
    for (const c of rawComments.reverse()) {
      const author = c.authorAgentId
        ? ((await tagByAgentId(companyId, c.authorAgentId)) ?? "agent")
        : c.authorUserId
          ? "human"
          : "system";
      comments.push({ author, body: c.body });
    }

    const childRows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, issue.id)))
      .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
    const children: TaskChildSummary[] = [];
    for (const ch of childRows) {
      const [last] = (await svc.listComments(ch.id, { order: "desc", limit: 1 })) as Array<{ body: string }>;
      children.push({
        identifier: ch.identifier ?? null,
        title: ch.title,
        status: ch.status,
        assigneeTag: await tagByAgentId(companyId, ch.assigneeAgentId),
        lastComment: last?.body ?? null,
      });
    }
    return { issue, parent, comments, children };
  }

  /** Claim the task for this run (sets in_progress + the execution lock). */
  async function start(issueId: string, agentId: string, runId: string | null): Promise<boolean> {
    try {
      const claimed = await svc.checkout(issueId, agentId, ["todo", "in_progress", "blocked", "in_review"], runId);
      return Boolean(claimed);
    } catch (err) {
      // Usually benign: the task was closed or claimed by another run between
      // the wake and this run. The run is skipped; nothing is changed.
      logger.info(
        { issueId, reason: err instanceof Error ? err.message : String(err) },
        "tethr task: checkout refused — run skipped",
      );
      return false;
    }
  }

  async function wakeParentIfChildrenDone(child: IssueRow, actorAgentId: string | null) {
    if (!child.parentId) return;
    const parent = await svc.getWakeableParentAfterChildCompletion(child.parentId);
    if (!parent) return;
    const hb = await heartbeat();
    await hb
      .wakeup(parent.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_children_completed",
        payload: {
          issueId: parent.id,
          completedChildIssueId: child.id,
          childIssueIds: parent.childIssueIds,
        },
        requestedByActorType: actorAgentId ? "agent" : "system",
        requestedByActorId: actorAgentId,
        contextSnapshot: {
          issueId: parent.id,
          taskId: parent.id,
          wakeReason: "issue_children_completed",
          source: "issue.children_completed",
          completedChildIssueId: child.id,
        },
      })
      .catch((err) => logger.warn({ err, issueId: parent.id }, "tethr task: failed to wake parent owner"));
  }

  /** Set a task's status (and wake the parent owner when it becomes terminal). */
  async function setStatus(
    issueId: string,
    status: "done" | "in_review" | "blocked" | "cancelled" | "todo",
    actor: { agentId?: string | null; userId?: string | null } = {},
  ): Promise<IssueRow | null> {
    const before = await svc.getById(issueId);
    if (!before || before.status === status) return before ?? null;
    const updated = (await svc.update(issueId, {
      status,
      actorAgentId: actor.agentId ?? null,
      actorUserId: actor.userId ?? null,
    })) as IssueRow | null;
    if (!updated) return null;
    await logActivity(db, {
      companyId: updated.companyId,
      actorType: actor.agentId ? "agent" : actor.userId ? "user" : "system",
      actorId: actor.agentId ?? actor.userId ?? "tethr",
      agentId: actor.agentId ?? null,
      action: "issue.updated",
      entityType: "issue",
      entityId: updated.id,
      details: { identifier: updated.identifier, status, previousStatus: before.status, source: "tethr" },
    });
    const terminal = (s: string) => s === "done" || s === "cancelled";
    if (!terminal(before.status) && terminal(status)) {
      await wakeParentIfChildrenDone(updated, actor.agentId ?? null);
    }
    return updated;
  }

  async function comment(issueId: string, body: string, actor: { agentId?: string; userId?: string; runId?: string | null }) {
    try {
      await svc.addComment(issueId, body, actor);
    } catch (err) {
      logger.warn({ err, issueId }, "tethr task: failed to add comment");
    }
  }

  /** After an agent's run on a task: comment the result and move the task. */
  async function finish(input: {
    issueId: string;
    agentId: string;
    agentTag: string;
    runId: string | null;
    run: {
      status: string;
      resultText: string;
      outputs: Array<{ outputId: string; title: string; status: string; gated: boolean }>;
    };
    delegated: TaskRunState["delegated"];
  }): Promise<string | null> {
    const ctx = await load(input.issueId);
    if (!ctx) return null;
    await comment(
      input.issueId,
      buildTaskResultComment({
        agentTag: input.agentTag,
        resultText: input.run.resultText,
        outputs: input.run.outputs,
        delegated: input.delegated,
      }),
      { agentId: input.agentId, runId: input.runId },
    );
    const openChildren = ctx.children.filter((c) => c.status !== "done" && c.status !== "cancelled").length;
    const next = nextTaskStatus({
      runStatus: input.run.status,
      anyGated: input.run.outputs.some((o) => o.gated),
      delegatedThisRun: input.delegated.length,
      openChildren,
    });
    if (next) await setStatus(input.issueId, next, { agentId: input.agentId });
    return next;
  }

  /** Resolve a target agent tag in this company (Tethr agents only). */
  async function resolveTarget(companyId: string, rawTag: string) {
    const tag = rawTag.trim().startsWith("@") ? rawTag.trim() : `@${rawTag.trim()}`;
    const base = tag.split(".")[0]!.toLowerCase();
    const [row] = await db
      .select({ agentId: tethrAgentProfiles.agentId, tag: tethrAgentProfiles.tag, status: agents.status })
      .from(tethrAgentProfiles)
      .innerJoin(agents, eq(agents.id, tethrAgentProfiles.agentId))
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, base)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Delegate a piece of work to another agent as a child task. With no task in
   * hand (a Console/Slack run), a root task owned by the delegating agent is
   * created first so the roll-up has a home. Enforces TASK_LIMITS.
   */
  async function delegate(input: {
    companyId: string;
    fromAgentId: string;
    fromTag: string;
    state: TaskRunState;
    toTag: string;
    title: string;
    brief: string;
    priority?: string | null;
    runId?: string | null;
  }): Promise<{ ok: true; issueId: string; identifier: string | null; toTag: string } | { ok: false; error: string }> {
    if (!input.state.allowDelegation) {
      return { ok: false, error: "Delegation is off for this run (roll-ups don't delegate again)." };
    }
    const target = await resolveTarget(input.companyId, input.toTag);
    if (!target) return { ok: false, error: `No agent ${input.toTag} in this company.` };
    if (target.agentId === input.fromAgentId) {
      return { ok: false, error: "You can't delegate to yourself — do the work directly." };
    }
    if (target.status === "paused" || target.status === "terminated" || target.status === "pending_approval") {
      return { ok: false, error: `${target.tag} is ${target.status} and can't take work right now.` };
    }
    const title = clip(input.title || "", 120);
    if (!title) return { ok: false, error: "Give the sub-task a short title." };
    const priority = ["critical", "high", "medium", "low"].includes(String(input.priority))
      ? String(input.priority)
      : "medium";

    // The parent: the task in hand, or a root task created on the fly.
    let parentId = input.state.issueId;
    if (!parentId) {
      const root = await svc.create(input.companyId, {
        title: titleFromRequest(input.state.requestText ?? input.title),
        description: input.state.requestText ?? null,
        status: "blocked",
        priority,
        assigneeAgentId: input.fromAgentId,
        createdByAgentId: input.fromAgentId,
        originKind: "manual",
        originId: TETHR_DELEGATION_ORIGIN,
      });
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.fromAgentId,
        agentId: input.fromAgentId,
        action: "issue.created",
        entityType: "issue",
        entityId: root.id,
        details: { identifier: root.identifier, title: root.title, source: "tethr.delegation" },
      });
      parentId = root.id;
      input.state.issueId = root.id;
    }

    const parent = await svc.getById(parentId);
    if (!parent) return { ok: false, error: "The parent task no longer exists." };
    const depth = (parent.requestDepth ?? 0) + 1;
    if (depth > TASK_LIMITS.maxDepth) {
      return { ok: false, error: `That would nest deeper than ${TASK_LIMITS.maxDepth} levels — do this part yourself.` };
    }
    const siblings = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, parentId)));
    if (siblings.length >= TASK_LIMITS.maxChildren) {
      return { ok: false, error: `This task already has ${TASK_LIMITS.maxChildren} sub-tasks — that's the limit.` };
    }

    const { issue: child } = await svc.createChild(parentId, {
      title,
      description: input.brief?.trim() || null,
      status: "todo",
      priority,
      assigneeAgentId: target.agentId,
      createdByAgentId: input.fromAgentId,
      actorAgentId: input.fromAgentId,
      requestDepth: depth,
      originKind: "manual",
      originId: TETHR_DELEGATION_ORIGIN,
    });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.fromAgentId,
      agentId: input.fromAgentId,
      action: "issue.child_created",
      entityType: "issue",
      entityId: child.id,
      details: {
        parentId,
        identifier: child.identifier,
        title: child.title,
        assignee: target.tag,
        source: "tethr.delegation",
      },
    });
    input.state.delegated.push({ issueId: child.id, identifier: child.identifier ?? null, toTag: target.tag });
    void queueIssueAssignmentWakeup({
      heartbeat: await heartbeat(),
      issue: child,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "tethr.delegation",
      requestedByActorType: "agent",
      requestedByActorId: input.fromAgentId,
    });
    return { ok: true, issueId: child.id, identifier: child.identifier ?? null, toTag: target.tag };
  }

  /**
   * The Queue closes the loop: a decision on an output that belongs to a task
   * moves that task. approve → done (wakes the parent owner if it was the
   * last open child); reject → cancelled; request changes → stays in review
   * with the note (the revision run produces the next version).
   */
  async function onOutputDecided(input: {
    output: { id: string; title: string; meta: unknown };
    decision: "approve" | "reject" | "request_changes";
    reviewer: string;
    note?: string | null;
  }): Promise<void> {
    const meta = (input.output.meta ?? {}) as Record<string, unknown>;
    const issueId = typeof meta.taskIssueId === "string" ? meta.taskIssueId : null;
    if (!issueId) return;
    const issue = await svc.getById(issueId);
    if (!issue) return;
    const note = input.note?.trim() ? ` Note: ${input.note.trim()}` : "";
    if (input.decision === "approve") {
      await comment(issueId, `Approved "${input.output.title}" (${input.reviewer}).${note}`, {});
      // Only close if nothing else from this task is still waiting.
      if (issue.status === "in_review") await setStatus(issueId, "done", {});
    } else if (input.decision === "reject") {
      await comment(issueId, `Rejected "${input.output.title}" (${input.reviewer}).${note}`, {});
      if (issue.status === "in_review") await setStatus(issueId, "cancelled", {});
    } else {
      await comment(issueId, `Changes requested on "${input.output.title}" (${input.reviewer}).${note}`, {});
    }
  }

  return { load, start, finish, delegate, setStatus, comment, onOutputDecided, resolveTarget };
}

export type TaskService = ReturnType<typeof taskService>;
