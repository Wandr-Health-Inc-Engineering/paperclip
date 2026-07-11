import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router } from "express";
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
import { getTethrLLMProvider } from "../tethr/llm/index.js";
import { driveService } from "../tethr/drive.js";
import { gatingService } from "../tethr/gating.js";
import { memoryService } from "../tethr/memory.js";
import { notificationService } from "../tethr/notify.js";
import { orgService } from "../tethr/org.js";
import { routingService } from "../tethr/routing.js";
import {
  interpretSlackEvent,
  routeInboundKickoff,
  verifySlackSignature,
} from "../tethr/slack.js";
import { workerService } from "../tethr/worker.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

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

export function tethrRoutes(db: Db) {
  const router = Router();
  const org = orgService(db);
  const routing = routingService(db);
  const gating = gatingService(db);
  const drive = driveService(db);
  const memory = memoryService(db);
  const notify = notificationService(db);
  const worker = workerService(db);

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
    if (interp.type !== "kickoff") return;
    void routeInboundKickoff(db, interp).catch((err) =>
      logger.warn({ err }, "tethr slack inbound routing failed"),
    );
  });

  // ---- Company overview (org view) ----------------------------------------
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
      subagents,
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
      if (decision === "request_changes" && process.env.TETHR_AUTO_REVISE !== "false") {
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
    const [profiles, policies, series] = await Promise.all([
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
    ]);

    res.json({
      agents: profiles.map(({ agent, profile }) => ({
        agentId: agent.id,
        name: agent.name,
        tag: profile.tag,
        icon: agent.icon,
        budgetMonthlyCents: agent.budgetMonthlyCents,
        spentMonthlyCents: agent.spentMonthlyCents,
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
        liveKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
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
        channels: ["in_app (live)", "slack (mock)", "sms (mock)", "email (mock)"],
      },
      paperclipSha: await getPaperclipSha(),
    });
  });

  // ---- Seed ----------------------------------------------------------------------
  // Default: the Phase 11 clean slate (one coordinator, @tethr). The legacy
  // 12-agent org is still seedable with {"org":"growth"} — the parts bin for
  // re-adding specialists.
  router.post("/tethr/seed", async (req, res) => {
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
    res.json(result);
  });

  return router;
}
