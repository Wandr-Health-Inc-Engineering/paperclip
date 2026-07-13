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
  heartbeatCron: string | null;
  heartbeatNote: string | null;
  portPriority: number | null;
  routingTable: TethrRoutingEntry[];
  standingRules: string[];
}

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
  threadId: string | null;
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
  paperclipSha: string;
}

export interface TethrMemory {
  id: string;
  agentId: string | null;
  kind: string;
  content: string;
  source: string | null;
  createdAt: string;
}

export const tethrKeys = {
  overview: (c: string) => ["tethr", c, "overview"] as const,
  agent: (c: string, a: string) => ["tethr", c, "agent", a] as const,
  routeRuns: (c: string) => ["tethr", c, "route-runs"] as const,
  routeRun: (c: string, id: string) => ["tethr", c, "route-runs", id] as const,
  outputs: (c: string, status?: string) => ["tethr", c, "outputs", status ?? "all"] as const,
  output: (c: string, id: string) => ["tethr", c, "output", id] as const,
  drive: (c: string, parentId: string | null) => ["tethr", c, "drive", parentId ?? "root"] as const,
  driveNode: (c: string, id: string) => ["tethr", c, "drive-node", id] as const,
  driveContent: (c: string, id: string, v?: string) =>
    ["tethr", c, "drive-content", id, v ?? "current"] as const,
  runs: (c: string) => ["tethr", c, "runs"] as const,
  budgets: (c: string) => ["tethr", c, "budgets"] as const,
  audit: (c: string, kind: string, actor: string) => ["tethr", c, "audit", kind, actor] as const,
  notifications: (c: string) => ["tethr", c, "notifications"] as const,
  memories: (c: string, agentId?: string) => ["tethr", c, "memories", agentId ?? "all"] as const,
  status: (c: string) => ["tethr", c, "status"] as const,
};

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
  runs: (c: string) =>
    api.get<{ schedules: TethrSchedule[]; runs: TethrRunRow[] }>(`/tethr/${c}/runs`),
  runNow: (c: string, agentId: string, request?: string) =>
    api.post<TethrRouteResult & { runId: string }>(
      `/tethr/${c}/agents/${agentId}/run-now`,
      request ? { request } : {},
    ),
  budgets: (c: string) => api.get<TethrBudgets>(`/tethr/${c}/budgets`),
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
  memories: (c: string, agentId?: string) =>
    api.get<TethrMemory[]>(
      `/tethr/${c}/memories${agentId ? `?agentId=${agentId}` : ""}`,
    ),
  status: (c: string) => api.get<TethrStatus>(`/tethr/${c}/status`),
  setLlmMode: (c: string, mode: "live" | "mock") =>
    api.post<{
      mode: "live" | "mock";
      provider: string;
      model: string;
      liveKeyPresent: boolean;
    }>(`/tethr/${c}/llm-mode`, { mode }),
};
