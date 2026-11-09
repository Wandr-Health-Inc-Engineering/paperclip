import type { QueryClient } from "@tanstack/react-query";
import { api } from "./client";

// Tethr add-on API surface. Self-contained (types + calls + query keys) so
// the core api/ modules stay untouched.

export interface TethrDivision {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: "active" | "shell";
  headAgentId: string | null;
  icon: string | null;
  sortOrder: number;
}

export interface TethrRoutingEntry {
  when: string[];
  to: string;
  description?: string;
}

export interface TethrProfile {
  id: string;
  agentId: string;
  divisionId: string | null;
  tag: string;
  codename: string;
  mission: string | null;
  approvalGate: string;
  autoApprove: boolean;
  overseerRole: "tech" | "exec" | "growth";
  heartbeatCron: string | null;
  heartbeatNote: string | null;
  portPriority: number | null;
  routingTable: TethrRoutingEntry[];
  standingRules: string[];
}

export type TethrOverseerRole = "tech" | "exec" | "growth";
export interface TethrOverseerPerson {
  name: string;
  slackId: string;
}
export type TethrOverseerRoster = Record<TethrOverseerRole, TethrOverseerPerson>;

export interface TethrSubagentSummary {
  id: string;
  key: string;
  tag: string;
  name: string;
  job: string;
  sensitivity: string;
  lastRunAt: string | null;
}

export interface TethrSubagent extends TethrSubagentSummary {
  routeWhen: string[];
  notHere: Array<{ phrase: string; to: string }>;
  reads: string[];
  steps: string[];
  output: string | null;
  guardrails: string[];
  doneWhen: string | null;
  escalation: string | null;
  status: string;
  /** The resolved toolset ("skills") this subagent can actually use at run time. */
  effectiveTools?: Array<{ name: string; description: string }>;
}

export interface TethrOverviewAgent {
  agent: {
    id: string;
    name: string;
    title: string | null;
    icon: string | null;
    status: string;
    reportsTo: string | null;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
    pauseReason: string | null;
  };
  profile: TethrProfile;
  pendingApprovals: number;
  lastRunAt: string | null;
  subagents: TethrSubagentSummary[];
}

export interface TethrOverview {
  divisions: TethrDivision[];
  agents: TethrOverviewAgent[];
}

export interface TethrRouteHop {
  layer: "helm" | "agent" | "subagent" | "tool";
  actorTag: string;
  decision: string;
  reason: string;
  at: string;
  // Phase 18 chat turns: raw tool name, call id, outcome, and file path (relative to 00 Tethr).
  tool?: string;
  toolUseId?: string;
  status?: "running" | "ok" | "failed" | "blocked";
  file?: string;
}

export interface TethrRouteResult {
  routeRunId: string;
  threadId: string;
  status: string;
  hops: TethrRouteHop[];
  resultText: string;
  outputs: Array<{
    outputId: string;
    title: string;
    status: string;
    gated: boolean;
  }>;
  usage: { inputTokens: number; outputTokens: number };
  llmProvider: string;
  durationMs: number;
}

export interface TethrRouteRun {
  id: string;
  requestText: string;
  requestedByUserId: string | null;
  invocationSource: string;
  /** "chat-system" marks a turn Tethr started (e.g. after an approval). */
  sourceKey?: string | null;
  threadId: string | null;
  /** Who ran it (phase 23: a team agent's turns and reports carry its id). */
  agentId?: string | null;
  status: string;
  hops: TethrRouteHop[];
  resultText: string | null;
  error: string | null;
  llmProvider: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface TethrRouteRunDetail extends TethrRouteRun {
  outputs: Array<{
    id: string;
    title: string;
    status: string;
    sensitivity: string;
    kind: string;
  }>;
}

/** An output as the chat renders it (the full row: body + meta included). */
export interface TethrChatOutput {
  id: string;
  title: string;
  status: string;
  sensitivity: string;
  kind: string;
  body: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

/** One message exchange in a chat: the request, how it routed, and what came back. */
export interface TethrChatRun extends TethrRouteRun {
  outputs: TethrChatOutput[];
  /** Files attached to this message (phase 19.1). */
  attachments?: TethrChatAttachment[];
  /** An idea card's idea (phase 21): for the Useful / Not now buttons. */
  idea?: { id: string; status: TethrIdeaStatus; source: string } | null;
}

export type TethrIdeaStatus = "new" | "useful" | "not_now" | "answered" | "ignored";
export interface TethrIdea {
  id: string;
  source: "slack" | "goals" | "quiet";
  origin: string;
  title: string;
  body: string;
  status: TethrIdeaStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TethrMetricPoint {
  at: string;
  value: number;
  note?: string;
}

export interface TethrMetric {
  id: string;
  goalId: string;
  name: string;
  unit: "count" | "usd" | "percent" | "number";
  direction: "up" | "down";
  source: string;
  method: string;
  baseline: number | null;
  baselineAt: string | null;
  target: number | null;
  targetDate: string | null;
  current: number | null;
  currentAt: string | null;
  history: TethrMetricPoint[];
  /** Targets tethr moved on its own to keep the goal realistic (phase 21). */
  adjustments?: Array<{ at: string; from: number; to: number; why: string }>;
}

export interface TethrGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
  parentId: string | null;
  metrics: TethrMetric[];
}

export interface TethrGoalsView {
  company: Omit<TethrGoal, "metrics"> | null;
  goals: TethrGoal[];
}

export type TethrRhythmKey = "plan" | "scorecard" | "brief";
export interface TethrRhythmChoice {
  enabled: boolean;
  cron: string;
  slack: boolean;
  routineId?: string;
}

export type TethrSetupStepKey = "company" | "focus" | "connect" | "interview" | "rhythm";
export type TethrGrowthPace = "steady" | "balanced" | "ambitious";
export type TethrIdeasLevel = "light" | "normal" | "busy";

export interface TethrSetupState {
  steps: Partial<Record<TethrSetupStepKey, string>>;
  completedAt: string | null;
  areas: string[];
  timezone: string;
  rhythm: Record<TethrRhythmKey, TethrRhythmChoice>;
  interviewThreadId: string | null;
  growthPace: TethrGrowthPace;
  autoAdjust: boolean;
  ideas: { level: TethrIdeasLevel; adaptive: boolean; slackListen: boolean };
}

export interface TethrSetupCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  href: string;
  optional?: boolean;
}

export interface TethrMember {
  id: string;
  name: string;
  email: string | null;
  position: string;
  title: string;
  role: "admin" | "member";
  status: "active" | "invited";
  slackUserId: string | null;
}

export interface TethrCompanyProfile {
  id: string;
  name: string;
  sells: string;
  prefix: string;
  mission: string;
  admin: TethrMember | null;
  members: TethrMember[];
}

export interface TethrSetup {
  state: TethrSetupState;
  checks: TethrSetupCheck[];
  goals: TethrGoalsView;
  rhythms: Record<TethrRhythmKey, { title: string; label: string; playbook: string }>;
  profile: TethrCompanyProfile | null;
  mission: string;
  positions: Array<{ key: string; title: string; focus: string }>;
  growthPaces: Array<{ key: TethrGrowthPace; label: string; uplift: number }>;
  ideasLevels: Array<{ key: TethrIdeasLevel; label: string; blurb: string }>;
  ideasPace: { allowance: number; now: string; recent: Array<{ at: string; outcome: string }> };
}

export interface TethrEnvEntry {
  key: string;
  set: boolean;
  length: number;
  secret: boolean;
  /** The server itself depends on it (database, login, ports). */
  core: boolean;
  /** Spans several lines in the file: edit it there. */
  multiline: boolean;
  /** The running server uses the file's value. */
  active: boolean;
}

export interface TethrEnv {
  path: string;
  exists: boolean;
  entries: TethrEnvEntry[];
  /** Settings tethr knows about that aren't in the file yet. */
  suggestions: Array<{ key: string; description: string }>;
}

export interface TethrChatAttachment {
  /** Workspace-relative path ("files/uploads/2026-11-07/report.pdf"). */
  path: string;
  name: string;
  kind: "image" | "pdf" | "office" | "text";
  /** Where the side panel opens it (relative to 00 Tethr), or null. */
  panelPath: string | null;
  size?: number;
}

export interface TethrSideChat {
  threadId: string;
  title: string;
  createdAt: string;
  runCount: number;
  lastAt: string;
}

export interface TethrChats {
  /** The ongoing main chat with @tethr (its thread id is the company id). */
  mainThreadId: string;
  main: { runCount: number; lastAt: string | null };
  sideChats: TethrSideChat[];
}

export type TethrConnectorMode = "off" | "read" | "ask" | "auto";

export interface TethrIntegrationConnector {
  label: string;
  mode: TethrConnectorMode;
  /** false when the connector just follows the default mode. */
  explicit: boolean;
  scope: string;
  blurb: string;
  scopeHint: string | null;
  toolsKnown: number;
  toolsSeen: number;
  /** Mercury: never Auto. */
  moneyOnly: boolean;
}

/** Phase 23: how tethr may grow its team. */
export interface TethrTeamSettings {
  newAgents: "ask" | "auto";
  maxAgents: number;
  monthlyBudgetUsd: number;
  /** Phase 24: what tethr does on its own (all off by default). */
  autonomy: TethrTeamAutonomy;
}

export interface TethrTeamAutonomy {
  actOnReports: boolean;
  dailyReview: { enabled: boolean; time: string; weekdaysOnly: boolean };
  maxSelfTurnsPerDay: number;
}

export interface TethrIntegrations {
  defaultMode: TethrConnectorMode;
  internalAddresses: string[];
  shell: "off" | "ask";
  assistant: { engine: "session" | "routing"; model: string };
  team: TethrTeamSettings;
  workspace: { dir: string; inDrive: boolean };
  connectors: TethrIntegrationConnector[];
  discoveredAt: string | null;
}

export interface TethrIntegrationsPatch {
  defaultMode?: TethrConnectorMode;
  connectors?: Record<string, { mode: TethrConnectorMode; scope?: string }>;
  internalAddresses?: string[];
  shell?: "off" | "ask";
  assistant?: { engine?: "session" | "routing"; model?: string };
  team?: Partial<Omit<TethrTeamSettings, "autonomy">> & {
    autonomy?: Partial<Omit<TethrTeamAutonomy, "dailyReview">> & { dailyReview?: Partial<TethrTeamAutonomy["dailyReview"]> };
  };
}

/** Phase 23: an agent on tethr's team, with what it's doing right now. */
export interface TethrTeamAgent {
  agentId: string;
  tag: string;
  name: string;
  title: string;
  mission: string;
  paused: boolean;
  /** Its own chat (open with ?chat=<threadId>). */
  threadId: string;
  /** Phase 24: runs a sub-team of its own. */
  lead: boolean;
  /** For a sub-agent: its lead. */
  leadTag: string | null;
  /** A lead's sub-agents. */
  subTeam: string[];
  goal: { id: string; title: string | null } | null;
  connectors: string[];
  schedule: { cron: string; brief: string; words: string } | null;
  ownerRole: "tech" | "exec" | "growth";
  ownerName: string | null;
  maxRunsPerDay: number;
  runsToday: number;
  openTasks: number;
  running: boolean;
  waitingOnYou: number;
  lastReportAt: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
}

export interface TethrTeam {
  settings: TethrTeamSettings;
  agents: TethrTeamAgent[];
}

export interface TethrOutputListItem {
  id: string;
  agentId: string;
  subagentId: string | null;
  subagentTag: string | null;
  subagentName: string | null;
  kind: string;
  title: string;
  preview: string;
  sensitivity: string;
  status: string;
  approvalId: string | null;
  publishedAt: string | null;
  createdAt: string;
  meta: Record<string, unknown>;
}

export interface TethrOutputDetail {
  output: {
    id: string;
    agentId: string;
    kind: string;
    title: string;
    body: string;
    sensitivity: string;
    status: string;
    approvalId: string | null;
    driveNodeId: string | null;
    publishedAt: string | null;
    createdAt: string;
    meta: Record<string, unknown>;
  };
  approval: {
    id: string;
    status: string;
    decisionNote: string | null;
    decidedByUserId: string | null;
    decidedAt: string | null;
    createdAt: string;
  } | null;
  subagent: TethrSubagent | null;
  revisions: Array<{
    id: string;
    title: string;
    status: string;
    revisionNumber: number;
    revisionOfId: string | null;
    createdAt: string;
  }>;
}

export interface TethrDriveNode {
  id: string;
  parentId: string | null;
  kind: "folder" | "file";
  name: string;
  path: string;
  contentType: string | null;
  currentVersionId: string | null;
  permissions: { owner: string; read: string[]; write: string[] };
  tags: string[];
  byteSize: number | null;
  createdByTag: string | null;
  updatedAt: string;
}

export interface TethrDriveVersion {
  id: string;
  versionNumber: number;
  byteSize: number;
  sha256: string | null;
  contentType: string | null;
  note: string | null;
  createdByTag: string | null;
  createdAt: string;
}

export interface TethrSchedule {
  routineId: string;
  title: string;
  description: string | null;
  status: string;
  agentId: string | null;
  agentTag: string | null;
  cron: string | null;
  timezone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
}

export interface TethrRunRow {
  id: string;
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  agentTag: string | null;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  stdoutExcerpt: string | null;
}

export interface TethrBudgets {
  agents: Array<{
    agentId: string;
    name: string;
    tag: string;
    icon: string | null;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
    approvalGate: string;
    policy: {
      id: string;
      amount: number;
      warnPercent: number;
      hardStopEnabled: boolean;
    } | null;
  }>;
  companyPolicy: { amount: number; warnPercent: number } | null;
  series: Array<{ agentId: string; day: string; costCents: number }>;
}

export interface TethrAuditEvent {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface TethrNotification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  agentTag: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TethrAgentDetail {
  agent: {
    id: string;
    name: string;
    title: string | null;
    icon: string | null;
    status: string;
    adapterType: string;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
    pauseReason: string | null;
    lastHeartbeatAt: string | null;
  };
  profile: TethrProfile;
  subagents: TethrSubagent[];
  outputs: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
    sensitivity: string;
    status: string;
    createdAt: string;
  }>;
  runs: Array<{
    id: string;
    status: string;
    invocationSource: string;
    triggerDetail: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    summary: string | null;
  }>;
  budgetPolicies: Array<{
    id: string;
    amount: number;
    warnPercent: number;
    hardStopEnabled: boolean;
  }>;
}

export interface TethrStatus {
  llm: { provider: string; model: string; mode: "live" | "mock"; liveKeyPresent: boolean };
  storage: { provider: string; localDir: string | null };
  database: { external: boolean };
  bundle: { path: string | null };
  notifications: { channels: string[] };
  mirror: { enabled: boolean; dir: string | null };
  paperclipSha: string;
}

export interface TethrMirrorTreeNode {
  name: string;
  kind: "folder" | "file";
  size?: number;
  modifiedAt?: string;
  children?: TethrMirrorTreeNode[];
}

export interface TethrMirrorTree {
  enabled: boolean;
  dir?: string;
  tree?: TethrMirrorTreeNode[];
}

/** One entry in a filesystem-backed drive source (00 Tethr or an added folder). */
export interface TethrFsEntry {
  name: string;
  kind: "folder" | "file";
  path: string; // relative to the source root
  size?: number;
  modifiedAt?: string;
}

/** An extra Google Drive folder the user added to the file manager. */
export interface TethrDriveMount {
  id: string;
  label: string;
  path: string;
}

export interface TethrMemory {
  id: string;
  agentId: string | null;
  kind: string;
  content: string;
  source: string | null;
  createdAt: string;
}

export interface TethrOrgChange {
  id: string;
  outputId: string | null;
  op: string;
  targetAgentId: string | null;
  targetTag: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  summary: string;
  status: "applied" | "reverted";
  revertOfChangeId: string | null;
  revertedByChangeId: string | null;
  appliedBy: string;
  appliedAt: string;
}

// ---- Phase 25: memory --------------------------------------------------------
export type TethrMemoryTarget = "company" | "people";
export interface TethrMemoryOp {
  action: "add" | "patch" | "remove";
  content?: string;
  old_text?: string;
}
export interface TethrMemoryEntry {
  text: string;
  savedBy?: string;
  savedAt?: string;
  threadId?: string;
}
export interface TethrMemorySnapshot {
  backend: "hermes" | "builtin";
  stores: Record<TethrMemoryTarget, { entries: TethrMemoryEntry[]; used: number; limit: number }>;
  skills: Array<{ name: string; description: string }>;
}
export interface TethrMemoryState extends TethrMemorySnapshot {
  copyPath: string;
  inDrive: boolean;
  hermes: {
    installed: boolean;
    profile: string | null;
    on: boolean;
    ready: boolean;
    lockdownGaps: string[];
    indexed: number;
    lastImportAt: string | null;
    lastImportError: string | null;
    /** tethr may start Hermes's background service to save conversations. */
    wakeGateway: boolean;
  };
  /** Notes that couldn't be moved into the active store, with why. */
  notMoved: Array<{ target: TethrMemoryTarget; text: string; reason: string; at: string }>;
}
export interface TethrRecallHit {
  sessionId: string;
  title: string | null;
  source: string | null;
  startedAt: number | null;
  snippet: string | null;
  user: string;
  assistant: string;
}

export const tethrKeys = {
  overview: (c: string) => ["tethr", c, "overview"] as const,
  agent: (c: string, a: string) => ["tethr", c, "agent", a] as const,
  routeRuns: (c: string) => ["tethr", c, "route-runs"] as const,
  chats: (c: string) => ["tethr", c, "chats"] as const,
  team: (c: string) => ["tethr", c, "team"] as const,
  integrations: (c: string) => ["tethr", c, "integrations"] as const,
  env: (c: string) => ["tethr", c, "env"] as const,
  goals: (c: string) => ["tethr", c, "goals"] as const,
  setup: (c: string) => ["tethr", c, "setup"] as const,
  memory: (c: string) => ["tethr", c, "memory"] as const,
  memorySearch: (c: string, q: string) => ["tethr", c, "memory", "search", q] as const,
  memorySkill: (c: string, name: string) => ["tethr", c, "memory", "skill", name] as const,
  chatRuns: (c: string, threadId: string) => ["tethr", c, "chats", threadId, "runs"] as const,
  routeRun: (c: string, id: string) => ["tethr", c, "route-runs", id] as const,
  outputs: (c: string, status?: string) => ["tethr", c, "outputs", status ?? "all"] as const,
  output: (c: string, id: string) => ["tethr", c, "output", id] as const,
  drive: (c: string, parentId: string | null) => ["tethr", c, "drive", parentId ?? "root"] as const,
  driveNode: (c: string, id: string) => ["tethr", c, "drive-node", id] as const,
  driveContent: (c: string, id: string, v?: string) =>
    ["tethr", c, "drive-content", id, v ?? "current"] as const,
  runs: (c: string) => ["tethr", c, "runs"] as const,
  budgets: (c: string) => ["tethr", c, "budgets"] as const,
  growth: (c: string) => ["tethr", c, "growth"] as const,
  audit: (c: string, kind: string, actor: string) => ["tethr", c, "audit", kind, actor] as const,
  notifications: (c: string) => ["tethr", c, "notifications"] as const,
  memories: (c: string, agentId?: string) => ["tethr", c, "memories", agentId ?? "all"] as const,
  status: (c: string) => ["tethr", c, "status"] as const,
  orgChanges: (c: string) => ["tethr", c, "org-changes"] as const,
  mirrorTree: (c: string) => ["tethr", c, "mirror-tree"] as const,
  fsList: (c: string, mount: string, path: string) =>
    ["tethr", c, "fsdrive", mount, path] as const,
  fsMounts: (c: string) => ["tethr", c, "fsdrive-mounts"] as const,
  throttle: (c: string) => ["tethr", c, "throttle"] as const,
};

/** After a person decides an output (Queue, chat card or bell): refresh every
 * view of what's waiting on them, every status filter of the list included. */
export function refreshAfterDecision(queryClient: QueryClient, c: string): void {
  for (const queryKey of [["tethr", c, "outputs"], tethrKeys.growth(c), ["tethr", c, "overview"]]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

export interface ThrottleState {
  paused: boolean;
  reason?: string;
  at?: string;
  by?: string;
}

// Phase 18 — the fresh start (server/src/tethr/seed/fresh-start.ts). Archived
// specialists are paused with this exact reason (recoverable, never terminated).
export const TETHR_ARCHIVE_PAUSE_REASON = "archived: fresh start";

export interface TethrRestoreResult {
  restored: string[];
  routinesResumed: number;
  triggersEnabled: number;
  routingRowsRestored: number;
  hadArchive: boolean;
}

// Phase 16 — the growth board (server/src/tethr/growth.ts).
export interface TethrGrowthTask {
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
  pendingOutputId: string | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface TethrGrowthWorkflow {
  routineId: string;
  key: string | null;
  title: string;
  ownerTag: string | null;
  status: string;
  scheduleEnabled: boolean;
  cadence: string | null;
  lastTriggeredAt: string | null;
}

export interface TethrGrowthBoard {
  workflows: TethrGrowthWorkflow[];
  lanes: {
    waitingOnYou: TethrGrowthTask[];
    working: TethrGrowthTask[];
    blocked: TethrGrowthTask[];
    queued: TethrGrowthTask[];
    doneThisWeek: TethrGrowthTask[];
  };
  counts: {
    open: number;
    /** Tasks in review. */
    waitingOnYou: number;
    /** Everything the Queue holds for a decision. */
    pendingDecisions: number;
    doneThisWeek: number;
    workflowsOn: number;
    workflowsTotal: number;
  };
}

export const tethrApi = {
  overview: (c: string) => api.get<TethrOverview>(`/tethr/${c}/overview`),
  agent: (c: string, agentId: string) =>
    api.get<TethrAgentDetail>(`/tethr/${c}/agents/${agentId}`),
  route: (c: string, request: string, threadId?: string | null) =>
    api.post<{ routeRunId: string; threadId: string }>(`/tethr/${c}/route`, {
      request,
      threadId: threadId ?? null,
    }),
  routeRuns: (c: string, limit = 30) =>
    api.get<TethrRouteRun[]>(`/tethr/${c}/route-runs?limit=${limit}`),
  routeRun: (c: string, id: string) =>
    api.get<TethrRouteRunDetail>(`/tethr/${c}/route-runs/${id}`),
  chats: (c: string) => api.get<TethrChats>(`/tethr/${c}/chats`),
  /** Open a side chat with its first message (routes it and lists the thread). */
  openSideChat: (c: string, request: string, attachments: string[] = []) =>
    api.post<{ routeRunId: string; threadId: string; chat: TethrSideChat }>(`/tethr/${c}/chats`, { request, attachments }),
  /** Phase 19.1: upload a file to attach to the next chat message. */
  uploadChatAttachment: async (c: string, file: File) => {
    // Read the bytes now: a pasted File can lose its data once the event ends.
    const safe = new File([await file.arrayBuffer()], file.name, { type: file.type });
    const form = new FormData();
    form.append("file", safe);
    return api.postForm<TethrChatAttachment>(`/tethr/${c}/chats/attachments`, form);
  },
  removeSideChat: (c: string, threadId: string) =>
    api.delete<{ removed: boolean }>(`/tethr/${c}/chats/${threadId}`),
  chatRuns: (c: string, threadId: string, limit = 40) =>
    api.get<TethrChatRun[]>(`/tethr/${c}/chats/${threadId}/runs?limit=${limit}`),
  /** Phase 18: send a message into a chat thread (runs as a turn of its Claude session). */
  sendChatMessage: (c: string, threadId: string, text: string, attachments: string[] = []) =>
    api.post<{ routeRunId: string; threadId: string }>(`/tethr/${c}/chats/${threadId}/messages`, { text, attachments }),
  integrations: (c: string) => api.get<TethrIntegrations>(`/tethr/${c}/integrations`),
  /** Phase 20: goals with numbers, and tethr's setup (onboarding). */
  goals: (c: string) => api.get<TethrGoalsView>(`/tethr/${c}/goals`),
  saveGoal: (c: string, body: Record<string, unknown>) => api.post<TethrGoal>(`/tethr/${c}/goals`, body),
  saveMetric: (c: string, body: Record<string, unknown>) => api.post<TethrMetric>(`/tethr/${c}/goals/metrics`, body),
  recordMeasurement: (c: string, metricId: string, body: { value: number; at?: string; note?: string }) =>
    api.post<TethrMetric>(`/tethr/${c}/goals/metrics/${metricId}/measurements`, body),
  deleteMetric: (c: string, metricId: string) => api.delete<{ ok: true }>(`/tethr/${c}/goals/metrics/${metricId}`),
  setup: (c: string) => api.get<TethrSetup>(`/tethr/${c}/setup`),
  setupCompany: (
    c: string,
    body: {
      companyName: string;
      sells: string;
      adminName: string;
      adminEmail: string;
      position: string;
      positionTitle?: string;
      slackUserId?: string;
      timezone: string;
      internalAddresses?: string[];
    },
  ) => api.put<{ state: TethrSetupState; profile: TethrCompanyProfile }>(`/tethr/${c}/setup/company`, body),
  setupFocus: (c: string, body: { areas: string[]; growthPace: TethrGrowthPace; autoAdjust: boolean }) =>
    api.put<{ state: TethrSetupState; goals: TethrGoalsView }>(`/tethr/${c}/setup/focus`, body),
  setupStep: (c: string, step: TethrSetupStepKey, done = true) => api.post<TethrSetupState>(`/tethr/${c}/setup/steps/${step}`, { done }),
  startInterview: (c: string, restart = false) =>
    api.post<{ threadId: string; started: boolean }>(`/tethr/${c}/setup/interview`, { restart }),
  setupRhythm: (
    c: string,
    body: {
      timezone: string;
      rhythm: Record<TethrRhythmKey, { enabled: boolean; cron: string; slack: boolean }>;
      ideas?: { level: TethrIdeasLevel; adaptive: boolean; slackListen: boolean };
    },
  ) => api.put<TethrSetupState>(`/tethr/${c}/setup/rhythm`, body),
  /** Phase 21: ideas tethr offered on its own, and how one landed. */
  ideas: (c: string) => api.get<TethrIdea[]>(`/tethr/${c}/ideas`),
  ideaFeedback: (c: string, ideaId: string, verdict: "useful" | "not_now") => api.post<TethrIdea>(`/tethr/${c}/ideas/${ideaId}/feedback`, { verdict }),
  runRhythm: (c: string, key: TethrRhythmKey) =>
    api.post<{ issueId: string | null; threadId: string }>(`/tethr/${c}/setup/rhythm/${key}/run`, {}),
  completeSetup: (c: string, done = true) => api.post<TethrSetupState>(`/tethr/${c}/setup/complete`, { done }),
  /** Phase 19.2: the instance .env (names and status only; values via reveal). */
  env: (c: string) => api.get<TethrEnv>(`/tethr/${c}/env`),
  revealEnv: (c: string, key: string) => api.post<{ key: string; value: string }>(`/tethr/${c}/env/reveal`, { key }),
  setEnv: (c: string, key: string, value: string) => api.put<{ ok: true }>(`/tethr/${c}/env`, { key, value }),
  deleteEnv: (c: string, key: string) => api.delete<{ ok: true }>(`/tethr/${c}/env/${encodeURIComponent(key)}`),
  /** Phase 18.5: the chat's long-term memory file (Memory.md in the workspace). */
  /** Phase 25: tethr's memory (Hermes, or the built-in store). */
  memory: (c: string) => api.get<TethrMemoryState>(`/tethr/${c}/memory`),
  changeMemory: (c: string, target: TethrMemoryTarget, operations: TethrMemoryOp[]) =>
    api.post<TethrMemorySnapshot & { usage: string }>(`/tethr/${c}/memory/entries`, { target, operations }),
  searchMemory: (c: string, q: string) =>
    api.get<{ hits: TethrRecallHit[] }>(`/tethr/${c}/memory/search?q=${encodeURIComponent(q)}`),
  memorySkill: (c: string, name: string) =>
    api.get<{ name: string; description: string; content: string }>(`/tethr/${c}/memory/skills/${encodeURIComponent(name)}`),
  deleteMemorySkill: (c: string, name: string) => api.delete<TethrMemorySnapshot>(`/tethr/${c}/memory/skills/${encodeURIComponent(name)}`),
  setHermesMemory: (c: string, on: boolean) =>
    api.post<TethrMemorySnapshot & { on: boolean; moved: number; notMoved: number }>(`/tethr/${c}/memory/hermes`, { on }),
  setHermesWakeGateway: (c: string, allowed: boolean) => api.post<{ wakeGateway: boolean }>(`/tethr/${c}/memory/wake-gateway`, { allowed }),
  dismissNotMoved: (c: string, index: number | "all") =>
    api.post<{ notMoved: TethrMemoryState["notMoved"] }>(`/tethr/${c}/memory/not-moved/dismiss`, index === "all" ? {} : { index }),
  /** Phase 23: tethr's team of agents. */
  team: (c: string) => api.get<TethrTeam>(`/tethr/${c}/team`),
  setTeamAgentPaused: (c: string, tag: string, paused: boolean) =>
    api.post<{ tag: string; paused: boolean }>(`/tethr/${c}/team/${encodeURIComponent(tag)}/pause`, { paused }),
  proposeTeam: (c: string) => api.post<{ routeRunId: string; threadId: string }>(`/tethr/${c}/team/propose`, {}),
  updateIntegrations: (c: string, patch: TethrIntegrationsPatch) =>
    api.put<{ ok: boolean }>(`/tethr/${c}/integrations`, patch),
  stopChatTurn: (c: string, runId: string) =>
    api.post<{ stopped: boolean }>(`/tethr/${c}/chat-turns/${runId}/stop`, {}),
  resetChatSession: (c: string, threadId: string) =>
    api.post<{ reset: boolean }>(`/tethr/${c}/chats/${threadId}/reset`, {}),
  outputs: (c: string, status?: string) =>
    api.get<TethrOutputListItem[]>(
      `/tethr/${c}/outputs${status ? `?status=${status}` : ""}`,
    ),
  output: (c: string, id: string) => api.get<TethrOutputDetail>(`/tethr/${c}/outputs/${id}`),
  decide: (c: string, id: string, decision: string, note?: string) =>
    api.post(`/tethr/${c}/outputs/${id}/decide`, { decision, note }),
  revise: (c: string, id: string, note?: string) =>
    api.post<{ outputId: string }>(`/tethr/${c}/outputs/${id}/revise`, { note }),
  drive: (c: string, parentId: string | null) =>
    api.get<TethrDriveNode[]>(
      `/tethr/${c}/drive${parentId ? `?parentId=${parentId}` : ""}`,
    ),
  driveNode: (c: string, nodeId: string) =>
    api.get<{ node: TethrDriveNode; versions: TethrDriveVersion[] }>(
      `/tethr/${c}/drive/node/${nodeId}`,
    ),
  driveContent: (c: string, nodeId: string, versionId?: string) =>
    api.get<{ versionId: string; versionNumber: number; contentType: string | null; content: string }>(
      `/tethr/${c}/drive/node/${nodeId}/content${versionId ? `?versionId=${versionId}` : ""}`,
    ),
  saveDriveFile: (c: string, path: string, content: string, note?: string) =>
    api.post(`/tethr/${c}/drive/file`, { path, content, note }),
  setDriveTags: (c: string, nodeId: string, tags: string[]) =>
    api.post(`/tethr/${c}/drive/node/${nodeId}/tags`, { tags }),
  createDriveFolder: (c: string, parentId: string | null, name: string) =>
    api.post<TethrDriveNode>(`/tethr/${c}/drive/folder`, { parentId, name }),
  moveDriveNode: (
    c: string,
    nodeId: string,
    opts: { newParentId?: string | null; newName?: string },
  ) => api.post<TethrDriveNode>(`/tethr/${c}/drive/node/${nodeId}/move`, opts),
  archiveDriveNode: (c: string, nodeId: string) =>
    api.post<TethrDriveNode>(`/tethr/${c}/drive/node/${nodeId}/archive`, {}),
  runs: (c: string) =>
    api.get<{ schedules: TethrSchedule[]; runs: TethrRunRow[] }>(`/tethr/${c}/runs`),
  runNow: (c: string, agentId: string, request?: string) =>
    api.post<TethrRouteResult & { runId: string }>(
      `/tethr/${c}/agents/${agentId}/run-now`,
      request ? { request } : {},
    ),
  budgets: (c: string) => api.get<TethrBudgets>(`/tethr/${c}/budgets`),
  growth: (c: string) => api.get<TethrGrowthBoard>(`/tethr/${c}/growth`),
  audit: (c: string, opts: { kind?: string; actor?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.kind && opts.kind !== "all") params.set("kind", opts.kind);
    if (opts.actor) params.set("actor", opts.actor);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<TethrAuditEvent[]>(`/tethr/${c}/audit${qs ? `?${qs}` : ""}`);
  },
  notifications: (c: string) =>
    api.get<TethrNotification[]>(`/tethr/${c}/notifications`),
  markNotificationRead: (c: string, id: string) =>
    api.post(`/tethr/${c}/notifications/${id}/read`, {}),
  markAllNotificationsRead: (c: string) =>
    api.post(`/tethr/${c}/notifications/read-all`, {}),
  digest: (c: string) =>
    api.post<{ outputId: string; title: string; pendingCount: number }>(
      `/tethr/${c}/digest`,
      {},
    ),
  createDivision: (c: string, body: { name: string; description?: string; icon?: string }) =>
    api.post<TethrDivision>(`/tethr/${c}/divisions`, body),
  createAgent: (
    c: string,
    body: {
      codename: string;
      title: string;
      mission?: string;
      divisionId?: string | null;
      isHead?: boolean;
      approvalGate?: string;
    },
  ) => api.post<{ agentId: string; tag: string }>(`/tethr/${c}/agents`, body),
  proposeAgent: (c: string, brief?: string) =>
    api.post<{ outputId: string; codename: string; tag: string }>(
      `/tethr/${c}/agents/propose`,
      { brief },
    ),
  memories: (c: string, agentId?: string) =>
    api.get<TethrMemory[]>(
      `/tethr/${c}/memories${agentId ? `?agentId=${agentId}` : ""}`,
    ),
  status: (c: string) => api.get<TethrStatus>(`/tethr/${c}/status`),
  throttle: (c: string) => api.get<ThrottleState>(`/tethr/${c}/throttle`),
  setThrottle: (c: string, paused: boolean) =>
    api.post<ThrottleState>(`/tethr/${c}/throttle`, { paused }),
  restoreSpecialists: (c: string) =>
    api.post<TethrRestoreResult>(`/tethr/${c}/specialists/restore`, {}),
  orgChanges: (c: string) => api.get<TethrOrgChange[]>(`/tethr/${c}/org-changes`),
  revertOrgChange: (c: string, changeId: string) =>
    api.post<{ outputId: string }>(`/tethr/${c}/org-changes/${changeId}/revert`, {}),
  setLlmMode: (c: string, mode: "live" | "mock") =>
    api.post<{
      mode: "live" | "mock";
      provider: string;
      model: string;
      liveKeyPresent: boolean;
    }>(`/tethr/${c}/llm-mode`, { mode }),
  mirrorTree: (c: string) => api.get<TethrMirrorTree>(`/tethr/${c}/mirror/tree`),
  mirrorBackfill: (c: string, force?: boolean) =>
    api.post<{
      scanned: number;
      written: number;
      skippedUpToDate: number;
      skippedUnmapped: number;
      failed: number;
    }>(`/tethr/${c}/mirror/backfill${force ? "?force=true" : ""}`, {}),
  // Filesystem-backed drive sources (00 Tethr = "mirror", added folder = "ext:<id>").
  fsList: (c: string, mount: string, path: string) =>
    api.get<{ entries: TethrFsEntry[] }>(
      `/tethr/${c}/fsdrive/list?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`,
    ),
  fsRead: (c: string, mount: string, path: string) =>
    api.get<{ kind: "text" | "office" | "binary" | "toolarge" | "missing"; content?: string; ext?: string; size?: number }>(
      `/tethr/${c}/fsdrive/read?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`,
    ),
  /** A PDF or image as it is (for an iframe or img). */
  fsRawUrl: (c: string, mount: string, path: string) =>
    `/api/tethr/${c}/fsdrive/raw?mount=${encodeURIComponent(mount)}&path=${encodeURIComponent(path)}`,
  /** Select the file in Finder (macOS). */
  fsReveal: (c: string, mount: string, path: string) => api.post<{ ok: true }>(`/tethr/${c}/fsdrive/reveal`, { mount, path }),
  fsCreateFolder: (c: string, mount: string, path: string, name: string) =>
    api.post<{ path: string }>(`/tethr/${c}/fsdrive/folder`, { mount, path, name }),
  fsMove: (c: string, mount: string, from: string, toDir: string, newName?: string) =>
    api.post<{ path: string }>(`/tethr/${c}/fsdrive/move`, { mount, from, toDir, newName }),
  fsArchive: (c: string, mount: string, path: string) =>
    api.post<{ path: string }>(`/tethr/${c}/fsdrive/archive`, { mount, path }),
  fsMounts: (c: string) =>
    api.get<{ mounts: TethrDriveMount[]; driveRoot: string | null }>(`/tethr/${c}/fsdrive/mounts`),
  fsAddMount: (c: string, path: string, label?: string) =>
    api.post<{ mount: TethrDriveMount }>(`/tethr/${c}/fsdrive/mounts`, { path, label }),
  fsRemoveMount: (c: string, id: string) =>
    api.delete<{ removed: boolean }>(`/tethr/${c}/fsdrive/mounts/${id}`),
  updateAgentProfile: (
    c: string,
    agentId: string,
    patch: { autoApprove?: boolean; overseerRole?: TethrOverseerRole },
  ) =>
    api.patch<{ autoApprove: boolean; overseerRole: TethrOverseerRole }>(
      `/tethr/${c}/agents/${agentId}/profile`,
      patch,
    ),
  overseers: (c: string) => api.get<{ roster: TethrOverseerRoster }>(`/tethr/${c}/overseers`),
  setOverseers: (c: string, roster: Partial<TethrOverseerRoster>) =>
    api.put<{ roster: TethrOverseerRoster }>(`/tethr/${c}/overseers`, { roster }),
};
