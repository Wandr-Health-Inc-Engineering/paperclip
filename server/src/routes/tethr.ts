import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  budgetPolicies,
  costEvents,
  heartbeatRuns,
  routineTriggers,
  routines,
  tethrOutputs,
  tethrRouteRuns,
  tethrSubagents,
} from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/activity-log.js";
import {
  getTethrLLMProvider,
  getTethrLlmBackend,
  getTethrLlmMode,
  setTethrLlmMode,
  tethrLiveKeyPresent,
} from "../tethr/llm/index.js";
import {
  NoCeoError,
  ProposalRejectedError,
  proposeAgent,
} from "../tethr/proposals.js";
import { driveService } from "../tethr/drive.js";
import { gatingService } from "../tethr/gating.js";
import { memoryService } from "../tethr/memory.js";
import { notificationService } from "../tethr/notify.js";
import { orgService } from "../tethr/org.js";
import { routingService } from "../tethr/routing.js";
import * as chats from "../tethr/chats.js";
import { getAssistantRunner } from "../tethr/assistant/runner.js";
import { resolveHookToken } from "../tethr/assistant/gate.js";
import { readableRoots, workspaceDir } from "../tethr/assistant/workspace.js";
import { memoryToolRefusal } from "../tethr/assistant/memory-tools.js";
import { memoryBackend } from "../tethr/hermes/memory-layer.js";
import { handlePostToolUse, handlePreToolUse } from "../tethr/assistant/hook-handler.js";
import { runTethrTool, TETHR_TOOL_DEFS, TETHR_TOOLS_LABEL, TETHR_TOOLS_SERVER } from "../tethr/assistant/tethr-tools.js";
import { classify, decide } from "../tethr/assistant/policy.js";
import { AGENT_ALWAYS_TOOLS, agentToolRefusal, TEAM_TOOL_NAMES, TeamInputError } from "../tethr/team-spec.js";
import { answerQuestion, answerText, closeQuestionsAnsweredInChat, getQuestion, QuestionInputError, questionsByRun } from "../tethr/assistant/questions.js";
import { settleConnectionCard, stillMissing } from "../tethr/team-needs.js";
import { connectionCardsOnCreationTurns, needsYouOnReportCards } from "../tethr/needs-you.js";
import { teamService } from "../tethr/team.js";
import {
  ATTACH_LIMITS,
  attachmentKind,
  panelPathFor,
  saveAttachment,
  splitAttachments,
  validateAttachments,
  withAttachments,
} from "../tethr/assistant/attachments.js";
import { jevHealth, jevHealthText } from "../tethr/jev.js";
import * as envFile from "../tethr/env-file.js";
import { planReset, resetAllowed, runReset } from "../tethr/reset.js";
import { seedTethrCore } from "../tethr/seed/tethr-core.js";
import { logFailure } from "../tethr/best-effort.js";
import { mirrorDir } from "../tethr/mirror.js";
import multer from "multer";
import { getIntegrations, KNOWN_CONNECTORS, modeFor, sanitizeIntegrationsPatch, updateIntegrations } from "../tethr/integrations.js";
import {
  interpretSlackEvent,
  routeInboundKickoff,
  slackConfigured,
  verifySlackSignature,
} from "../tethr/slack.js";
import { workerService } from "../tethr/worker.js";
import { toolsetForSubagent } from "../tethr/tools/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { isInstanceAdmin, requirePerson } from "./tethr-people.js";
import { tethrSetupRoutes } from "./tethr-setup.js";
import { tethrTeamRoutes } from "./tethr-team.js";
import { tethrMemoryRoutes } from "./tethr-memory.js";
import { tethrGrowthMapRoutes } from "./tethr-growth-map.js";
import { tethrDecisionRoutes } from "./tethr-decisions.js";
import { tethrInboxRoutes } from "./tethr-inbox.js";
import { tethrLearningRoutes } from "./tethr-learning.js";
import { SANDBOX_TOOLS } from "../tethr/assistant/learn-tools.js";
import { sandboxRefusal } from "../tethr/assistant/sandbox.js";
import { sandboxDir, sealedThreadTag } from "../tethr/learn/learner.js";

const execFileAsync = promisify(execFile);
let cachedSha: string | null = null;
async function getPaperclipSha(): Promise<string> {
  if (cachedSha) return cachedSha;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      timeout: 3000,
    });
    cachedSha = stdout.trim();
  } catch {
    cachedSha = "unknown";
  }
  return cachedSha;
}

/** A chat (thread) id: always a uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tethrRoutes(db: Db) {
  const router = Router();
  const org = orgService(db);
  const routing = routingService(db);
  const gating = gatingService(db);
  const drive = driveService(db);
  const memory = memoryService(db);
  const notify = notificationService(db);
  const worker = workerService(db);


  // ---- Chat approval gate (phase 18) ----------------------------------------
  // Called by the hook script Claude Code runs before/after every tool call in
  // a chat turn. Authenticated by the per-turn token (not a browser session),
  // like the Slack webhook below. Pre decides allow/deny; it fails closed.
  router.post("/tethr/hooks/:phase", async (req, res) => {
    const phase = req.params.phase === "post" ? "post" : "pre";
    const auth = String(req.headers.authorization ?? "");
    const ctx = resolveHookToken(auth.startsWith("Bearer ") ? auth.slice(7) : null);
    if (!ctx) {
      res.status(401).json(
        phase === "pre"
          ? { exitCode: 2, stderr: "Tethr approval gate: this chat turn is no longer authorized, so the action was blocked." }
          : { exitCode: 0 },
      );
      return;
    }
    try {
      const payload = (req.body ?? {}) as Record<string, unknown>;
      res.json(phase === "pre" ? await handlePreToolUse(db, ctx, payload) : await handlePostToolUse(db, ctx, payload));
    } catch (err) {
      logger.warn({ err }, "tethr approval gate failed");
      res.json(phase === "pre" ? { exitCode: 2, stderr: "Tethr approval gate: something went wrong, so the action was blocked." } : { exitCode: 0 });
    }
  });

  // Tethr's own tools for the chat (phase 19): the "tethr" MCP bridge script the
  // chat's Claude session runs forwards tools/list and tools/call here, with the
  // turn's hook token. Every call has already passed the PreToolUse gate.
  router.post("/tethr/assistant/tools/:op", async (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const ctx = resolveHookToken(auth.startsWith("Bearer ") ? auth.slice(7) : null);
    if (!ctx) {
      res.status(401).json({ error: "This chat turn is no longer authorized." });
      return;
    }
    // Phase 23: an agent's thread gets Tethr's tools minus tethr's team tools.
    // Whose chat this is decides what's allowed: if that can't be looked up, nothing runs.
    let member: Awaited<ReturnType<ReturnType<typeof teamService>["byThread"]>>;
    try {
      member = await teamService(db).byThread(ctx.companyId, ctx.threadId);
    } catch {
      res.status(503).json({ error: "Tethr couldn't check whose chat this is. Try again." });
      return;
    }
    // Phase 26.6: the learner's chat with no agent behind it gets no tools.
    if (!member && sealedThreadTag(ctx.companyId, ctx.threadId)) {
      res.status(403).json({ error: "The learner isn't on the team any more." });
      return;
    }
    // A one-off private turn (the idea check) reads other people's Slack words, so
    // it only gets tools that look things up: nothing that saves, assigns or creates.
    const readOnly = (toolName: string) =>
      classify(`mcp__${TETHR_TOOLS_SERVER}__${toolName}`, {}, { workspaceDir: workspaceDir().dir, readableRoots: readableRoots(), internalAddresses: [] }).cls === "read";
    if (req.params.op === "list") {
      const isTeamTool = (name: string) => (TEAM_TOOL_NAMES as readonly string[]).includes(name);
      // tethr: everything. A lead: its team tools, plus the rest if it has "Tethr tools". Any other agent: no team tools.
      // Memory tools only where they work (phase 25: Hermes-only ones, never in a private turn).
      const backend = memoryBackend(ctx.companyId);
      const tools = (
        !member
          ? TETHR_TOOL_DEFS
          : member.sandbox
            ? TETHR_TOOL_DEFS.filter((d) => SANDBOX_TOOLS.has(d.name))
            : TETHR_TOOL_DEFS.filter((d) =>
                isTeamTool(d.name) ? member.lead : (AGENT_ALWAYS_TOOLS as readonly string[]).includes(d.name) || member.connectors.includes(TETHR_TOOLS_LABEL),
              )
      )
        .filter((d) => !memoryToolRefusal(d.name, { private: ctx.privateTurn === true, member }, backend))
        .filter((d) => ctx.privateTurn !== true || readOnly(d.name));
      res.json({ tools });
      return;
    }
    if (req.params.op !== "call") {
      res.status(404).json({ error: "Unknown tools operation." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "");
    // The same decision the PreToolUse gate makes (Off denies everything, Read
    // denies the goal-saving tools), enforced here too: this is where the work
    // happens, whoever holds the turn's token.
    const cfg = getIntegrations(ctx.companyId);
    const args = body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
    const classified = classify(`mcp__${TETHR_TOOLS_SERVER}__${name}`, args, {
      workspaceDir: workspaceDir().dir,
      readableRoots: readableRoots(),
      internalAddresses: cfg.internalAddresses,
    });
    const decision = decide(classified, { mode: modeFor(cfg, TETHR_TOOLS_LABEL), shell: cfg.shell });
    const refusal =
      (member?.sandbox ? sandboxRefusal(member.tag, `mcp__${TETHR_TOOLS_SERVER}__${name}`) : null) ??
      (member ? agentToolRefusal(member, `mcp__${TETHR_TOOLS_SERVER}__${name}`, TETHR_TOOLS_LABEL) : null) ??
      (ctx.privateTurn === true && classified.cls !== "read" ? `Tethr approval gate: blocked. ${name} isn't available in this one-off check.` : null);
    if (decision.action !== "allow" || refusal) {
      const text = refusal ?? (decision.action === "deny" ? decision.reason : `Tethr approval gate: ${name} can't run from here.`);
      res.json({ content: [{ type: "text", text }], isError: true });
      return;
    }
    const result = await runTethrTool(name, body.arguments, {
      workspaceDir: member?.sandbox ? sandboxDir(member.tag) : workspaceDir().dir,
      db,
      companyId: ctx.companyId,
      threadId: ctx.threadId,
      runId: ctx.runId,
      privateTurn: ctx.privateTurn === true,
    });
    await logActivity(db, {
      companyId: ctx.companyId,
      actorType: "agent",
      actorId: member?.tag ?? "@tethr",
      action: "tethr_tool_used",
      entityType: "tethr_route_run",
      entityId: ctx.runId,
      details: { tool: name, ok: result.isError !== true, file: result.file ?? null, ...(result.meta ?? {}) },
    }).catch(() => {});
    res.json({ content: [{ type: "text", text: result.text }], isError: result.isError === true });
  });

  // ---- Slack inbound events (Phase 2) -------------------------------------
  // Public webhook — authenticated by Slack's request signature, not a
  // Paperclip session (so it is deliberately NOT behind assertCompanyAccess).
  // `../scout` was absent at build time, so this is a fresh intake surface on
  // the notify seam: a tagged link/photo becomes a routed Helm task.
  router.post("/tethr/slack/events", async (req, res) => {
    const rawBody =
      (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8") ??
      JSON.stringify(req.body ?? {});
    const verified = verifySlackSignature({
      timestamp: req.header("x-slack-request-timestamp"),
      signature: req.header("x-slack-signature"),
      rawBody,
    });
    if (!verified) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    const interp = interpretSlackEvent(req.body);
    if (interp.type === "challenge") {
      res.json({ challenge: interp.challenge });
      return;
    }
    // Ack within Slack's 3s window; route asynchronously (shared with Socket Mode).
    res.status(200).json({ ok: true });
    // Phase 21: the watcher hears channel conversations tethr is in (memory only).
    void import("../tethr/watch.js").then((w) => w.hearSlackEvent(req.body)).catch(logFailure("watcher hearing a Slack event"));
    if (interp.type !== "kickoff") return;
    void routeInboundKickoff(db, interp).catch((err) =>
      logger.warn({ err }, "tethr slack inbound routing failed"),
    );
  });

  // ---- Company overview (org view) ----------------------------------------
  // Phase 16: the growth board — workflows (on/off) + every agent task by lane.
  router.get("/tethr/:companyId/growth", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { growthBoard } = await import("../tethr/growth.js");
    res.json(await growthBoard(db, companyId));
  });

  router.get("/tethr/:companyId/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [divisions, profiles, subagents] = await Promise.all([
      org.listDivisions(companyId),
      org.listProfiles(companyId),
      org.listSubagents(companyId),
    ]);

    const pendingByAgent = await db
      .select({
        agentId: approvals.requestedByAgentId,
        count: sql<number>`count(*)::int`,
      })
      .from(approvals)
      .where(
        and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")),
      )
      .groupBy(approvals.requestedByAgentId);
    const pendingMap = new Map(
      pendingByAgent.map((r) => [r.agentId ?? "", r.count]),
    );

    const lastRuns = await db
      .select({
        agentId: heartbeatRuns.agentId,
        lastRunAt: sql<string>`max(coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}))`,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .groupBy(heartbeatRuns.agentId);
    const lastRunMap = new Map(lastRuns.map((r) => [r.agentId, r.lastRunAt]));

    res.json({
      divisions,
      agents: profiles.map(({ profile, agent }) => ({
        agent: {
          id: agent.id,
          name: agent.name,
          title: agent.title,
          icon: agent.icon,
          status: agent.status,
          reportsTo: agent.reportsTo,
          budgetMonthlyCents: agent.budgetMonthlyCents,
          spentMonthlyCents: agent.spentMonthlyCents,
          pauseReason: agent.pauseReason,
        },
        profile,
        pendingApprovals: pendingMap.get(agent.id) ?? 0,
        lastRunAt: lastRunMap.get(agent.id) ?? null,
        subagents: subagents
          .filter((s) => s.agentId === agent.id)
          .map((s) => ({
            id: s.id,
            key: s.key,
            tag: s.tag,
            name: s.name,
            job: s.job,
            sensitivity: s.sensitivity,
            lastRunAt: s.lastRunAt,
          })),
      })),
    });
  });

  // ---- Agent detail ---------------------------------------------------------
  router.get("/tethr/:companyId/agents/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;

    const row = await org.getProfileByAgentId(companyId, agentId);
    if (!row) {
      res.status(404).json({ error: "No Tethr profile for this agent" });
      return;
    }
    const [subagents, outputs, runs, policies] = await Promise.all([
      org.listSubagents(companyId, agentId),
      db
        .select()
        .from(tethrOutputs)
        .where(
          and(
            eq(tethrOutputs.companyId, companyId),
            eq(tethrOutputs.agentId, agentId),
          ),
        )
        .orderBy(desc(tethrOutputs.createdAt))
        .limit(12),
      db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.agentId, agentId),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(12),
      db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "agent"),
            eq(budgetPolicies.scopeId, agentId),
          ),
        ),
    ]);

    res.json({
      agent: row.agent,
      profile: row.profile,
      // Resolve each subagent's EFFECTIVE toolset (its "skills") — the DB `tools`
      // grant is null for the hand-built agents, which fall back to the static
      // allowlist, so the raw column reads empty. This surfaces what each one can
      // actually do at run time.
      subagents: subagents.map((s) => ({
        ...s,
        effectiveTools: toolsetForSubagent(s).map((t) => ({
          name: t.name,
          description: t.description,
        })),
      })),
      outputs: outputs.map((o) => ({ ...o, body: o.body.slice(0, 400) })),
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        invocationSource: r.invocationSource,
        triggerDetail: r.triggerDetail,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        summary: (r.resultJson as Record<string, unknown> | null)?.summary ?? null,
      })),
      budgetPolicies: policies,
    });
  });

  // ---- Helm console: route a request ----------------------------------------
  // Returns immediately with the run id; the engine works in the background
  // and the Console polls the run, so hops stream live as they happen.
  router.post("/tethr/:companyId/route", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const requestText = String(req.body?.request ?? "").trim();
    if (!requestText) {
      res.status(400).json({ error: "request is required" });
      return;
    }
    const threadId = req.body?.threadId ? String(req.body.threadId) : null;
    if (threadId && !UUID_RE.test(threadId)) {
      res.status(400).json({ error: "threadId isn't a chat id" });
      return;
    }
    // Phase 26.1: a person (the terminal client, the bell's "ask tethr") reaches
    // the chat brain, the same tethr as the app. A new conversation is a side
    // chat, so it shows in the app too. Agents' API keys keep the classic engine.
    if (actor.actorType === "user" && getIntegrations(companyId).assistant.engine === "session") {
      if (threadId) await closeQuestionsAnsweredInChat(companyId, threadId, actor.actorId);
      const ids = await getAssistantRunner(db).send({ companyId, threadId, text: requestText, requestedByUserId: actor.actorId });
      if (!threadId) await chats.addSideChat(companyId, ids.threadId, requestText);
      res.json(ids);
      return;
    }
    const ids = await new Promise<{ routeRunId: string; threadId: string }>(
      (resolve, reject) => {
        routing
          .routeRequest({
            companyId,
            requestText,
            invocationSource: "console",
            requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
            threadId,
            hopDelayMs: 350,
            onStarted: resolve,
          })
          .catch((err) => {
            logger.warn({ err }, "tethr console route failed");
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      },
    );
    res.json(ids);
  });

  router.get("/tethr/:companyId/route-runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(Number(req.query.limit ?? 30), 100);
    res.json(await routing.listRouteRuns(companyId, limit));
  });

  router.get("/tethr/:companyId/route-runs/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const run = await routing.getRouteRun(companyId, req.params.id as string);
    if (!run) {
      res.status(404).json({ error: "Route run not found" });
      return;
    }
    const outputs = await db
      .select()
      .from(tethrOutputs)
      .where(
        and(
          eq(tethrOutputs.companyId, companyId),
          eq(tethrOutputs.routeRunId, run.id),
        ),
      );
    res.json({ ...run, outputs });
  });

  // ---- Chat (phase 17): one ongoing main chat with @tethr + side chats ----------
  // The main chat's thread id is the company id; side chats are threads the
  // user opened on purpose (listed in the instance-dir tethr-chats.json).

  router.get("/tethr/:companyId/chats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const mainThreadId = chats.mainThreadId(companyId);
    const side = chats.listSideChats(companyId);
    const stats = await routing.threadStats(companyId, [mainThreadId, ...side.map((c) => c.threadId)]);
    const sideChats = side
      .map((c) => ({ ...c, runCount: stats[c.threadId]?.runCount ?? 0, lastAt: stats[c.threadId]?.lastAt ?? c.createdAt }))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
    res.json({
      mainThreadId,
      main: { runCount: stats[mainThreadId]?.runCount ?? 0, lastAt: stats[mainThreadId]?.lastAt ?? null },
      sideChats,
    });
  });

  // Open a side chat with its first message: routes it as a new thread, then
  // lists that thread as a side chat titled from the message.
  // Phase 19.1: a file Mark attaches to a chat message. It's saved in the
  // workspace (files/uploads/<date>/) and the message names it, so Claude reads it.
  const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACH_LIMITS.bytes, files: 1 } });
  router.post("/tethr/:companyId/chats/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    try {
      await new Promise<void>((resolve, reject) => attachmentUpload.single("file")(req, res, (err: unknown) => (err ? reject(err) : resolve())));
    } catch (err) {
      const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? "That file is over 20 MB." : "Couldn't read that upload." });
      return;
    }
    const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "No file was sent." });
      return;
    }
    // Browsers send multipart file names as latin1; restore UTF-8 names.
    const original = Buffer.from(file.originalname, "latin1").toString("utf8");
    const ws = workspaceDir().dir;
    const saved = await saveAttachment(ws, original, file.buffer);
    if ("error" in saved) {
      res.status(422).json({ error: saved.error });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "tethr_chat_attachment",
      entityType: "company",
      entityId: companyId,
      details: { path: saved.path, size: saved.size, kind: saved.kind },
    }).catch(() => {});
    res.json({ ...saved, panelPath: panelPathFor(saved.path, ws, mirrorDir()) });
  });

  router.post("/tethr/:companyId/chats", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    const typed = String(req.body?.request ?? "").trim();
    const files = await validateAttachments(workspaceDir().dir, req.body?.attachments);
    if (!Array.isArray(files)) {
      res.status(400).json({ error: files.error });
      return;
    }
    if (!typed && !files.length) {
      res.status(400).json({ error: "request is required" });
      return;
    }
    const requestText = withAttachments(typed, files);
    const requestedByUserId = actor.actorType === "user" ? actor.actorId : null;
    const ids =
      getIntegrations(companyId).assistant.engine === "session"
        ? await getAssistantRunner(db).send({ companyId, threadId: null, text: requestText, requestedByUserId })
        : await new Promise<{ routeRunId: string; threadId: string }>((resolve, reject) => {
            routing
              .routeRequest({
                companyId,
                requestText,
                invocationSource: "console",
                requestedByUserId,
                threadId: null,
                hopDelayMs: 350,
                onStarted: resolve,
              })
              .catch((err) => {
                logger.warn({ err }, "tethr side chat route failed");
                reject(err instanceof Error ? err : new Error(String(err)));
              });
          });
    const chat = await chats.addSideChat(companyId, ids.threadId, typed || files.map((f) => f.split("/").pop()).join(", "));
    res.json({ ...ids, chat });
  });

  router.delete("/tethr/:companyId/chats/:threadId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const threadId = req.params.threadId as string;
    if (threadId === chats.mainThreadId(companyId)) {
      res.status(400).json({ error: "The main chat can't be removed" });
      return;
    }
    res.json({ removed: await chats.removeSideChat(companyId, threadId) });
  });

  // A thread's messages for the chat view: the newest runs, oldest first, each
  // with its outputs (so gated items render as inline approval cards).
  router.get("/tethr/:companyId/chats/:threadId/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const threadId = req.params.threadId as string;
    if (!UUID_RE.test(threadId)) {
      res.status(400).json({ error: "threadId must be a uuid" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 40) || 40, 1), 100);
    const runs = await routing.listThreadRuns(companyId, threadId, limit);
    const outputs = runs.length
      ? await db
          .select()
          .from(tethrOutputs)
          .where(
            and(
              eq(tethrOutputs.companyId, companyId),
              inArray(
                tethrOutputs.routeRunId,
                runs.map((r) => r.id),
              ),
            ),
          )
      : [];
    const ws = workspaceDir().dir;
    const mirror = mirrorDir();
    // Phase 21: idea cards carry their idea (for the Useful / Not now buttons).
    const cardIds = runs.filter((r) => r.sourceKey === "tethr-idea").map((r) => r.id);
    const { tethrIdeas } = await import("@paperclipai/db");
    const ideas = cardIds.length
      ? await db
          .select({ id: tethrIdeas.id, status: tethrIdeas.status, source: tethrIdeas.source, cardRunId: tethrIdeas.cardRunId })
          .from(tethrIdeas)
          .where(and(eq(tethrIdeas.companyId, companyId), inArray(tethrIdeas.cardRunId, cardIds)))
      : [];
    // Phase 26.4: an agent's report card carries Jev's "needs you now / can wait".
    const reportIds = runs.filter((r) => r.sourceKey === "tethr-agent-report").map((r) => r.id);
    const { tethrDecisions } = await import("@paperclipai/db");
    const urgencies = reportIds.length
      ? await db
          .select({ id: tethrDecisions.id, subjectId: tethrDecisions.subjectId, pick: tethrDecisions.pick, mode: tethrDecisions.mode, outcome: tethrDecisions.outcome, correctedTo: tethrDecisions.correctedTo, options: tethrDecisions.options })
          .from(tethrDecisions)
          .where(and(eq(tethrDecisions.companyId, companyId), eq(tethrDecisions.kind, "report.urgency"), inArray(tethrDecisions.subjectId, reportIds)))
      : [];
    // Phase 26.5: lesson cards carry their lesson (Apply / Not for us).
    const lessonCardIds = runs.filter((r) => r.sourceKey === "tethr-lesson").map((r) => r.id);
    const { tethrLessons } = await import("@paperclipai/db");
    const lessonRows = lessonCardIds.length
      ? await db
          .select()
          .from(tethrLessons)
          .where(and(eq(tethrLessons.companyId, companyId), inArray(tethrLessons.cardRunId, lessonCardIds)))
      : [];
    // Phase 26.3: Inbox cards carry their item (for the file / leave / put back buttons).
    const inboxCardIds = runs.filter((r) => r.sourceKey === "tethr-inbox").map((r) => r.id);
    const { tethrInboxItems } = await import("@paperclipai/db");
    const inboxItems = inboxCardIds.length
      ? await db
          .select()
          .from(tethrInboxItems)
          .where(and(eq(tethrInboxItems.companyId, companyId), inArray(tethrInboxItems.cardRunId, inboxCardIds)))
      : [];
    const questionsOfRuns = questionsByRun(companyId, new Set(runs.map((r) => r.id)));
    // Phase 27: an agent's newest report card in this chat carries what it's waiting
    // on a person for (approval cards, questions, missing connections), its sub-team's too.
    const needsYouByCard = await needsYouOnReportCards(db, companyId, runs);
    const waitingOnCreation = await connectionCardsOnCreationTurns(db, companyId, runs, outputs);
    res.json(
      runs.map((run) => {
        // Attached files come back as their own list; the bubble shows only the words.
        const { text, files } = run.invocationSource === "chat" ? splitAttachments(run.requestText) : { text: run.requestText, files: [] };
        return {
          ...run,
          requestText: text,
          attachments: files.map((f) => ({ path: f, name: f.split("/").pop() ?? f, kind: attachmentKind(f), panelPath: panelPathFor(f, ws, mirror) })),
          idea: ideas.find((i) => i.cardRunId === run.id) ?? null,
          inbox: inboxItems.find((i) => i.cardRunId === run.id) ?? null,
          urgency: urgencies.find((u) => u.subjectId === run.id) ?? null,
          lesson: lessonRows.find((l) => l.cardRunId === run.id) ?? null,
          outputs: outputs.filter((o) => o.routeRunId === run.id),
          // Phase 27: questions this turn put to the person, as cards with buttons.
          questions: [...(questionsOfRuns.get(run.id) ?? []), ...(waitingOnCreation.get(run.id) ?? [])],
          needsYou: needsYouByCard.get(run.id) ?? null,
        };
      }),
    );
  });

  // Phase 18: send a message into a chat thread. The session engine (default)
  // runs it as a turn of the thread's Claude Code session; "routing" keeps the
  // old multi-agent engine as a rollback switch.
  router.post("/tethr/:companyId/chats/:threadId/messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    const typed = String(req.body?.text ?? "").trim();
    const files = await validateAttachments(workspaceDir().dir, req.body?.attachments);
    if (!Array.isArray(files)) {
      res.status(400).json({ error: files.error });
      return;
    }
    if (!typed && !files.length) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    const text = withAttachments(typed, files);
    const threadId = req.params.threadId as string;
    const requestedByUserId = actor.actorType === "user" ? actor.actorId : null;
    if (getIntegrations(companyId).assistant.engine === "routing") {
      const ids = await new Promise<{ routeRunId: string; threadId: string }>((resolve, reject) => {
        routing
          .routeRequest({ companyId, requestText: text, invocationSource: "console", requestedByUserId, threadId, hopDelayMs: 350, onStarted: resolve })
          .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
      });
      res.json(ids);
      return;
    }
    // Writing in the chat instead of tapping a card is an answer too.
    await closeQuestionsAnsweredInChat(companyId, threadId, actor.actorId);
    res.json(await getAssistantRunner(db).send({ companyId, threadId, text, requestedByUserId }));
  });

  // Phase 27: answer a question tethr or an agent asked as a card. The answer goes
  // into the chat it was asked in, as the person's own message; it grants nothing
  // by itself (anything outward still gets its own approval card).
  router.post("/tethr/:companyId/questions/:id/answer", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    const userId = actor.actorType === "user" ? actor.actorId : null;
    let question;
    let startedTasks = 0;
    try {
      // A connection card settles the need before it closes, so a "connected" that
      // isn't true yet leaves the card open and says what's still missing.
      const asked = getQuestion(companyId, req.params.id as string);
      const choice = typeof req.body?.choice === "string" ? req.body.choice : "";
      if (asked?.status === "open" && asked.connection && (choice === "connected" || choice === "without")) {
        const missing = choice === "connected" ? stillMissing(companyId, asked.connection.key) : null;
        if (missing) throw new QuestionInputError(missing);
        ({ startedTasks } = await settleConnectionCard(db, companyId, asked, choice, { userId }));
      }
      question = await answerQuestion(companyId, req.params.id as string, { choice: req.body?.choice, comment: req.body?.comment, by: actor.actorId });
    } catch (err) {
      if (err instanceof QuestionInputError || err instanceof TeamInputError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    // Work that was waiting on it has started: the news rides along as a note, not as a second turn.
    if (startedTasks > 0) {
      res.json({ question, startedTasks, threadId: question.threadId, routeRunId: null });
      return;
    }
    const ids = await getAssistantRunner(db).send({
      companyId,
      threadId: question.threadId,
      text: answerText(question),
      requestedByUserId: userId,
    });
    res.json({ question, ...ids });
  });

  // Phase 27: a message sent while tethr is still working waits its turn. Until it
  // starts, the person who sent it can change its words or take it back.
  const waitingMessage = async (req: Request, res: Response): Promise<{ companyId: string; runId: string } | null> => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return null;
    const runId = req.params.runId as string;
    const [run] = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.id, runId), eq(tethrRouteRuns.companyId, companyId)));
    if (!run) {
      res.status(404).json({ error: "Message not found" });
      return null;
    }
    // Only a person's own message: a turn tethr started (a task, a check-in) isn't theirs to rewrite.
    if (run.invocationSource !== "chat" || run.sourceKey !== null) {
      res.status(409).json({ error: "Only a message you sent can be changed." });
      return null;
    }
    return { companyId, runId };
  };
  const ALREADY_STARTED = "tethr has already started on this one.";
  const MAX_CHAT_MESSAGE_CHARS = 40_000;

  router.patch("/tethr/:companyId/chat-turns/:runId", async (req, res) => {
    const target = await waitingMessage(req, res);
    if (!target) return;
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      res.status(400).json({ error: "That message is too long." });
      return;
    }
    if (!(await getAssistantRunner(db).editQueued(target.runId, text))) {
      res.status(409).json({ error: ALREADY_STARTED });
      return;
    }
    res.json({ ok: true });
  });

  router.delete("/tethr/:companyId/chat-turns/:runId", async (req, res) => {
    const target = await waitingMessage(req, res);
    if (!target) return;
    if (!(await getAssistantRunner(db).cancelQueued(target.runId))) {
      res.status(409).json({ error: ALREADY_STARTED });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/tethr/:companyId/chat-turns/:runId/stop", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const runId = req.params.runId as string;
    const [run] = await db.select().from(tethrRouteRuns).where(and(eq(tethrRouteRuns.id, runId), eq(tethrRouteRuns.companyId, companyId)));
    if (!run) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }
    res.json({ stopped: await getAssistantRunner(db).stop(runId) });
  });

  // Start the thread's Claude session over (the chat history stays on screen).
  // The new session gets no recap of the old turns, so it hasn't seen connector
  // data and web pages are free again.
  router.post("/tethr/:companyId/chats/:threadId/reset", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    await chats.startOver(companyId, req.params.threadId as string);
    res.json({ reset: true });
  });

  // Memory (phase 25): routes/tethr-memory.ts.

  // ---- Integrations (phase 18.4): connector modes, rules, chat model/engine ----
  router.get("/tethr/:companyId/integrations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const cfg = getIntegrations(companyId);
    const seen = cfg.discovered?.connectors ?? {};
    const labels = [...new Set([...KNOWN_CONNECTORS.map((k) => k.label), ...Object.keys(seen), ...Object.keys(cfg.connectors)])];
    const jev = await jevHealth();
    const jevNote =
      jev === "ok" ? "Jev is connected." : jev === "missing" ? "Jev isn't set up yet: add TYPESAFE_API_KEY on the Environment page." : `Jev: ${jevHealthText(jev)}`;
    res.json({
      defaultMode: cfg.defaultMode,
      internalAddresses: cfg.internalAddresses,
      shell: cfg.shell,
      assistant: cfg.assistant,
      team: cfg.team,
      workspace: workspaceDir(),
      connectors: labels.map((label) => {
        const known = KNOWN_CONNECTORS.find((k) => k.label === label);
        return {
          label,
          mode: modeFor(cfg, label),
          explicit: Boolean(cfg.connectors[label]),
          scope: cfg.connectors[label]?.scope ?? "",
          blurb:
            label === TETHR_TOOLS_LABEL
              ? `${known?.blurb ?? ""} ${jevNote}`.trim()
              : (known?.blurb ?? "Connected through your Claude account."),
          scopeHint: known?.scopeHint ?? null,
          toolsKnown: known?.tools ?? 0,
          toolsSeen: seen[label]?.length ?? 0,
          moneyOnly: label === "Mercury",
        };
      }),
      discoveredAt: cfg.discovered?.at ?? null,
    });
  });

  // ---- Environment (phase 19.2): the instance .env, like a hosting dashboard ----
  // Instance admins only (a person, never an agent). Listing never returns a
  // value; a value comes back only from the explicit reveal POST.
  const requireEnvAdmin = (req: Request, res: Response): boolean => {
    assertCompanyAccess(req, req.params.companyId as string);
    if (isInstanceAdmin(req)) return true;
    res.status(403).json({ error: "Only an instance admin can see or change the environment." });
    return false;
  };
  const logEnv = (req: Request, action: string, key: string) =>
    logActivity(db, {
      companyId: req.params.companyId as string,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action,
      entityType: "company",
      entityId: req.params.companyId as string,
      details: { key }, // the name only, never the value
    }).catch(() => {});

  router.get("/tethr/:companyId/env", async (req, res) => {
    if (!requireEnvAdmin(req, res)) return;
    const env = await envFile.listEnv();
    const have = new Set(env.entries.map((e) => e.key));
    const suggestions = (await envFile.envSuggestions()).filter((s) => !have.has(s.key));
    res.json({ ...env, suggestions });
  });

  router.post("/tethr/:companyId/env/reveal", async (req, res) => {
    if (!requireEnvAdmin(req, res)) return;
    const key = String(req.body?.key ?? "");
    const value = await envFile.readEnvValue(key);
    if (value === null) {
      res.status(404).json({ error: `${key} isn't in the file.` });
      return;
    }
    await logEnv(req, "tethr_env_revealed", key);
    res.setHeader("Cache-Control", "no-store");
    res.json({ key, value });
  });

  router.put("/tethr/:companyId/env", async (req, res) => {
    if (!requireEnvAdmin(req, res)) return;
    const key = String(req.body?.key ?? "").trim();
    const value = typeof req.body?.value === "string" ? req.body.value : "";
    const result = await envFile.setEnv(key, value);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await logEnv(req, "tethr_env_updated", key);
    // A key an agent was waiting on (the Google Ads settings, say) starts what waited.
    const { recheckConnections } = await import("../tethr/team-needs.js");
    await recheckConnections(db, req.params.companyId as string).catch(() => {});
    res.json({ ok: true });
  });

  router.delete("/tethr/:companyId/env/:key", async (req, res) => {
    if (!requireEnvAdmin(req, res)) return;
    const key = req.params.key as string;
    const result = await envFile.deleteEnv(key);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    await logEnv(req, "tethr_env_deleted", key);
    res.json({ ok: true });
  });

  // ---- Fresh-start wipe (phase 20.0) --------------------------------------------
  // Inert unless TETHR_ALLOW_RESET=true. Instance admins only. The run needs a
  // fresh database backup (core POST /instance/database-backups) and a typed
  // confirmation naming the companies.
  const requireResetAdmin = (req: Request, res: Response): boolean => {
    if (!resetAllowed()) {
      res.status(404).json({ error: "Not found" });
      return false;
    }
    if (isInstanceAdmin(req)) return true;
    res.status(403).json({ error: "Only an instance admin can do this." });
    return false;
  };
  const prefixesOf = (raw: unknown) =>
    String(raw ?? "")
      .split(",")
      .map((p) => p.trim().toUpperCase())
      .filter((p) => /^[A-Z0-9]{1,10}$/.test(p));

  router.get("/tethr/admin/reset/plan", async (req, res) => {
    if (!requireResetAdmin(req, res)) return;
    res.json(await planReset(db, prefixesOf(req.query.prefixes)));
  });

  router.post("/tethr/admin/reset", async (req, res) => {
    if (!requireResetAdmin(req, res)) return;
    const prefixes = prefixesOf(req.body?.prefixes);
    if (!prefixes.length || req.body?.confirm !== `WIPE ${prefixes.join(",")}`) {
      res.status(400).json({ error: `Confirm with "WIPE ${prefixes.join(",") || "<prefixes>"}".` });
      return;
    }
    const backupFile = String(req.body?.backupFile ?? "");
    const backup = backupFile ? await fs.promises.stat(backupFile).catch(() => null) : null;
    if (!backup?.isFile() || backup.size === 0 || Date.now() - backup.mtimeMs > 60 * 60 * 1000) {
      res.status(400).json({ error: "Take a database backup first (it must be under an hour old) and pass its backupFile." });
      return;
    }
    const result = await runReset(db, prefixes);
    // A fresh Wandr with only @tethr, right away (a restart also does this).
    const seeded = await seedTethrCore(db).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
    logger.warn({ prefixes, result, backupFile }, "[tethr] fresh-start wipe ran");
    res.json({ ...result, backupFile, seeded });
  });

  // ---- Goals, setup (onboarding) and ideas (phases 20-21): routes/tethr-setup.ts ----
  router.use(tethrSetupRoutes(db));
  // ---- tethr's team of agents (phase 23): routes/tethr-team.ts ----
  router.use(tethrTeamRoutes(db));
  router.use(tethrMemoryRoutes(db));
  router.use(tethrGrowthMapRoutes(db));
  router.use(tethrDecisionRoutes(db));
  router.use(tethrInboxRoutes(db));
  router.use(tethrLearningRoutes(db));

  router.put("/tethr/:companyId/integrations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only a person can change integrations" });
      return;
    }
    const patch = sanitizeIntegrationsPatch((req.body ?? {}) as Record<string, unknown>);
    const current = getIntegrations(companyId);
    if (patch.connectors) patch.connectors = { ...current.connectors, ...patch.connectors };
    if (patch.assistant) patch.assistant = { ...current.assistant, ...patch.assistant };
    const cfg = await updateIntegrations(companyId, patch);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: "tethr_integrations_updated",
      entityType: "company",
      entityId: companyId,
      details: { patch },
    }).catch(() => {});
    const { recheckConnections } = await import("../tethr/team-needs.js");
    await recheckConnections(db, companyId).catch(() => {});
    res.json({ ok: true, defaultMode: cfg.defaultMode });
  });

  router.get("/tethr/:companyId/chat-engine", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(getIntegrations(companyId).assistant);
  });

  router.post("/tethr/:companyId/chat-engine", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const engine = req.body?.engine === "routing" ? "routing" : "session";
    // Same validation as the Integrations page (model names only).
    const { assistant } = sanitizeIntegrationsPatch({ assistant: { engine, model: req.body?.model } });
    const cfg = await updateIntegrations(companyId, { assistant: { ...getIntegrations(companyId).assistant, ...assistant } });
    res.json(cfg.assistant);
  });

  // ---- Queue (gated outputs) --------------------------------------------------
  router.get("/tethr/:companyId/outputs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status ? String(req.query.status) : undefined;
    const outputs = await gating.listOutputs(companyId, { status });
    res.json(
      outputs.map((o) => ({ ...o, body: undefined, preview: o.body.slice(0, 320) })),
    );
  });

  router.get("/tethr/:companyId/outputs/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const output = await gating.getOutput(companyId, req.params.id as string);
    if (!output) {
      res.status(404).json({ error: "Output not found" });
      return;
    }
    let approval = null;
    if (output.approvalId) {
      const [row] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, output.approvalId))
        .limit(1);
      approval = row ?? null;
    }
    let subagent = null;
    if (output.subagentId) {
      const [row] = await db
        .select()
        .from(tethrSubagents)
        .where(eq(tethrSubagents.id, output.subagentId))
        .limit(1);
      subagent = row ?? null;
    }
    // Revision lineage: ancestors and descendants of this draft.
    const revisions = await db
      .select({
        id: tethrOutputs.id,
        title: tethrOutputs.title,
        status: tethrOutputs.status,
        revisionNumber: tethrOutputs.revisionNumber,
        revisionOfId: tethrOutputs.revisionOfId,
        createdAt: tethrOutputs.createdAt,
      })
      .from(tethrOutputs)
      .where(
        and(
          eq(tethrOutputs.companyId, companyId),
          or(
            eq(tethrOutputs.id, output.id),
            eq(tethrOutputs.revisionOfId, output.id),
            output.revisionOfId
              ? or(
                  eq(tethrOutputs.id, output.revisionOfId),
                  eq(tethrOutputs.revisionOfId, output.revisionOfId),
                )!
              : eq(tethrOutputs.id, output.id),
          )!,
        ),
      )
      .orderBy(tethrOutputs.revisionNumber);
    res.json({ output, approval, subagent, revisions });
  });

  // Send a draft back to its producing subagent for a revision.
  router.post("/tethr/:companyId/outputs/:id/revise", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const result = await worker.reviseOutput({
        companyId,
        outputId: req.params.id as string,
        note: req.body?.note ? String(req.body.note) : undefined,
      });
      res.json(result);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/outputs/:id/decide", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const decision = String(req.body?.decision ?? "");
    if (!["approve", "reject", "request_changes"].includes(decision)) {
      res.status(400).json({ error: "decision must be approve | reject | request_changes" });
      return;
    }
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only humans decide gated output" });
      return;
    }
    try {
      const updated = await gating.decide({
        companyId,
        outputId: req.params.id as string,
        decision: decision as "approve" | "reject" | "request_changes",
        reviewer: actor.actorId,
        note: req.body?.note ? String(req.body.note) : undefined,
      });
      // Auto-revise: the agent picks the note up and produces v(n+1)
      // (TETHR_AUTO_REVISE=false disables; the Queue also has a manual button).
      if (decision === "request_changes" && updated?.kind !== "external_action" && process.env.TETHR_AUTO_REVISE !== "false") {
        void worker
          .reviseOutput({ companyId, outputId: req.params.id as string })
          .catch((err) => logger.warn({ err }, "tethr auto-revise failed"));
      }
      res.json(updated);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Drive -------------------------------------------------------------------
  router.get("/tethr/:companyId/drive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parentId = req.query.parentId ? String(req.query.parentId) : null;
    res.json(await drive.listChildren(companyId, parentId));
  });

  router.get("/tethr/:companyId/drive/node/:nodeId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const node = await drive.getNode(companyId, req.params.nodeId as string);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    const versions = await drive.listVersions(companyId, node.id);
    res.json({ node, versions });
  });

  router.get("/tethr/:companyId/drive/node/:nodeId/content", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const node = await drive.getNode(companyId, req.params.nodeId as string);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    const versionId = req.query.versionId
      ? String(req.query.versionId)
      : node.currentVersionId;
    if (!versionId) {
      res.status(404).json({ error: "No content versions" });
      return;
    }
    const read = await drive.readVersion(companyId, versionId);
    if (!read) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    res.json({
      versionId: read.version.id,
      versionNumber: read.version.versionNumber,
      contentType: read.version.contentType,
      content: read.content.toString("utf8"),
    });
  });

  router.post("/tethr/:companyId/drive/file", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { path: drivePath, content, tags, note } = req.body ?? {};
    if (typeof drivePath !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "path and content are required" });
      return;
    }
    const result = await drive.putFile({
      companyId,
      path: drivePath,
      content,
      tags: Array.isArray(tags) ? tags.map(String) : undefined,
      note: note ? String(note) : undefined,
      createdByTag: actor.actorId,
    });
    res.json(result);
  });

  router.post("/tethr/:companyId/drive/node/:nodeId/tags", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
    const updated = await drive.setTags(companyId, req.params.nodeId as string, tags);
    if (!updated) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    res.json(updated);
  });

  router.post(
    "/tethr/:companyId/drive/node/:nodeId/permissions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { owner, read, write } = req.body ?? {};
      if (typeof owner !== "string" || !Array.isArray(read) || !Array.isArray(write)) {
        res.status(400).json({ error: "owner, read[], write[] are required" });
        return;
      }
      const updated = await drive.setPermissions(
        companyId,
        req.params.nodeId as string,
        { owner, read: read.map(String), write: write.map(String) },
      );
      if (!updated) {
        res.status(404).json({ error: "Node not found" });
        return;
      }
      res.json(updated);
    },
  );

  // File-manager mutations — manual, human-driven. Agents never hit these; they
  // only ever putFile into their own folders.
  router.post("/tethr/:companyId/drive/folder", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { parentId, name } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    try {
      const node = await drive.createFolder(
        companyId,
        parentId == null ? null : String(parentId),
        name,
        actor.actorId,
      );
      res.json(node);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/drive/node/:nodeId/move", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const body = req.body ?? {};
    // newParentId: omit to keep parent (rename), null to move to root.
    const opts: { newParentId?: string | null; newName?: string; actorTag: string } = {
      actorTag: actor.actorId,
    };
    if ("newParentId" in body) {
      opts.newParentId = body.newParentId == null ? null : String(body.newParentId);
    }
    if (typeof body.newName === "string") opts.newName = body.newName;
    try {
      const node = await drive.moveNode(companyId, req.params.nodeId as string, opts);
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }
      res.json(node);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/drive/node/:nodeId/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    try {
      const node = await drive.archiveNode(
        companyId,
        req.params.nodeId as string,
        actor.actorId,
      );
      if (!node) {
        res.status(404).json({ error: "Node not found" });
        return;
      }
      res.json(node);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Runs / heartbeats ----------------------------------------------------
  router.get("/tethr/:companyId/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const [routineRows, triggerRows, runRows, profiles] = await Promise.all([
      db.select().from(routines).where(eq(routines.companyId, companyId)),
      db
        .select()
        .from(routineTriggers)
        .where(eq(routineTriggers.companyId, companyId)),
      db
        .select({
          run: heartbeatRuns,
          agentName: agents.name,
          agentIcon: agents.icon,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(eq(heartbeatRuns.companyId, companyId))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(60),
      org.listProfiles(companyId),
    ]);

    const profileByAgentId = new Map(
      profiles.map((p) => [p.agent.id, p.profile]),
    );
    res.json({
      schedules: routineRows.map((r) => {
        const trigger = triggerRows.find((t) => t.routineId === r.id);
        const profile = r.assigneeAgentId
          ? profileByAgentId.get(r.assigneeAgentId)
          : null;
        return {
          routineId: r.id,
          title: r.title,
          description: r.description,
          status: r.status,
          agentId: r.assigneeAgentId,
          agentTag: profile?.tag ?? null,
          cron: trigger?.cronExpression ?? null,
          timezone: trigger?.timezone ?? null,
          enabled: trigger?.enabled ?? false,
          nextRunAt: trigger?.nextRunAt ?? null,
        };
      }),
      runs: runRows.map(({ run, agentName, agentIcon }) => ({
        id: run.id,
        agentId: run.agentId,
        agentName,
        agentIcon,
        agentTag: profileByAgentId.get(run.agentId)?.tag ?? null,
        status: run.status,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
        summary: (run.resultJson as Record<string, unknown> | null)?.summary ?? null,
        stdoutExcerpt: run.stdoutExcerpt,
      })),
    });
  });

  // Manual "run now": executes the agent's standing heartbeat chain through
  // the routing engine, synchronously, recording a real heartbeat run row.
  router.post("/tethr/:companyId/agents/:agentId/run-now", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const agentId = req.params.agentId as string;
    const row = await org.getProfileByAgentId(companyId, agentId);
    if (!row) {
      res.status(404).json({ error: "No Tethr profile for this agent" });
      return;
    }
    const config = (row.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const requestText =
      (typeof req.body?.request === "string" && req.body.request.trim()) ||
      (typeof config.heartbeatRequest === "string" && config.heartbeatRequest) ||
      `Run the standing heartbeat for ${row.profile.tag}.`;
    const chain = Array.isArray(config.subagentChain)
      ? (config.subagentChain as string[])
      : undefined;

    const startedAt = new Date();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: `Run now by ${actor.actorId}`,
        status: "running",
        startedAt,
        processStartedAt: startedAt,
      })
      .returning();

    const result = await routing.routeRequest({
      companyId,
      requestText,
      invocationSource: "heartbeat",
      heartbeatRunId: run.id,
      startAtAgentTag: row.profile.tag,
      subagentChain: chain,
    });

    const provider = getTethrLLMProvider();
    const finishedAt = new Date();
    const transcript = result.hops
      .map((h) => `[route] ${h.layer} ${h.actorTag} → ${h.decision} (${h.reason})`)
      .join("\n");
    await db
      .update(heartbeatRuns)
      .set({
        status: result.status === "failed" ? "failed" : "succeeded",
        finishedAt,
        exitCode: result.status === "failed" ? 1 : 0,
        error: result.status === "failed" ? result.resultText : null,
        usageJson: { ...result.usage },
        resultJson: {
          summary: result.resultText.slice(0, 500),
          routeRunId: result.routeRunId,
          outputs: result.outputs,
        },
        stdoutExcerpt: transcript.slice(0, 4000),
        updatedAt: finishedAt,
      })
      .where(eq(heartbeatRuns.id, run.id));

    // Record usage as a cost event (mock runs bill at $0).
    const costCents =
      provider.id === "claude"
        ? Math.max(
            1,
            Math.round(
              (result.usage.inputTokens * 3 + result.usage.outputTokens * 15) / 10000,
            ),
          )
        : 0;
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: run.id,
      provider: provider.id === "claude" ? "anthropic" : "tethr-mock",
      biller: provider.id === "claude" ? "anthropic" : "tethr",
      billingType: provider.id === "claude" ? "api" : "fixed",
      model: provider.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costCents,
      occurredAt: finishedAt,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "tethr_run_now",
      entityType: "heartbeat_run",
      entityId: run.id,
      agentId,
      runId: run.id,
      details: { agentTag: row.profile.tag, status: result.status },
    });

    res.json({ runId: run.id, ...result });
  });

  // ---- Budgets ----------------------------------------------------------------
  router.get("/tethr/:companyId/budgets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // Real month-to-date spend per agent, summed from cost_events (the same
    // source the budget hard-stop enforces on) — so the page shows what actually
    // accrued, not a stale denormalized field.
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [profiles, policies, series, monthSpend] = await Promise.all([
      org.listProfiles(companyId),
      db
        .select()
        .from(budgetPolicies)
        .where(eq(budgetPolicies.companyId, companyId)),
      db
        .select({
          agentId: costEvents.agentId,
          day: sql<string>`to_char(${costEvents.occurredAt}, 'YYYY-MM-DD')`,
          costCents: sql<number>`sum(${costEvents.costCents})::int`,
        })
        .from(costEvents)
        .where(
          and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, since)),
        )
        .groupBy(costEvents.agentId, sql`to_char(${costEvents.occurredAt}, 'YYYY-MM-DD')`),
      db
        .select({
          agentId: costEvents.agentId,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart)),
        )
        .groupBy(costEvents.agentId),
    ]);
    const spentByAgent = new Map(monthSpend.map((r) => [r.agentId, r.costCents]));

    res.json({
      agents: profiles.map(({ agent, profile }) => ({
        agentId: agent.id,
        name: agent.name,
        tag: profile.tag,
        icon: agent.icon,
        budgetMonthlyCents: agent.budgetMonthlyCents,
        spentMonthlyCents: spentByAgent.get(agent.id) ?? agent.spentMonthlyCents ?? 0,
        approvalGate: profile.approvalGate,
        policy:
          policies.find(
            (p) => p.scopeType === "agent" && p.scopeId === agent.id,
          ) ?? null,
      })),
      companyPolicy: policies.find((p) => p.scopeType === "company") ?? null,
      series,
    });
  });

  // ---- Audit --------------------------------------------------------------------
  router.get("/tethr/:companyId/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const limit = Math.min(Number(req.query.limit ?? 100), 300);
    const kind = req.query.kind ? String(req.query.kind) : null;
    const actorId = req.query.actor ? String(req.query.actor) : null;
    const search = req.query.q ? String(req.query.q) : null;

    const conditions = [eq(activityLog.companyId, companyId)];
    if (kind === "routing") conditions.push(like(activityLog.action, "tethr_route%"));
    else if (kind === "outputs") conditions.push(like(activityLog.action, "tethr_output%"));
    else if (kind === "approvals")
      conditions.push(
        or(
          like(activityLog.action, "tethr_output_approved%"),
          like(activityLog.action, "tethr_output_rejected%"),
          like(activityLog.action, "tethr_output_changes%"),
          like(activityLog.action, "approval%"),
        )!,
      );
    else if (kind === "runs")
      conditions.push(
        or(
          like(activityLog.action, "tethr_run%"),
          like(activityLog.action, "heartbeat%"),
        )!,
      );
    else if (kind === "drive") conditions.push(like(activityLog.action, "tethr_drive%"));
    if (actorId) conditions.push(eq(activityLog.actorId, actorId));
    if (search) conditions.push(like(activityLog.action, `%${search}%`));

    const rows = await db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);
    res.json(rows);
  });

  // ---- Notifications ---------------------------------------------------------
  router.get("/tethr/:companyId/notifications", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const unreadOnly = req.query.unread === "true";
    res.json(await notify.list(companyId, { unreadOnly }));
  });

  router.post("/tethr/:companyId/notifications/:id/read", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await notify.markRead(companyId, req.params.id as string));
  });

  router.post("/tethr/:companyId/notifications/read-all", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await notify.markAllRead(companyId);
    res.json({ ok: true });
  });

  // ---- Memory -----------------------------------------------------------------
  router.get("/tethr/:companyId/memories", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
    res.json(await memory.list(companyId, { agentId }));
  });

  // Phase 6: idempotently seed published-content memories from a corpus (the
  // blueprint's memory-published-articles.md). Corpus text in the body, or read
  // server-side from TETHR_MEMORY_SEED_PATH. Re-running skips existing fingerprints.
  router.post("/tethr/:companyId/seed-memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { parsePublishedCorpus, recordPublished } = await import(
      "../tethr/published-memory.js"
    );
    let corpus = typeof req.body?.corpus === "string" ? req.body.corpus : "";
    if (!corpus) {
      const p = process.env.TETHR_MEMORY_SEED_PATH?.trim();
      if (p) {
        try {
          const fs = await import("node:fs");
          corpus = fs.readFileSync(p, "utf8");
        } catch (err) {
          res.status(400).json({ error: `could not read TETHR_MEMORY_SEED_PATH: ${String(err)}` });
          return;
        }
      }
    }
    if (!corpus) {
      res.status(400).json({ error: "provide { corpus } in the body or set TETHR_MEMORY_SEED_PATH" });
      return;
    }
    const items = parsePublishedCorpus(corpus);
    let created = 0;
    let existing = 0;
    for (const item of items) {
      const r = await recordPublished(db, companyId, item, null);
      if (r === "created") created++;
      else existing++;
    }
    res.json({ parsed: items.length, created, existing });
  });

  // ---- Deep health check (Phase 9) — for an external uptime pinger -----------
  // Public (like /api/health): reports only DB reachability + heartbeat age.
  router.get("/tethr/health/deep", async (_req, res) => {
    const { deepHealthCheck } = await import("../tethr/observability.js");
    const h = await deepHealthCheck(db);
    res.status(h.ok ? 200 : 503).json(h);
  });

  // ---- Digest -------------------------------------------------------------------
  router.post("/tethr/:companyId/digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { digestService } = await import("../tethr/digest.js");
    res.json(await digestService(db).generateDigest(companyId));
  });

  // ---- Org building: divisions + agents (the "ready to fill" promise) ------------
  router.post("/tethr/:companyId/divisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const name = String(req.body?.name ?? "").trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const key = (String(req.body?.key ?? "") || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const { tethrDivisions } = await import("@paperclipai/db");
    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${tethrDivisions.sortOrder}), 0)` })
      .from(tethrDivisions)
      .where(eq(tethrDivisions.companyId, companyId));
    const [division] = await db
      .insert(tethrDivisions)
      .values({
        companyId,
        key,
        name,
        description: req.body?.description ? String(req.body.description) : null,
        status: "shell",
        icon: req.body?.icon ? String(req.body.icon) : "puzzle",
        sortOrder: (maxRow?.max ?? 0) + 1,
      })
      .returning();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "tethr_division_created",
      entityType: "tethr_division",
      entityId: division.id,
      details: { name, key },
    });
    res.json(division);
  });

  router.post("/tethr/:companyId/agents", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const codename = String(req.body?.codename ?? "").trim();
    const title = String(req.body?.title ?? "").trim();
    const mission = String(req.body?.mission ?? "").trim();
    const divisionId = req.body?.divisionId ? String(req.body.divisionId) : null;
    const isHead = req.body?.isHead === true;
    const approvalGate = ["medical", "public", "spend", "pr", "internal", "none"].includes(
      String(req.body?.approvalGate),
    )
      ? String(req.body?.approvalGate)
      : "internal";
    if (!codename || !title) {
      res.status(400).json({ error: "codename and title are required" });
      return;
    }
    const tag = `@${codename.toLowerCase().replace(/[^a-z0-9]+/g, "")}`;

    const existing = await org.getProfileByTag(companyId, tag);
    if (existing) {
      res.status(409).json({ error: `${tag} already exists` });
      return;
    }

    const { agents: agentsTable, tethrAgentProfiles, tethrDivisions, tethrSubagents } =
      await import("@paperclipai/db");
    // New agents report to the division head when one exists, else to Helm.
    const helm = await org.getProfileByTag(companyId, "@helm");
    let reportsTo = helm?.agent.id ?? null;
    let division = null;
    if (divisionId) {
      const [row] = await db
        .select()
        .from(tethrDivisions)
        .where(
          and(eq(tethrDivisions.companyId, companyId), eq(tethrDivisions.id, divisionId)),
        );
      division = row ?? null;
      if (division?.headAgentId && !isHead) reportsTo = division.headAgentId;
    }

    const [agent] = await db
      .insert(agentsTable)
      .values({
        companyId,
        name: codename,
        role: isHead ? "executive" : "general",
        title,
        icon: "bot",
        status: "idle",
        reportsTo,
        capabilities: mission || title,
        adapterType: "tethr_llm",
        adapterConfig: { agentTag: tag },
        budgetMonthlyCents: Number(req.body?.budgetMonthlyCents ?? 5000),
      })
      .returning();

    await db.insert(tethrAgentProfiles).values({
      companyId,
      agentId: agent.id,
      divisionId,
      tag,
      codename,
      mission: mission || title,
      approvalGate,
      routingTable: [],
      standingRules: helm?.profile.standingRules ?? [],
    });

    const subagentSpecs = Array.isArray(req.body?.subagents) ? req.body.subagents : [];
    let order = 0;
    for (const spec of subagentSpecs.slice(0, 6)) {
      const key = String(spec?.key ?? "").trim();
      const job = String(spec?.job ?? "").trim();
      if (!key || !job) continue;
      await db.insert(tethrSubagents).values({
        companyId,
        agentId: agent.id,
        key,
        tag: `${tag}.${key}`,
        name: String(spec?.name ?? key),
        job,
        routeWhen: [key],
        sensitivity: approvalGate === "none" ? "internal" : approvalGate,
        sortOrder: order++,
      });
    }

    if (isHead && division) {
      await db
        .update(tethrDivisions)
        .set({ headAgentId: agent.id, status: "active", updatedAt: new Date() })
        .where(eq(tethrDivisions.id, division.id));
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: "tethr_agent_created",
      entityType: "agent",
      entityId: agent.id,
      agentId: agent.id,
      details: { tag, title, divisionId, isHead },
    });
    res.json({ agentId: agent.id, tag });
  });

  // ---- Org change log (Tinkr) ------------------------------------------------
  // The revertible history of every applied agent modification.
  router.get("/tethr/:companyId/org-changes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { tethrOrgChanges } = await import("@paperclipai/db");
    const { desc: descOp } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(tethrOrgChanges)
      .where(eq(tethrOrgChanges.companyId, companyId))
      .orderBy(descOp(tethrOrgChanges.appliedAt))
      .limit(100);
    res.json(rows);
  });

  // Revert = stage the INVERSE change through the same human gate (git-revert
  // style). Nothing is undone until the staged revert is approved in the Queue.
  router.post("/tethr/:companyId/org-changes/:id/revert", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { tethrOrgChanges } = await import("@paperclipai/db");
    const [change] = await db
      .select()
      .from(tethrOrgChanges)
      .where(
        and(
          eq(tethrOrgChanges.companyId, companyId),
          eq(tethrOrgChanges.id, req.params.id as string),
        ),
      )
      .limit(1);
    if (!change) {
      res.status(404).json({ error: "Change not found" });
      return;
    }
    if (change.status === "reverted") {
      res.status(409).json({ error: "This change was already reverted" });
      return;
    }
    const { buildInverseSpec, validateOrgChange, computeBefore, renderChangeBody, changeSummary } =
      await import("../tethr/org-changes.js");
    const inverse = buildInverseSpec(change);
    const validated = await validateOrgChange(db, companyId, inverse);
    if (!validated.ok || !validated.spec || !validated.target) {
      res.status(409).json({
        error: `Cannot revert: ${validated.errors.join("; ")} (the org may have changed since)`,
      });
      return;
    }
    const tinkr = await org.getProfileByTag(companyId, "@tinkr");
    if (!tinkr) {
      res.status(409).json({ error: "No @tinkr agent in this org" });
      return;
    }
    const before = await computeBefore(db, companyId, validated.spec);
    const output = await gating.createOutput({
      companyId,
      agentId: tinkr.agent.id,
      agentTag: "@tinkr",
      kind: "org_change",
      title: `Org change (revert): ${changeSummary(validated.spec, before)}`,
      body:
        renderChangeBody(validated.spec, before, validated.target) +
        `\n\n_Reverts change ${change.id.slice(0, 8)} (${change.summary})._`,
      // Reverting a budget change is still a budget change — gate it as spend
      // (parity with the staging path in worker.ts).
      sensitivity: validated.spec.op === "update_budget" ? "spend" : "org",
      meta: { change: validated.spec, revertOfChangeId: change.id },
    });
    res.json({ outputId: output?.id });
  });

  // The CEO proposes a new agent → gated `agent_proposal` output (Queue + Slack).
  // A human approves it to actually build the agent (gating.approveAgentProposal).
  router.post("/tethr/:companyId/agents/propose", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { output, spec } = await proposeAgent(db, companyId, {
        brief: typeof req.body?.brief === "string" ? req.body.brief : undefined,
        autonomous: req.body?.autonomous === true,
      });
      res.json({ outputId: output?.id, codename: spec.codename, tag: `@${spec.codename.toLowerCase().replace(/[^a-z0-9]/g, "")}` });
    } catch (err) {
      if (err instanceof NoCeoError) {
        res.status(409).json({ error: err.message });
        return;
      }
      if (err instanceof ProposalRejectedError) {
        res.status(422).json({ error: err.message, errors: err.errors });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Export / import ------------------------------------------------------------
  router.get("/tethr/:companyId/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { exportService } = await import("../tethr/export.js");
    const bundle = await exportService(db).exportCompany(companyId);
    res.setHeader("content-disposition", 'attachment; filename="tethr-export.json"');
    res.json(bundle);
  });

  router.post("/tethr/:companyId/import", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bundle = req.body;
    if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.driveFiles)) {
      res.status(400).json({ error: "Expected a v1 tethr export bundle" });
      return;
    }
    const { exportService } = await import("../tethr/export.js");
    res.json(await exportService(db).importDriveAndMemories(companyId, bundle));
  });

  // ---- Status / settings --------------------------------------------------------
  router.get("/tethr/:companyId/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const config = loadConfig();
    const provider = getTethrLLMProvider();
    res.json({
      llm: {
        provider: provider.id,
        model: provider.model,
        mode: getTethrLlmMode(),
        backend: getTethrLlmBackend(),
        liveKeyPresent: tethrLiveKeyPresent(),
      },
      storage: {
        provider: config.storageProvider,
        localDir:
          config.storageProvider === "local_disk" ? config.storageLocalDiskBaseDir : null,
      },
      database: {
        external: Boolean(process.env.DATABASE_URL),
      },
      bundle: {
        path: process.env.TETHR_BUNDLE_PATH ?? null,
      },
      notifications: {
        // Slack posts for real once the bot token is set; SMS and email only log.
        channels: ["in_app (live)", `slack (${slackConfigured() ? "live" : "mock"})`, "sms (mock)", "email (mock)"],
      },
      mirror: await (async () => {
        const m = await import("../tethr/mirror.js");
        return { enabled: m.mirrorConfigured(), dir: m.mirrorDir() };
      })(),
      paperclipSha: await getPaperclipSha(),
    });
  });

  // Shared-workspace mirror (phase 12, v1): the live read-only view of the
  // Google Drive-synced "00 Tethr" folder. Stateless readdir walk — human
  // deletes/moves/renames show up immediately; file CONTENT is never served.
  router.get("/tethr/:companyId/mirror/tree", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { mirrorTree } = await import("../tethr/mirror.js");
    res.json(await mirrorTree());
  });

  // Human-modifiable file-manager ops over a synced folder (00 Tethr = "mirror",
  // or an added folder = "ext:<id>"). Agents never reach these — UI only.
  const resolveFsRoot = async (companyId: string, mount: unknown) => {
    const { resolveMountRoot } = await import("../tethr/fsdrive.js");
    return resolveMountRoot(companyId, String(mount ?? "mirror"));
  };

  router.get("/tethr/:companyId/fsdrive/list", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.query.mount);
    if (!root) {
      res.status(404).json({ error: "That drive isn't connected." });
      return;
    }
    const { listFsChildren } = await import("../tethr/fsdrive.js");
    res.json({ entries: await listFsChildren(root, req.query.path ? String(req.query.path) : "") });
  });

  router.get("/tethr/:companyId/fsdrive/read", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.query.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    const { readFsFile } = await import("../tethr/fsdrive.js");
    res.json(await readFsFile(root, String(req.query.path ?? "")));
  });

  // A PDF or image as it is, for the preview (never HTML or SVG: see RAW_TYPES).
  router.get("/tethr/:companyId/fsdrive/raw", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.query.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    const { rawFsFile } = await import("../tethr/fsdrive.js");
    const file = await rawFsFile(root, String(req.query.path ?? ""));
    if (!file) return void res.status(404).json({ error: "No preview for that file." });
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Length", String(file.size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", "inline");
    const { createReadStream } = await import("node:fs");
    createReadStream(file.abs).on("error", () => res.destroy()).pipe(res);
  });

  // Show a file in Finder (macOS `open -R`: it selects the file and never opens
  // or runs it). People only.
  router.post("/tethr/:companyId/fsdrive/reveal", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    if (process.platform !== "darwin") return void res.status(501).json({ error: "Show in Finder works on a Mac only." });
    const root = await resolveFsRoot(companyId, req.body?.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    const { existingFsPath } = await import("../tethr/fsdrive.js");
    const abs = await existingFsPath(root, String(req.body?.path ?? ""));
    if (!abs) return void res.status(404).json({ error: "That file is no longer there." });
    try {
      await execFileAsync("open", ["-R", abs], { timeout: 5000 });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/fsdrive/folder", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.body?.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    try {
      const { fsCreateFolder } = await import("../tethr/fsdrive.js");
      const path = await fsCreateFolder(root, String(req.body?.path ?? ""), String(req.body?.name ?? ""));
      res.json({ path });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/fsdrive/move", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.body?.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    try {
      const { fsMove } = await import("../tethr/fsdrive.js");
      const path = await fsMove(
        root,
        String(req.body?.from ?? ""),
        String(req.body?.toDir ?? ""),
        typeof req.body?.newName === "string" ? req.body.newName : undefined,
      );
      res.json({ path });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/tethr/:companyId/fsdrive/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const root = await resolveFsRoot(companyId, req.body?.mount);
    if (!root) return void res.status(404).json({ error: "That drive isn't connected." });
    try {
      const { fsArchive } = await import("../tethr/fsdrive.js");
      const path = await fsArchive(root, String(req.body?.path ?? ""));
      res.json({ path });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // The "other Google Drive folders" allowlist — add/list/remove folders the
  // user chooses (each validated to live under their Google Drive mount).
  router.get("/tethr/:companyId/fsdrive/mounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { listMounts, driveMountRoot } = await import("../tethr/fsdrive.js");
    res.json({ mounts: await listMounts(companyId), driveRoot: driveMountRoot() });
  });

  router.post("/tethr/:companyId/fsdrive/mounts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { addMount } = await import("../tethr/fsdrive.js");
    const result = await addMount(companyId, { label: req.body?.label, path: String(req.body?.path ?? "") });
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json({ mount: result.mount });
  });

  router.delete("/tethr/:companyId/fsdrive/mounts/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { removeMount } = await import("../tethr/fsdrive.js");
    const removed = await removeMount(companyId, req.params.id as string);
    res.json({ removed });
  });

  // One-time (idempotent) projection of already-published deliverables into
  // the shared folder. Human deletions are final — re-running does not
  // resurrect them (tracked via meta.mirror) unless ?force=true.
  router.post("/tethr/:companyId/mirror/backfill", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const mirror = await import("../tethr/mirror.js");
    if (!mirror.mirrorConfigured()) {
      res.status(400).json({
        error:
          "TETHR_MIRROR_DIR is not configured or the folder does not exist (is Google Drive mounted?)",
      });
      return;
    }
    const force = req.query.force === "true" || req.body?.force === true;
    res.json(await mirror.backfillMirror(db, companyId, { force }));
  });

  // Per-agent controls: auto/manual approvals + which overseer role gets buzzed.
  router.patch("/tethr/:companyId/agents/:agentId/profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.params.agentId as string;
    const { tethrAgentProfiles } = await import("@paperclipai/db");
    const { normalizeOverseerRole } = await import("../tethr/overseers.js");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof req.body?.autoApprove === "boolean") patch.autoApprove = req.body.autoApprove;
    if (req.body?.overseerRole !== undefined) patch.overseerRole = normalizeOverseerRole(req.body.overseerRole);
    const [updated] = await db
      .update(tethrAgentProfiles)
      .set(patch)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.agentId, agentId)))
      .returning();
    if (!updated) return void res.status(404).json({ error: "Agent not found" });
    res.json({ autoApprove: updated.autoApprove, overseerRole: updated.overseerRole });
  });

  // The overseer roster — who gets buzzed for tech / exec / growth work.
  router.get("/tethr/:companyId/overseers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { getRoster } = await import("../tethr/overseers.js");
    res.json({ roster: getRoster(companyId) });
  });

  router.put("/tethr/:companyId/overseers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { setRoster } = await import("../tethr/overseers.js");
    res.json({ roster: await setRoster(companyId, req.body?.roster ?? {}) });
  });

  // Usage throttle: the global "agents paused" switch. GET reads it; POST flips it.
  router.get("/tethr/:companyId/throttle", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { getThrottleState } = await import("../tethr/throttle.js");
    res.json(getThrottleState(companyId));
  });

  router.post("/tethr/:companyId/throttle", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { setThrottle } = await import("../tethr/throttle.js");
    const paused = Boolean(req.body?.paused);
    res.json(await setThrottle(companyId, paused, { by: actor.actorId, reason: req.body?.reason }));
  });

  // Flip the instance between live Claude and the deterministic mock at runtime.
  // In-memory (resets to the env default on restart); "live" needs a key present.
  router.post("/tethr/:companyId/llm-mode", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const mode = req.body?.mode;
    if (mode !== "live" && mode !== "mock") {
      res.status(400).json({ error: "mode must be 'live' or 'mock'" });
      return;
    }
    try {
      const effective = setTethrLlmMode(mode);
      const provider = getTethrLLMProvider();
      res.json({
        mode: effective,
        provider: provider.id,
        model: provider.model,
        liveKeyPresent: tethrLiveKeyPresent(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Seed ----------------------------------------------------------------------
  // Default: the Phase 11 clean slate (one coordinator, @tethr). The legacy
  // 12-agent org is still seedable with {"org":"growth"} — the parts bin for
  // re-adding specialists.
  // Instance admins only: seeding creates companies and agents (the growth org
  // even switches on heartbeats), so an anonymous caller on a hosted instance
  // must not reach it. A local curl in local_trusted mode is the admin.
  router.post("/tethr/seed", async (req, res) => {
    if (!isInstanceAdmin(req)) {
      res.status(403).json({ error: "Only an instance admin can seed tethr." });
      return;
    }
    if (req.body?.org === "growth") {
      const { seedWandrGrowth } = await import("../tethr/seed/seed.js");
      const result = await seedWandrGrowth(db, {
        force: req.body?.force === true,
        demo: req.body?.demo !== false,
      });
      res.json(result);
      return;
    }
    const { seedTethrCore } = await import("../tethr/seed/tethr-core.js");
    const result = await seedTethrCore(db, { force: req.body?.force === true });
    const fresh = await import("../tethr/seed/fresh-start.js");
    // Phase 18 fresh start: only @tethr by default. TETHR_SEED_SPECIALISTS=true
    // brings back the old auto-seeded specialists + growth workflows.
    let specialists: Record<string, unknown> = {};
    if (fresh.seedSpecialistsEnabled()) {
      const { seedCeoAgent } = await import("../tethr/seed/ceo.js");
      const ceo = await seedCeoAgent(db, result.companyId);
      const { seedTinkrAgent } = await import("../tethr/seed/tinkr.js");
      const tinkr = await seedTinkrAgent(db, result.companyId);
      const { seedPatchAgent } = await import("../tethr/seed/patch.js");
      const patch = await seedPatchAgent(db, result.companyId);
      const { seedFilerAgent } = await import("../tethr/seed/filer.js");
      const filer = await seedFilerAgent(db, result.companyId);
      const { seedRankAgent } = await import("../tethr/seed/rank.js");
      const rank = await seedRankAgent(db, result.companyId);
      const { seedTankAgent } = await import("../tethr/seed/tank.js");
      const tank = await seedTankAgent(db, result.companyId);
      const { seedGrowthWorkflows } = await import("../tethr/seed/growth-workflows.js");
      const growth = await seedGrowthWorkflows(db, result.companyId);
      specialists = {
        ceoAdded: ceo.created,
        tinkrAdded: tinkr.created,
        patchAdded: patch.created,
        filerAdded: filer.created,
        rankAdded: rank.created,
        tankAdded: tank.created,
        growthWorkflowsAdded: growth.created,
      };
    } else {
      const archive = await fresh.archiveSpecialistsOnce(db, result.companyId);
      specialists = { specialistsArchived: archive?.archived ?? [] };
    }
    const { backfillFactoryAgentTools } = await import("../tethr/seed/backfill-tools.js");
    const toolsHealed = await backfillFactoryAgentTools(db, result.companyId);
    res.json({ ...result, ...specialists, toolsHealed });
  });

  // ---- Fresh start (phase 18): archive / restore the specialists ---------------
  // Archive pauses the nine specialists (recoverably — never terminated), pauses
  // their routines + @tethr's weekly review, and strips @tethr's routing rows to
  // them; restore puts back exactly what the archive stashed. Humans only.
  router.get("/tethr/:companyId/specialists/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { getArchiveRecord } = await import("../tethr/seed/fresh-start.js");
    const record = getArchiveRecord(companyId);
    res.json({
      state: record?.state ?? "never",
      archivedAt: record?.archivedAt ?? null,
      restoredAt: record?.restoredAt ?? null,
      archivedTags: record?.agents.map((a) => a.tag) ?? [],
    });
  });

  router.post("/tethr/:companyId/specialists/archive", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only humans archive or restore agents" });
      return;
    }
    const { archiveSpecialists } = await import("../tethr/seed/fresh-start.js");
    const result = await archiveSpecialists(db, companyId, { by: actor.actorId });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: "tethr_specialists_archived",
      entityType: "company",
      entityId: companyId,
      details: { ...result },
    }).catch(() => {});
    res.json(result);
  });

  router.post("/tethr/:companyId/specialists/restore", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    if (actor.actorType !== "user") {
      res.status(403).json({ error: "Only humans archive or restore agents" });
      return;
    }
    const { restoreSpecialists } = await import("../tethr/seed/fresh-start.js");
    const result = await restoreSpecialists(db, companyId, { by: actor.actorId });
    if (!result.hadArchive) {
      res.status(409).json({ error: "Nothing to restore — the specialists aren't archived.", ...result });
      return;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: "tethr_specialists_restored",
      entityType: "company",
      entityId: companyId,
      details: { ...result },
    }).catch(() => {});
    res.json(result);
  });

  return router;
}
