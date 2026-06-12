import { driveService } from "../drive.js";
import { memoryService } from "../memory.js";
import { notificationService } from "../notify.js";
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
    });
    return { output: "Notification sent.", summary: `notified: ${String(input.title ?? "").slice(0, 60)}` };
  },
};
