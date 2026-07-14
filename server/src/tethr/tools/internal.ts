import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { tethrRouteRuns } from "@paperclipai/db";
import { driveService } from "../drive.js";
import { memoryService } from "../memory.js";
import { notificationService } from "../notify.js";
import { validateOrgChange, ORG_CHANGE_OPS } from "../org-changes.js";
import type { TethrTool } from "./types.js";

// Internal tools: the Drive, memory, and notifications. Drive writes are
// restricted to working paths (/state, /scratch) — publishing real output goes
// through the gating service only, so the hard gates cannot be bypassed by a
// tool call.

const WRITABLE_PREFIXES = ["/state/", "/scratch/"];

export const driveListTool: TethrTool = {
  name: "drive_list",
  description: "List files and folders at a Drive path (e.g. /state, /content/blog).",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Folder path, default /" } },
    required: [],
  },
  async execute(ctx, input) {
    const drive = driveService(ctx.db);
    const path = String(input.path ?? "/");
    const node = path === "/" ? null : await drive.findNodeByPath(ctx.companyId, path);
    if (path !== "/" && !node) {
      return { output: `No such folder: ${path}`, summary: `list ${path}: missing` };
    }
    const children = await drive.listChildren(ctx.companyId, node?.id ?? null);
    const lines = children.map(
      (c) => `${c.kind === "folder" ? "dir " : "file"} ${c.path}${c.kind === "file" ? ` (${c.byteSize ?? 0}B, tags: ${c.tags.join(",") || "none"})` : ""}`,
    );
    return {
      output: lines.length ? lines.join("\n") : "(empty)",
      summary: `list ${path}: ${children.length} entries`,
    };
  },
};

export const driveReadTool: TethrTool = {
  name: "drive_read",
  description: "Read the current version of a Drive file by path.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "File path, e.g. /state/content-calendar.json" } },
    required: ["path"],
  },
  async execute(ctx, input) {
    const drive = driveService(ctx.db);
    const path = String(input.path ?? "");
    const node = await drive.findNodeByPath(ctx.companyId, path);
    if (!node || node.kind !== "file") {
      return { output: `No such file: ${path}`, summary: `read ${path}: missing` };
    }
    const read = await drive.readCurrent(ctx.companyId, node.id);
    if (!read) return { output: `Empty file: ${path}`, summary: `read ${path}: empty` };
    const text = read.content.toString("utf8").slice(0, 8000);
    return { output: text, summary: `read ${path} (${text.length} chars)` };
  },
};

export const driveWriteTool: TethrTool = {
  name: "drive_write",
  description:
    "Write a working file to the Drive (new version if it exists). Only /state/ and /scratch/ paths are writable — final outputs go through the approval gate, not this tool.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path under /state/ or /scratch/" },
      content: { type: "string" },
      note: { type: "string", description: "Short version note" },
    },
    required: ["path", "content"],
  },
  async execute(ctx, input) {
    const path = String(input.path ?? "");
    if (!WRITABLE_PREFIXES.some((p) => path.startsWith(p))) {
      return {
        output: `Refused: ${path} is outside the writable working areas (${WRITABLE_PREFIXES.join(", ")}). Final outputs must go through the approval gate.`,
        summary: `write ${path}: refused (outside working areas)`,
      };
    }
    const drive = driveService(ctx.db);
    const { version } = await drive.putFile({
      companyId: ctx.companyId,
      path,
      content: String(input.content ?? ""),
      note: input.note ? String(input.note) : `by ${ctx.subagentTag}`,
      createdByTag: ctx.subagentTag,
      tags: ["working"],
    });
    return {
      output: `Saved ${path} (v${version.versionNumber}).`,
      summary: `wrote ${path} v${version.versionNumber}`,
    };
  },
};

export const recallMemoryTool: TethrTool = {
  name: "recall_memory",
  description:
    "Search the company + this agent's memory (rules, facts, history) for relevant entries.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Keyword(s) to search for" } },
    required: [],
  },
  async execute(ctx, input) {
    const memory = memoryService(ctx.db);
    const results = await memory.recall(
      ctx.companyId,
      ctx.agentId,
      input.query ? String(input.query) : undefined,
      8,
    );
    const lines = results.map((m) => `- [${m.kind}] ${m.content}`);
    return {
      output: lines.length ? lines.join("\n") : "No matching memories.",
      summary: `recalled ${results.length} memories`,
    };
  },
};

export const escalateTool: TethrTool = {
  name: "escalate",
  description:
    "Raise a question or blocker to your human overseer when you genuinely cannot resolve it yourself — a decision only a human can make, or information you don't have. The overseer is tagged directly in the conversation thread. Use sparingly: answer or draft a plan when you can; escalate only when a human is truly needed.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The specific question or decision the overseer needs to weigh in on.",
      },
      urgency: { type: "string", enum: ["low", "normal", "high"], description: "Default normal." },
    },
    required: ["question"],
    additionalProperties: false,
  },
  // The escalation is carried by this tool-call record; the worker detects it and
  // the Slack layer tags the overseer in the originating thread. Nothing is
  // published or sent from here.
  async execute(_ctx, input) {
    const question = String(input.question ?? "").trim();
    if (!question) {
      return { output: "Provide the question to escalate.", summary: "escalate: (empty, ignored)" };
    }
    return {
      output: `Escalation noted — your overseer will be tagged in this thread with: "${question.slice(0, 200)}". Continue with what you can do meanwhile.`,
      summary: `escalated: ${question.slice(0, 80)}`,
    };
  },
};

export const stageOrgChangeTool: TethrTool = {
  name: "stage_org_change",
  description:
    "Stage a modification to an existing agent — rename, title/mission edit, budget change, subagent spec edit, pause/resume, or schedule change. NOTHING is applied by this call: the change is validated, then waits as a gated item for a human to approve in the Queue. Applied changes are logged and revertible. Stage exactly what was asked — never invent changes.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: [...ORG_CHANGE_OPS],
        description:
          "rename | update_profile (title/mission) | update_budget | update_subagent (job/steps/guardrails/routeWhen) | set_status (pause/resume) | set_schedule (cron/enable)",
      },
      targetTag: { type: "string", description: 'The agent to change, e.g. "@radar".' },
      newCodename: { type: "string", description: "rename: the new name, e.g. Scout." },
      title: { type: "string" },
      mission: { type: "string" },
      budgetMonthlyCents: { type: "number", description: "update_budget: new monthly cap in cents." },
      subagentTag: { type: "string", description: 'update_subagent: e.g. "@radar.scan".' },
      job: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
      guardrails: { type: "array", items: { type: "string" } },
      routeWhen: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["active", "paused"] },
      reason: { type: "string" },
      cron: { type: "string", description: "set_schedule: 5-field cron expression." },
      scheduleEnabled: { type: "boolean" },
    },
    required: ["op", "targetTag"],
  },
  // Validation only — the worker turns the staged spec into a gated org_change
  // output; applying happens exclusively in gating.decide on human approval.
  async execute(ctx, input) {
    const result = await validateOrgChange(ctx.db, ctx.companyId, input);
    if (!result.ok) {
      return {
        output: `Cannot stage that change: ${result.errors.join("; ")}. Tell the requester exactly what's wrong.`,
        summary: `stage refused: ${result.errors[0]}`,
      };
    }
    return {
      output: `Change staged for ${result.target!.codename} (${result.target!.tag}) — op ${result.spec!.op}. It is NOT applied yet: it now waits for a human to approve it in the Queue. Tell the requester that, briefly.`,
      summary: `staged ${result.spec!.op} on ${result.target!.tag}`,
    };
  },
};

export const readFailuresTool: TethrTool = {
  name: "read_failures",
  description:
    "Read this company's recent FAILED or errored requests (the debug log). Returns each failure's request, the exact error message, and the step-by-step trace of what the agent did before it broke. Read-only — use it to diagnose what went wrong and recommend a fix.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Optional keyword to filter by (matched against the error message and the request). Omit to see the most recent failures.",
      },
      limit: { type: "number", description: "How many to return (default 5, max 20)." },
    },
    required: [],
  },
  async execute(ctx, input) {
    const limit = Math.min(Math.max(Number(input.limit ?? 5) || 5, 1), 20);
    const rows = await ctx.db
      .select({
        createdAt: tethrRouteRuns.createdAt,
        status: tethrRouteRuns.status,
        request: tethrRouteRuns.requestText,
        error: tethrRouteRuns.error,
        provider: tethrRouteRuns.llmProvider,
        hops: tethrRouteRuns.hops,
      })
      .from(tethrRouteRuns)
      .where(
        and(
          eq(tethrRouteRuns.companyId, ctx.companyId),
          or(eq(tethrRouteRuns.status, "failed"), isNotNull(tethrRouteRuns.error)),
        ),
      )
      .orderBy(desc(tethrRouteRuns.createdAt))
      .limit(50);

    const q = input.query ? String(input.query).toLowerCase() : "";
    const matched = (q
      ? rows.filter(
          (r) =>
            (r.error ?? "").toLowerCase().includes(q) ||
            (r.request ?? "").toLowerCase().includes(q),
        )
      : rows
    ).slice(0, limit);

    if (!matched.length) {
      return {
        output: q ? `No recent failures match "${q}".` : "No recent failures on record — nothing is broken.",
        summary: `read_failures: 0 (${q || "recent"})`,
      };
    }

    const blocks = matched.map((r, i) => {
      const when = r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt);
      const trace = Array.isArray(r.hops)
        ? (r.hops as unknown as Array<Record<string, unknown>>)
            .slice(-6)
            .map((h) => `    - [${h.layer}] ${h.actorTag ?? ""} ${h.decision ?? ""}${h.reason ? `: ${String(h.reason).slice(0, 100)}` : ""}`)
            .join("\n")
        : "    (no trace)";
      return [
        `${i + 1}. ${when} · status=${r.status} · provider=${r.provider ?? "?"}`,
        `   request: ${(r.request ?? "").slice(0, 200)}`,
        `   error:   ${(r.error ?? "(none)").slice(0, 500)}`,
        `   last steps:\n${trace}`,
      ].join("\n");
    });
    return {
      output: `${matched.length} recent failure(s):\n\n${blocks.join("\n\n")}`,
      summary: `read_failures: ${matched.length} (${q || "recent"})`,
    };
  },
};

export const proposeAgentTool: TethrTool = {
  name: "propose_agent",
  description:
    "Propose ONE new agent for a capability the organization is missing. Describe the role/job in the brief; a full agent spec is drafted and staged for human approval (or auto-applied if you're on auto). The new agent is always created PAUSED, reporting to the CEO. Use sparingly — never propose a duplicate of an existing agent, and only when the org genuinely lacks a needed capability.",
  inputSchema: {
    type: "object",
    properties: {
      brief: {
        type: "string",
        description:
          "What the agent is for — the capability/role and why the org needs it (e.g. 'an engineering agent that owns applying the bug fixes Patch diagnoses').",
      },
    },
    required: ["brief"],
  },
  // Side-effect tool (like notify): it stages a gated agent_proposal directly.
  async execute(ctx, input) {
    const brief = String(input.brief ?? "").trim();
    if (!brief) {
      return { output: "Provide a brief describing the agent to propose.", summary: "propose_agent: (empty)" };
    }
    try {
      const { proposeAgent } = await import("../proposals.js");
      const { spec } = await proposeAgent(ctx.db, ctx.companyId, { brief, autonomous: true });
      return {
        output: `Proposed a new agent: ${spec.codename} (${spec.role}). It is staged for human approval and, once approved, is created PAUSED reporting to the CEO. Mention this to the requester briefly.`,
        summary: `proposed agent: ${spec.codename}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: `Could not propose that agent: ${msg}. (It may duplicate an existing agent, or the spec was unbuildable.) Do not retry blindly — refine the brief.`,
        summary: `propose_agent failed: ${msg.slice(0, 60)}`,
      };
    }
  },
};

export const notifyTool: TethrTool = {
  name: "notify",
  description:
    "Send an in-app notification to the operator (also fans out to the mock Slack/SMS/email channels).",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["title"],
  },
  async execute(ctx, input) {
    const notify = notificationService(ctx.db);
    await notify.send({
      companyId: ctx.companyId,
      kind: "system",
      title: String(input.title ?? ""),
      body: input.body ? String(input.body) : undefined,
      agentTag: ctx.subagentTag,
      // An agent deliberately notifying the operator — this one reaches #scout.
      slackBroadcast: true,
    });
    return { output: "Notification sent.", summary: `notified: ${String(input.title ?? "").slice(0, 60)}` };
  },
};
