import { and, count, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { getServerAdapter } from "../../adapters/registry.js";
import { runningProcesses } from "../../adapters/utils.js";
import { logActivity } from "../../services/activity-log.js";
import { budgetService } from "../../services/budgets.js";
import { costService } from "../../services/costs.js";
import * as chats from "../chats.js";
import { denyRulesFor, getIntegrations, integrationRulesText, modeFor, recordDiscoveredTools } from "../integrations.js";
import { goalsContextText, goalsService } from "../goals.js";
import { companyContextText, companyProfileService } from "../company.js";
import { mirrorDir } from "../mirror.js";
import { orgService } from "../org.js";
import { isAgentsPaused, PAUSED_MESSAGE } from "../throttle.js";
import { agentDenyRules, agentIdentityText, hasReportHeading, TEAM_TOOL_NAMES } from "../team-spec.js";
import { teamConnectorLabels, teamContextText, teamService, type TeamAgent } from "../team.js";
import { getRoster } from "../overseers.js";
import { getSetup } from "../setup.js";
import { applyStreamLine, newTurnState } from "./events.js";
import { buildSettings, ensureHookScript, issueHookToken, revokeHookToken, writeSettingsFile, type SlackReplyTarget } from "./gate.js";
import { logFailure } from "../best-effort.js";
import { ensurePersona } from "./persona.js";
import { TETHR_TOOL_DEFS, TETHR_TOOLS_LABEL } from "./tethr-tools.js";

/** Tethr tools other than the team tools (a lead without "Tethr tools" gets only the team ones). */
const NON_TEAM_TETHR_TOOLS = TETHR_TOOL_DEFS.map((d) => d.name).filter((n) => !(TEAM_TOOL_NAMES as readonly string[]).includes(n));
import { buildMcpConfig, ensureToolsBridge, removeMcpConfig, writeMcpConfig } from "./tools-bridge.js";
import { ensureWorkspace, readableRoots } from "./workspace.js";
import { renderMemoryBlock } from "../hermes/entries.js";
import { indexTurnSoon } from "../hermes/indexer.js";
import { memorySnapshot, migrateFreeformMemory } from "../hermes/memory-layer.js";
import { growthMap } from "../growth-map/evidence.js";
import { growthMapContextText } from "../growth-map/text.js";
import { ensureSandboxWorkspace, sandboxClaudeMd } from "../learn/learner.js";
import { SANDBOX_TOOLS } from "./learn-tools.js";
import { SANDBOX_BUILTINS } from "./sandbox.js";

// The chat assistant runner (phase 18). Each Chat thread drives ONE Claude Code
// session (resumed per thread) through Paperclip core's claude-local adapter
// `execute()`. One row in tethr_route_runs per turn (invocationSource "chat"):
// text streams into resultText, tool activity into hops. One turn at a time per
// thread, at most MAX_CONCURRENT turns overall. The approval gate (hooks) is
// wired through --settings; see gate.ts / policy.ts / routes POST /tethr/hooks.
//
// Phase 23: a thread can belong to an agent on tethr's team (team.ts). Its turns
// run AS that agent: its id on the run, its budget, its cost, its connector
// allowlist (deny rules), no shell, and on a fresh session its instructions.
// Agent turns use at most MAX_AGENT_CONCURRENT slots, so the chats with people
// stay responsive. When a turn tethr started in an agent's thread finishes and
// it wasn't a task (team-run.ts reports those), e.g. the follow-up after an
// approval, the agent reports back too.

type ExecuteFn = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

const MAX_CONCURRENT = 3;
const MAX_AGENT_CONCURRENT = 2;
const FLUSH_MS = 250;
const ROTATE_CONTEXT_TOKENS = 150_000;
const MEMORY_NUDGE_EVERY = 10;
const MEMORY_NUDGE =
  "Memory check: if the last few messages settled something durable (a decision, how something works, someone's preference), save it with the memory tool before you finish. Skip this if nothing did.";
const TERMINAL = new Set(["done", "failed", "stopped", "gated"]);

export interface SendInput {
  companyId: string;
  /** null = start a new thread (its id becomes the first run's id). */
  threadId: string | null;
  text: string;
  /** "system" = a turn Tethr starts (e.g. after an approval); shown as a status line. */
  kind?: "user" | "system";
  requestedByUserId?: string | null;
  /** An agent's task turn: team-run.ts waits for it and reports it itself. */
  task?: boolean;
  /** Phase 26.1: the turn came from Slack (or follows an approval asked there):
   * its answer is posted back to that Slack conversation. */
  slack?: SlackReplyTarget;
}

/** Phase 21: a one-off private turn (the watcher's idea check). The model gets
 * `prompt`; tethr's record keeps only `summary`. It neither resumes nor saves a
 * Claude session (--no-session-persistence), so what it was given (a Slack
 * conversation) isn't written anywhere. */
export interface PrivateTurnInput {
  companyId: string;
  threadId: string;
  summary: string;
  prompt: string;
}

/** Prompts of private turns waiting to run (memory only, by run id). */
const privatePrompts = new Map<string, string>();
/** Where turns that came from Slack answer (memory only, by run id). */
const slackTargets = new Map<string, SlackReplyTarget>();

/** How a turn uses its thread's Claude session. */
interface TurnStyle {
  resumesSession: boolean;
  /** Next-turn notes and the earlier-conversation recap. */
  carriesContext: boolean;
  savesSession: boolean;
  extraArgs: string[];
}
const SESSION_TURN: TurnStyle = { resumesSession: true, carriesContext: true, savesSession: true, extraArgs: [] };
const PRIVATE_TURN: TurnStyle = { resumesSession: false, carriesContext: false, savesSession: false, extraArgs: ["--no-session-persistence"] };

interface QueueState {
  threads: Map<string, string[]>;
  active: Set<string>;
  running: number;
  /** Queue keys that are agents' threads, and how many of their turns run now. */
  agentKeys: Set<string>;
  agentRunning: number;
  /** Agents' task turns (reported by team-run.ts, not here). */
  taskTurns: Set<string>;
  stopped: Set<string>;
  /** Turns dequeued but not spawned yet (Stop must still work in that window). */
  preparing: Set<string>;
}

const state: QueueState = {
  threads: new Map(),
  active: new Set(),
  running: 0,
  agentKeys: new Set(),
  agentRunning: 0,
  taskTurns: new Set(),
  stopped: new Set(),
  preparing: new Set(),
};

/** Lines of builtin tools the chat session may use (Bash only when the shell is on). */
function builtinTools(shell: "off" | "ask"): string {
  const tools = ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "ToolSearch", "TodoWrite", "WebSearch", "WebFetch", "Skill"];
  if (shell !== "off") tools.push("Bash");
  return tools.join(",");
}

export function assistantRunner(db: Db, deps: { execute?: ExecuteFn } = {}) {
  const execute: ExecuteFn = deps.execute ?? ((ctx) => getServerAdapter("claude_local").execute(ctx));
  const org = orgService(db);
  const team = teamService(db);

  /** A message to a chat thread (Mark's, or a system turn tethr starts). */
  function send(input: SendInput): Promise<{ routeRunId: string; threadId: string }> {
    return enqueue(input, null);
  }

  /** A private one-off turn (see PrivateTurnInput). Its prompt carries other
   * people's words (a Slack conversation) next to the company's memory, so the
   * thread counts as tainted from the start: an outside web page needs approval,
   * since a URL could carry that memory out. */
  async function sendPrivate(input: PrivateTurnInput): Promise<{ routeRunId: string; threadId: string }> {
    await chats.markTainted(input.companyId, input.threadId);
    return enqueue({ companyId: input.companyId, threadId: input.threadId, text: input.summary, kind: "system" }, input.prompt);
  }

  async function enqueue(input: SendInput, privatePrompt: string | null): Promise<{ routeRunId: string; threadId: string }> {
    const router = await org.getRouterProfile(input.companyId);
    const member = input.threadId ? await team.byThread(input.companyId, input.threadId) : null;
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
        agentId: member?.agentId ?? router?.agent.id ?? null,
      })
      .returning();
    const threadId = input.threadId ?? row.id;
    if (input.task) state.taskTurns.add(row.id);
    if (privatePrompt !== null) privatePrompts.set(row.id, privatePrompt);
    if (input.slack && privatePrompt === null) slackTargets.set(row.id, input.slack);
    if (!input.threadId) {
      await db.update(tethrRouteRuns).set({ threadId }).where(eq(tethrRouteRuns.id, row.id));
    }
    const key = `${input.companyId}:${threadId}`;
    if (member) state.agentKeys.add(key);
    state.threads.set(key, [...(state.threads.get(key) ?? []), row.id]);
    void pump(key);
    return { routeRunId: row.id, threadId };
  }

  /** Post a finished Slack turn's answer back to Slack (best effort). */
  async function answerInSlack(runId: string, companyId: string, threadId: string): Promise<void> {
    const target = slackTargets.get(runId);
    if (!target) return;
    slackTargets.delete(runId);
    const { deliverSlackTurn } = await import("../slack-chat.js");
    await deliverSlackTurn(db, { companyId, threadId, runId, target }).catch(logFailure("posting a chat answer to Slack", { runId }));
  }

  async function pump(key: string): Promise<void> {
    if (state.active.has(key)) return;
    const queue = state.threads.get(key) ?? [];
    if (!queue.length) return;
    if (state.running >= MAX_CONCURRENT) return; // picked up when a slot frees
    const isAgent = state.agentKeys.has(key);
    if (isAgent && state.agentRunning >= MAX_AGENT_CONCURRENT) return;
    const runId = queue.shift()!;
    state.active.add(key);
    state.running += 1;
    if (isAgent) state.agentRunning += 1;
    try {
      await runTurn(runId);
    } catch (err) {
      // Never leave a turn "running" or let one turn wedge the queue.
      await db
        .update(tethrRouteRuns)
        .set({ status: "failed", error: `Tethr hit an error: ${err instanceof Error ? err.message : String(err)}`, updatedAt: new Date() })
        .where(and(eq(tethrRouteRuns.id, runId), inArray(tethrRouteRuns.status, ["queued", "running"])))
        .catch(() => {});
    } finally {
      // However the turn ended (answered, failed, stopped, paused), a Slack asker hears.
      const [companyId, threadId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
      void answerInSlack(runId, companyId, threadId);
      state.active.delete(key);
      state.running -= 1;
      if (isAgent) state.agentRunning -= 1;
      state.taskTurns.delete(runId);
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
      ...turns.map((p) => `Them: ${p.requestText.slice(0, 400)}\nYou: ${(p.resultText ?? "").slice(0, 800)}`),
    ].join("\n\n");
  }

  /** How many messages a person has sent in this thread (the memory nudge counts them). */
  async function personTurns(threadId: string): Promise<number> {
    const [r] = await db
      .select({ n: count() })
      .from(tethrRouteRuns)
      .where(and(eq(tethrRouteRuns.threadId, threadId), eq(tethrRouteRuns.invocationSource, "chat"), isNull(tethrRouteRuns.sourceKey)));
    return Number(r?.n ?? 0);
  }

  async function runTurn(runId: string): Promise<void> {
    const [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, runId));
    if (!row || TERMINAL.has(row.status)) return;
    const companyId = row.companyId;
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
    const member = row.threadId ? await team.byThread(companyId, row.threadId) : null;
    // A paused agent does no work tethr starts; a person can still talk to it.
    if (member?.paused && row.sourceKey === "chat-system") {
      await finish(runId, { status: "done", resultText: `${member.tag} is paused, so this didn't run.`, llmProvider: "throttle" });
      return;
    }
    try {
      const block = await budgetService(db).getInvocationBlock(companyId, member?.agentId ?? router.agent.id);
      if (block) {
        await finish(runId, { status: "failed", error: `Budget: ${block.reason}` });
        return;
      }
    } catch {
      // budget lookup failure never blocks a chat turn
    }

    await finish(runId, { status: "running" });
    state.preparing.add(runId);
    try {
      await prepareAndRun(runId, row, router, member, started);
    } finally {
      state.preparing.delete(runId);
    }
  }

  async function prepareAndRun(
    runId: string,
    row: typeof tethrRouteRuns.$inferSelect,
    router: NonNullable<Awaited<ReturnType<typeof org.getRouterProfile>>>,
    member: TeamAgent | null,
    started: number,
  ): Promise<void> {
    const companyId = row.companyId;
    const threadId = row.threadId ?? row.id;
    // Who this turn runs as: an agent on the team in its own thread, else @tethr.
    const actor = member ? { id: member.agentId, name: member.name, tag: member.tag } : { id: router.agent.id, name: router.agent.name, tag: router.profile.tag };

    // Setup. Any failure here (Drive offline, a file we can't write) ends the
    // turn as failed instead of leaving it "running" forever.
    let cfg: ReturnType<typeof getIntegrations>;
    let ws: Awaited<ReturnType<typeof ensureWorkspace>>;
    let personaPath: string;
    let skillDir: string;
    let settingsPath: string;
    let bridgeScript: string | null = null;
    let tethrTools = false;
    const sandboxed = member?.sandbox === true;
    try {
      cfg = getIntegrations(companyId);
      const goals = goalsContextText(await goalsService(db).list(companyId));
      const company = companyContextText(await companyProfileService(db).get(companyId));
      // The team section needs Tethr's tools (create_agent, assign_task…).
      const teamText =
        modeFor(cfg, TETHR_TOOLS_LABEL) === "off"
          ? null
          : teamContextText(await team.list(companyId), {
              settings: cfg.team,
              timezone: getSetup(companyId).timezone,
              ownerNames: Object.fromEntries(Object.entries(getRoster(companyId)).map(([role, o]) => [role, o.name])),
            });
      // A lead always gets the tethr server, for its team tools.
      tethrTools = modeFor(cfg, TETHR_TOOLS_LABEL) !== "off" && (!member || member.lead || member.connectors.includes(TETHR_TOOLS_LABEL));
      // Phase 25: the Memory block, from Hermes (or the built-in store), every turn.
      await migrateFreeformMemory(companyId).catch(() => undefined);
      const snapshot = memorySnapshot(companyId);
      // Company-level only: CLAUDE.md is one file for every thread (see renderMemoryBlock).
      const memory = renderMemoryBlock(snapshot, { tools: modeFor(cfg, TETHR_TOOLS_LABEL) !== "off" });
      // Phase 26.9: the growth map, one line per area (company-level, like the rest).
      // It's a guide, not a requirement: if it can't be worked out, the turn runs without it.
      const growthMapText = await growthMap(db, companyId)
        .then((view) => growthMapContextText(view, { tools: modeFor(cfg, TETHR_TOOLS_LABEL) !== "off" }))
        .catch((err: unknown) => {
          logFailure("working out the growth map for a chat turn", { companyId })(err);
          return null;
        });
      // Phase 26.6: a sandboxed agent (the learner) gets its own sealed folder
      // and none of the above: no memory, no team, no goals beyond their titles.
      ws = sandboxed
        ? await ensureSandboxWorkspace(member!.tag, await sandboxClaudeMd(db, companyId))
        : await ensureWorkspace({ integrationRules: integrationRulesText(cfg), goals, company, team: teamText, memory, growthMap: growthMapText });
      ({ personaPath, skillDir } = await ensurePersona());
      const hookScript = await ensureHookScript();
      if (tethrTools) bridgeScript = await ensureToolsBridge();
      const deny = [
        ...denyRulesFor(cfg),
        ...(member ? agentDenyRules(member.connectors, teamConnectorLabels(companyId), { lead: member.lead, otherTethrTools: NON_TEAM_TETHR_TOOLS }) : []),
        ...(sandboxed ? [...TETHR_TOOL_DEFS.filter((d) => !SANDBOX_TOOLS.has(d.name)).map((d) => `mcp__tethr__${d.name}`), "Skill", "TodoWrite"] : []),
      ];
      settingsPath = await writeSettingsFile(companyId, buildSettings({ nodePath: process.execPath, hookScript, deny }), member ? `agent-${member.tag}` : undefined);
    } catch (err) {
      await finish(runId, {
        status: "failed",
        error: `Couldn't get Tethr's workspace ready: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      });
      return;
    }
    if (ws.quarantined.length) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "tethr",
        action: "tethr_workspace_quarantined",
        entityType: "tethr_route_run",
        entityId: runId,
        details: { moved: ws.quarantined },
      }).catch(() => {});
    }

    // A private turn (see PrivateTurnInput) starts fresh and leaves no session.
    const privatePrompt = privatePrompts.get(runId) ?? null;
    privatePrompts.delete(runId);
    const style = privatePrompt === null ? SESSION_TURN : PRIVATE_TURN;
    // Session: resume the thread's, unless its context has grown too big.
    let session = style.resumesSession ? chats.getSession(companyId, threadId) : null;
    let rotated = false;
    if (session && session.contextTokens > ROTATE_CONTEXT_TOKENS) {
      await chats.clearSession(companyId, threadId);
      session = null;
      rotated = true;
    }
    if (state.stopped.delete(runId)) {
      await finish(runId, { status: "stopped", resultText: "Stopped before it started." });
      return;
    }
    const notes = style.carriesContext ? await chats.takeNotes(companyId, threadId) : [];
    // Like Hermes: every 10 messages from a person, a reminder to save what's durable.
    const hasMemoryTool = modeFor(cfg, TETHR_TOOLS_LABEL) !== "off" && (!member || member.connectors.includes(TETHR_TOOLS_LABEL));
    if (style.carriesContext && hasMemoryTool && row.sourceKey === null && (await personTurns(threadId)) % MEMORY_NUDGE_EVERY === 0) {
      notes.push(MEMORY_NUDGE);
    }
    const context = !session && style.carriesContext ? await legacyContext(companyId, threadId, runId) : "";
    const ask = privatePrompt ?? row.requestText;
    // An agent's fresh session learns who it is (a task turn carries that itself).
    const identity = member && !session && row.sourceKey !== "chat-system" ? agentIdentityText(member) : "";
    const prompt = [
      identity,
      notes.length ? `Notes from Tethr:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
      rotated ? "(This conversation continues from an earlier session that got long.)" : "",
      context,
      row.sourceKey === "chat-system" ? `[From Tethr, not the user] ${ask}` : ask,
    ]
      .filter(Boolean)
      .join("\n\n");

    const slackTarget = slackTargets.get(runId);
    const token = issueHookToken({
      companyId,
      threadId,
      runId,
      ...(style === PRIVATE_TURN ? { privateTurn: true } : {}),
      ...(slackTarget ? { slack: slackTarget } : {}),
    });
    // Tethr's own tools (score_list, keyword_ideas) as the MCP server "tethr".
    // Best-effort: without it the turn still runs, just without those tools.
    let mcpConfigPath: string | null = null;
    if (bridgeScript) {
      const url = process.env.TETHR_HOOK_URL || process.env.PAPERCLIP_API_URL || "http://localhost:3100";
      mcpConfigPath = await writeMcpConfig(runId, buildMcpConfig({ nodePath: process.execPath, bridgeScript, token, url })).catch(() => null);
    }
    const mirror = mirrorDir();
    const turn = newTurnState();
    const eventCtx = {
      policy: { workspaceDir: ws.dir, readableRoots: sandboxed ? [ws.dir] : readableRoots(), internalAddresses: cfg.internalAddresses },
      mirrorRoot: mirror,
    };

    let dirty = false;
    let lastFlush = 0;
    let flushTimer: NodeJS.Timeout | null = null;
    let flushing: Promise<void> = Promise.resolve();
    const flush = () => {
      flushTimer = null;
      if (!dirty) return flushing;
      dirty = false;
      lastFlush = Date.now();
      // Chained, so writes land in order and the final write can wait for them.
      flushing = flushing.then(() => finish(runId, { resultText: turn.text, hops: turn.hops })).catch(() => {});
      return flushing;
    };
    const scheduleFlush = () => {
      dirty = true;
      if (flushTimer) return;
      const wait = Math.max(0, FLUSH_MS - (Date.now() - lastFlush));
      flushTimer = setTimeout(() => void flush(), wait);
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
          id: actor.id,
          companyId,
          name: actor.name,
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
            ...style.extraArgs,
            ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
            "--settings",
            settingsPath,
            "--permission-mode",
            "dontAsk",
            "--include-partial-messages",
            "--tools",
            sandboxed ? SANDBOX_BUILTINS.join(",") : builtinTools(member ? "off" : cfg.shell),
            // The sealed folder sees nothing else: not the shared Drive, not the user's own CLAUDE.md or skills.
            ...(sandboxed ? ["--setting-sources", "project"] : mirror && !ws.dir.startsWith(mirror) ? ["--add-dir", mirror] : []),
          ],
        },
        context: { tethrPrompt: prompt },
        onLog,
      });
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    } finally {
      revokeHookToken(token);
      void removeMcpConfig(mcpConfigPath);
      if (flushTimer) clearTimeout(flushTimer);
      if (stdoutBuf) applyStreamLine(turn, stdoutBuf, eventCtx);
      // A partial write already on its way must land BEFORE the final one.
      await flushing;
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

    // Session bookkeeping (a private turn keeps none).
    if (result && style.savesSession) {
      if (result.clearSession) {
        await chats.clearSession(companyId, threadId);
      } else if (result.sessionParams || result.sessionId || turn.sessionId) {
        // The context size is the LAST model call's prompt (the result's usage
        // is summed over every call in the turn, so it overstates it badly).
        await chats.setSession(companyId, threadId, {
          sessionId: result.sessionId ?? turn.sessionId,
          sessionParams: result.sessionParams ?? null,
          lastTurnAt: new Date().toISOString(),
          contextTokens: turn.contextTokens ?? session?.contextTokens ?? 0,
        });
      }
    }
    void recordDiscoveredTools(companyId, [...turn.toolNames]).catch(() => {});
    // Phase 25: the finished turn goes into Hermes, so recall can find it later.
    if (style.savesSession && status === "done") indexTurnSoon(db, runId, companyId);

    // Spend: subscription turns record tokens at 0¢; API-key turns record their cost.
    if (result?.usage) {
      const subscription = String(result.billingType ?? "").startsWith("subscription");
      await costService(db)
        .createEvent(companyId, {
          heartbeatRunId: null,
          agentId: actor.id,
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
      actorId: actor.tag,
      action: "tethr_chat_turn",
      entityType: "tethr_route_run",
      entityId: runId,
      details: { threadId, status, tools: turn.hops.length, durationMs: Date.now() - started },
    }).catch(() => {});

    // An agent's turn that tethr started and that isn't a task (team-run.ts
    // reports those), e.g. the follow-up after an approval: report it back too.
    // A lead woken by its sub-team reports only when it wrote a "Report:"; an
    // approval follow-up always says how it went.
    const firstLine = row.requestText.split("\n")[0]!.trim();
    const approved = /^Approved:\s*/i.test(firstLine);
    const worthReporting = approved || hasReportHeading(text) || status !== "done";
    if (member && row.sourceKey === "chat-system" && !state.taskTurns.has(runId) && status !== "stopped" && worthReporting) {
      const { deliverAgentReport } = await import("../team-report.js");
      // A lead woken by a sub-agent's report has an update for tethr, not a finished task.
      const fromSub = firstLine.match(/^Report from (@[\w-]+): (.+)$/);
      const title = approved
        ? `${firstLine.replace(/^Approved:\s*/i, "")} (after your approval)`
        : fromSub
          ? `${fromSub[2]} (from ${fromSub[1]})`
          : firstLine;
      await deliverAgentReport(db, {
        companyId,
        agent: member,
        title: title.slice(0, 200),
        outcome: status !== "done" ? "failed" : approved ? "done" : "update",
        text: text || error || "",
        runId,
      }).catch(() => {});
    }
  }

  /** Stop a queued, starting or running turn. */
  async function stop(runId: string): Promise<boolean> {
    for (const [key, queue] of state.threads) {
      const idx = queue.indexOf(runId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        state.threads.set(key, queue);
        privatePrompts.delete(runId);
        await finish(runId, { status: "stopped", resultText: "Stopped before it started." });
        void answerInSlack(runId, key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1));
        return true;
      }
    }
    const proc = runningProcesses.get(runId);
    if (!proc) {
      // Dequeued but not spawned yet: it checks this flag right before starting.
      if (!state.preparing.has(runId)) return false;
      state.stopped.add(runId);
      return true;
    }
    state.stopped.add(runId);
    try {
      if (proc.processGroupId) process.kill(-proc.processGroupId, "SIGTERM");
      else proc.child.kill("SIGTERM");
    } catch {
      proc.child.kill("SIGTERM");
    }
    return true;
  }

  return { send, sendPrivate, stop };
}

let singleton: ReturnType<typeof assistantRunner> | null = null;

/** One runner per process (its queues are process-wide). */
export function getAssistantRunner(db: Db) {
  if (!singleton) singleton = assistantRunner(db);
  return singleton;
}

/** Tests only: make getAssistantRunner() return this runner (e.g. one with a fake execute). */
export function setAssistantRunnerForTests(runner: ReturnType<typeof assistantRunner> | null) {
  singleton = runner;
}

/** Tests only. */
export function resetAssistantRunnerForTests() {
  singleton = null;
  state.threads.clear();
  state.active.clear();
  state.running = 0;
  state.stopped.clear();
  state.preparing.clear();
}
