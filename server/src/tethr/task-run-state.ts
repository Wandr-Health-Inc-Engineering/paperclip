// The per-run task state (phase 16a), kept apart from tasks.ts so modules that
// only need this (routing, the worker, tool types) don't load the issue service
// and its database tables just by being imported.

export interface TaskRunState {
  /** The task this run is working (null for Console/Slack runs). */
  issueId: string | null;
  /** Whether delegate_task may create children in this run. */
  allowDelegation: boolean;
  /** Children created during this run (so the run's task parks as blocked). */
  delegated: Array<{ issueId: string; identifier: string | null; toTag: string }>;
  /** The original request, used to title a root task created on the fly. */
  requestText?: string;
}

export function newTaskRunState(input: Partial<TaskRunState> = {}): TaskRunState {
  return {
    issueId: input.issueId ?? null,
    allowDelegation: input.allowDelegation ?? true,
    delegated: input.delegated ?? [],
    requestText: input.requestText,
  };
}
