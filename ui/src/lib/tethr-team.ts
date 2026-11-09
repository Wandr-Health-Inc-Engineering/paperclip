import type { StatusTone } from "@/components/tethr/primitives";
import type { TethrTeamAgent } from "@/api/tethr";

// Phase 23: small, pure helpers for showing tethr's team in the chat.

/** One dot per agent: needs you > working > paused > idle. */
export function agentTone(agent: Pick<TethrTeamAgent, "paused" | "running" | "waitingOnYou">): StatusTone {
  if (agent.waitingOnYou > 0) return "warn";
  if (agent.running) return "live";
  if (agent.paused) return "paused";
  return "ok";
}

/** What the dot means, in words (for the row's second line and screen readers). */
export function agentStatusWords(agent: Pick<TethrTeamAgent, "paused" | "running" | "waitingOnYou" | "schedule">): string {
  if (agent.waitingOnYou > 0) return agent.waitingOnYou === 1 ? "Needs your approval" : `${agent.waitingOnYou} need your approval`;
  if (agent.running) return "Working now";
  if (agent.paused) return "Paused";
  return agent.schedule ? `Runs ${agent.schedule.words}` : "Works when tethr assigns it";
}

export function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

/** The agent whose chat a thread is, if any. */
export function agentForThread(agents: TethrTeamAgent[] | undefined, threadId: string | null): TethrTeamAgent | undefined {
  return threadId ? agents?.find((a) => a.threadId === threadId) : undefined;
}
