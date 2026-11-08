import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { getServerAdapter } from "../../adapters/registry.js";
import { runningProcesses } from "../../adapters/utils.js";
import { logActivity } from "../../services/activity-log.js";
import { budgetService } from "../../services/budgets.js";
import { costService } from "../../services/costs.js";
import * as chats from "../chats.js";
import { denyRulesFor, getIntegrations, integrationRulesText, recordDiscoveredTools } from "../integrations.js";
import { mirrorDir } from "../mirror.js";
import { orgService } from "../org.js";
import { isAgentsPaused, PAUSED_MESSAGE } from "../throttle.js";
import { applyStreamLine, newTurnState } from "./events.js";
import { buildSettings, ensureHookScript, issueHookToken, revokeHookToken, writeSettingsFile } from "./gate.js";
import { ensurePersona } from "./persona.js";
import { ensureWorkspace, readableRoots } from "./workspace.js";

// The chat assistant runner (phase 18). Each Chat thread drives ONE Claude Code
// session (resumed per thread) through Paperclip core's claude-local adapter
// `execute()`. One row in tethr_route_runs per turn (invocationSource "chat"):
// text streams into resultText, tool activity into hops. One turn at a time per
// thread, at most MAX_CONCURRENT turns overall. The approval gate (hooks) is
// wired through --settings; see gate.ts / policy.ts / routes POST /tethr/hooks.

type ExecuteFn = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const MAX_CONCURRENT = 2;
const FLUSH_MS = 250;
const ROTATE_CONTEXT_TOKENS = 150_000;
const TERMINAL = new Set(["done", "failed", "stopped", "gated"]);

export interface SendInput {
  companyId: string;
  /** null = start a new thread (its id becomes the first run's id). */
  threadId: string | null;
  text: string;
  /** "system" = a turn Tethr starts (e.g. after an approval); shown as a status line. */
  kind?: "user" | "system";
  requestedByUserId?: string | null;
}

interface QueueState {
  threads: Map<string, string[]>;
  active: Set<string>;
  running: number;
  stopped: Set<string>;
}

const state: QueueState = { threads: new Map(), active: new Set(), running: 0, stopped: new Set() };

/** Lines of builtin tools the chat session may use (Bash only when the shell is on). */
function builtinTools(shell: "off" | "ask"): string {
  const tools = ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "ToolSearch", "TodoWrite", "WebSearch", "WebFetch", "Skill"];
  if (shell !== "off") tools.push("Bash");
  return tools.join(",");
}

export function assistantRunner(db: Db, deps: { execute?: ExecuteFn } = {}) {
  const execute: ExecuteFn = deps.execute ?? ((ctx) => getServerAdapter("claude_local").execute(ctx));
  const org = orgService(db);

  async function send(input: SendInput): Promise<{ routeRunId: string; threadId: string }> {
    const router = await org.getRouterProfile(input.companyId);
    const [row] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId: input.companyId,
        requestText: input.text,
        requestedByUserId: input.requestedByUserId ?? null,
        invocationSource: "chat",
        threadId: input.threadId,
        sourceKey: input.kind === "system" ? "chat-system" : null,
        status: "queued",
        hops: [],
        agentId: router?.agent.id ?? null,
      })
      .returning();
    const threadId = input.threadId ?? row.id;
    if (!input.threadId) {
      await db.update(tethrRouteRuns).set({ threadId }).where(eq(tethrRouteRuns.id, row.id));
    }
    const key = `${input.companyId}:${threadId}`;
    state.threads.set(key, [...(state.threads.get(key) ?? []), row.id]);
    void pump(key);
    return { routeRunId: row.id, threadId };
  }

  async function pump(key: string): Promise<void> {
    if (state.active.has(key)) return;
    const queue = state.threads.get(key) ?? [];
    if (!queue.length) return;
    if (state.running >= MAX_CONCURRENT) return; // picked up when a slot frees
    const runId = queue.shift()!;
    state.active.add(key);
    state.running += 1;
    try {
      await runTurn(runId);
    } catch {
      // runTurn records its own failures; never let one turn wedge the queue
    } finally {
      state.active.delete(key);
      state.running -= 1;
      void pump(key);
      for (const other of state.threads.keys()) if (other !== key) void pump(other);
    }
  }

  async function finish(runId: string, patch: Partial<typeof tethrRouteRuns.$inferInsert>) {
    await db
      .update(tethrRouteRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(tethrRouteRuns.id, runId));
  }

  async function legacyContext(companyId: string, threadId: string, excludeRunId: string): Promise<string> {
    const previous = await db
      .select()
      .from(tethrRouteRuns)
      .where(
        and(
          eq(tethrRouteRuns.companyId, companyId),
          eq(tethrRouteRuns.threadId, threadId),
          ne(tethrRouteRuns.id, excludeRunId),
        ),
      )
      .orderBy(desc(tethrRouteRuns.createdAt))
      .limit(5);
    const turns = previous.filter((p) => p.resultText).reverse();
    if (!turns.length) return "";
    return [
      "Earlier in this conversation (for context):",
      ...turns.map((p) => `Mark: ${p.requestText.slice(0, 400)}\nYou: ${(p.resultText ?? "").slice(0, 800)}`),
    ].join("\n\n");
  }

  async function runTurn(runId: string): Promise<void> {
    const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
    if (!row || TERMINAL.has(row.status)) return;
    const companyId = row.companyId;
    const threadId = row.threadId ?? row.id;
    const started = Date.now();

    if (state.stopped.has(runId)) {
      state.stopped.delete(runId);
      await finish(runId, { status: "stopped", resultText: "Stopped before it started." });
      return;
    }
    if (isAgentsPaused(companyId)) {
      await finish(runId, { status: "done", resultText: PAUSED_MESSAGE, llmProvider: "throttle" });
      return;
    }
    const router = await org.getRouterProfile(companyId);
    if (!router) {
      await finish(runId, { status: "failed", error: "No @tethr agent in this company." });
      return;
    }
    try {
      const block = await budgetService(db).getInvocationBlock(companyId, router.agent.id);
      if (block) {
        await finish(runId, { status: "failed", error: `Budget: ${block.reason}` });
        return;
      }
    } catch {
      // budget lookup failure never blocks a chat turn
    }

    await finish(runId, { status: "running" });

    const cfg = getIntegrations(companyId);
    const ws = await ensureWorkspace({ integrationRules: integrationRulesText(cfg) });
    const { personaPath, skillDir } = await ensurePersona();
    const hookScript = await ensureHookScript();
    const settingsPath = await writeSettingsFile(
      companyId,
      buildSettings({ nodePath: process.execPath, hookScript, deny: denyRulesFor(cfg) }),
    );

    // Session: resume the thread's, unless its context has grown too big.
    let session = chats.getSession(companyId, threadId);
    let rotated = false;
    if (session && session.contextTokens > ROTATE_CONTEXT_TOKENS) {
      await chats.clearSession(companyId, threadId);
      session = null;
      rotated = true;
    }
    const notes = await chats.takeNotes(companyId, threadId);
    const context = !session ? await legacyContext(companyId, threadId, runId) : "";
    const prompt = [
      notes.length ? `Notes from Tethr:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
      rotated ? "(This conversation continues from an earlier session that got long.)" : "",
      context,
      row.sourceKey === "chat-system" ? `[From Tethr, not Mark] ${row.requestText}` : row.requestText,
    ]
      .filter(Boolean)
      .join("\n\n");

    const token = issueHookToken({ companyId, threadId, runId });
    const mirror = mirrorDir();
    const turn = newTurnState();
    const eventCtx = {
      policy: { workspaceDir: ws.dir, readableRoots: readableRoots(), internalAddresses: cfg.internalAddresses },
      mirrorRoot: mirror,
    };

    let dirty = false;
    let lastFlush = 0;
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = async () => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      lastFlush = Date.now();
      await finish(runId, { resultText: turn.text, hops: turn.hops });
    };
    const scheduleFlush = () => {
      dirty = true;
      if (flushTimer) return;
      const wait = Math.max(0, FLUSH_MS - (Date.now() - lastFlush));
      flushTimer = setTimeout(() => void flush().catch(() => {}), wait);
    };

    let stdoutBuf = "";
    const onLog: AdapterExecutionContext["onLog"] = async (stream, chunk) => {
      if (stream !== "stdout") return;
      stdoutBuf += chunk;
      let i: number;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (applyStreamLine(turn, line, eventCtx)) scheduleFlush();
      }
    };

    let result: AdapterExecutionResult | null = null;
    let crash: string | null = null;
    try {
      result = await execute({
        runId,
        agent: {
          id: router.agent.id,
          companyId,
          name: router.agent.name,
          adapterType: "claude_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: session?.sessionId ?? null,
          sessionParams: session?.sessionParams ?? null,
          sessionDisplayId: null,
          taskKey: `tethr-chat:${threadId}`,
        },
        config: {
          command: process.env.TETHR_CLAUDE_CODE_BIN || "claude",
          cwd: ws.dir,
          model: cfg.assistant.model,
          instructionsFilePath: personaPath,
          promptTemplate: "{{context.tethrPrompt}}",
          dangerouslySkipPermissions: false,
          maxTurnsPerRun: 40,
          timeoutSec: 900,
          graceSec: 10,
          paperclipRuntimeSkills: [{ key: "tethr", runtimeName: "tethr", source: skillDir, required: true }],
          env: {
            TETHR_HOOK_TOKEN: token,
            // Wait for the claude.ai connectors to connect before the prompt is processed.
            // Without this, a RESUMED turn starts before they reconnect, Claude Code tells
            // the model their tools were "removed", and it reports the connector as down
            // (spike finding, tasks/phase-18-0-spike.md). Costs ~2s of startup per turn.
            MCP_CONNECTION_NONBLOCKING: "false",
            // Bill the chat to Mark's Claude subscription (the CLI's own login), not an
            // ANTHROPIC_API_KEY left in the instance .env for the old API backend. An empty
            // value makes the CLI ignore it. Opt out with TETHR_ASSISTANT_BILLING=api.
            ...(process.env.TETHR_ASSISTANT_BILLING === "api" ? {} : { ANTHROPIC_API_KEY: "" }),
          },
          extraArgs: [
            "--settings",
            settingsPath,
            "--permission-mode",
            "dontAsk",
            "--include-partial-messages",
            "--tools",
            builtinTools(cfg.shell),
            ...(mirror && !ws.dir.startsWith(mirror) ? ["--add-dir", mirror] : []),
          ],
        },
        context: { tethrPrompt: prompt },
        onLog,
      });
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    } finally {
      revokeHookToken(token);
      if (flushTimer) clearTimeout(flushTimer);
      if (stdoutBuf) applyStreamLine(turn, stdoutBuf, eventCtx);
    }

    const stopped = state.stopped.delete(runId);
    const text = turn.text || result?.summary || "";
    let status: "done" | "failed" | "stopped" = "done";
    let error: string | null = null;
    if (stopped) {
      status = "stopped";
    } else if (crash) {
      status = "failed";
      error = crash;
    } else if (result) {
      const badExit = (result.exitCode ?? 0) !== 0 && !text;
      if (result.timedOut || result.errorMessage || turn.resultIsError || badExit) {
        status = "failed";
        error =
          result.errorCode === "claude_auth_required"
            ? "Claude needs you to log in again: open Terminal and run `claude login`."
            : result.timedOut
              ? "This took longer than 15 minutes and was stopped."
              : result.errorMessage || turn.resultText || "Claude stopped with an error.";
      }
    }
    for (const hop of turn.hops) if (hop.status === "running") hop.status = status === "done" ? "ok" : "failed";

    await finish(runId, {
      status,
      resultText: text,
      hops: turn.hops,
      error,
      llmProvider: `claude-code:${result?.model ?? cfg.assistant.model}`,
      durationMs: Date.now() - started,
    });

    // Session bookkeeping.
    if (result) {
      if (result.clearSession) {
        await chats.clearSession(companyId, threadId);
      } else if (result.sessionParams || result.sessionId || turn.sessionId) {
        const usage = result.usage;
        await chats.setSession(companyId, threadId, {
          sessionId: result.sessionId ?? turn.sessionId,
          sessionParams: result.sessionParams ?? null,
          lastTurnAt: new Date().toISOString(),
          contextTokens: (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0),
        });
      }
    }
    void recordDiscoveredTools(companyId, [...turn.toolNames]).catch(() => {});

    // Spend: subscription turns record tokens at 0¢; API-key turns record their cost.
    if (result?.usage) {
      const subscription = String(result.billingType ?? "").startsWith("subscription");
      await costService(db)
        .createEvent(companyId, {
          heartbeatRunId: null,
          agentId: router.agent.id,
          provider: result.provider ?? "anthropic",
          biller: result.biller ?? "anthropic",
          billingType: result.billingType ?? "unknown",
          model: result.model ?? cfg.assistant.model,
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: result.usage.cachedInputTokens ?? 0,
          outputTokens: result.usage.outputTokens,
          costCents: subscription ? 0 : Math.round((result.costUsd ?? 0) * 100),
          occurredAt: new Date(),
        })
        .catch(() => {});
    }
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: router.profile.tag,
      action: "tethr_chat_turn",
      entityType: "tethr_route_run",
      entityId: runId,
      details: { threadId, status, tools: turn.hops.length, durationMs: Date.now() - started },
    }).catch(() => {});
  }

  /** Stop a queued or running turn. */
  async function stop(runId: string): Promise<boolean> {
    for (const [key, queue] of state.threads) {
      const idx = queue.indexOf(runId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        state.threads.set(key, queue);
        await finish(runId, { status: "stopped", resultText: "Stopped before it started." });
        return true;
      }
    }
    const proc = runningProcesses.get(runId);
    if (!proc) return false;
    state.stopped.add(runId);
    try {
      if (proc.processGroupId) process.kill(-proc.processGroupId, "SIGTERM");
      else proc.child.kill("SIGTERM");
    } catch {
      proc.child.kill("SIGTERM");
    }
    return true;
  }

  return { send, stop };
}

let singleton: ReturnType<typeof assistantRunner> | null = null;

/** One runner per process (its queues are process-wide). */
export function getAssistantRunner(db: Db) {
  if (!singleton) singleton = assistantRunner(db);
  return singleton;
}

/** Tests only. */
export function resetAssistantRunnerForTests() {
  singleton = null;
  state.threads.clear();
  state.active.clear();
  state.running = 0;
  state.stopped.clear();
}
