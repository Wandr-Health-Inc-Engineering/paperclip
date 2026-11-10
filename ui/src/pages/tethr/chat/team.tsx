import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Users } from "lucide-react";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrTeamAgent } from "@/api/tethr";
import { agentStatusWords, agentTone, dollars, orderTeam } from "@/lib/tethr-team";
import { cn } from "@/lib/utils";

// Phase 23-24: tethr's team in the chat. The drawer lists each agent (its own
// chat, with a status dot), sub-agents indented under their lead; in an
// agent's chat the avatar opens what it is (its goal, its lead or sub-team),
// what it's allowed, what it has used, and Pause/Resume.

export function TeamSection({
  agents,
  activeThreadId,
  onOpen,
  onPropose,
  proposing,
}: {
  agents: TethrTeamAgent[];
  activeThreadId: string | null;
  onOpen: (threadId: string) => void;
  onPropose: () => void;
  proposing: boolean;
}) {
  const active = agents.filter((a) => !a.paused).length;
  return (
    <>
      <div className="mt-2 flex items-center justify-between px-2 pb-1">
        <span className="tethr-eyebrow">team</span>
        {agents.length ? <span className="font-mono text-[10.5px] tethr-text-3">{active} active</span> : null}
      </div>
      {orderTeam(agents).map(({ agent, depth }) => (
        <button
          key={agent.agentId}
          type="button"
          onClick={() => onOpen(agent.threadId)}
          aria-current={agent.threadId === activeThreadId ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-[10px] py-1.5 pr-2 text-left transition-colors",
            depth ? "ml-3 border-l border-[var(--tethr-rim)] pl-3" : "pl-2",
            agent.threadId === activeThreadId ? "bg-[var(--tethr-select-blur)]" : "hover:bg-[var(--tethr-select-blur)]",
          )}
        >
          <StatusDot tone={agentTone(agent)} title={agentStatusWords(agent)} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="truncate text-[13px]">{agent.name}</span>
              <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">{agent.tag}</span>
            </span>
            <span className="block truncate text-[11px] tethr-text-3">
              {agent.lead ? `Lead · ${agent.subTeam.length} on its team · ` : ""}
              {agentStatusWords(agent)}
            </span>
          </span>
        </button>
      ))}
      {!agents.length ? (
        <div className="space-y-2 px-2 py-1">
          <p className="text-[12px] leading-snug tethr-text-3">
            No agents yet. tethr proposes one when an effort needs an owner, and you approve each. You can also ask it for suggestions.
          </p>
          <button type="button" onClick={onPropose} disabled={proposing} className="tethr-btn tethr-btn-glass h-7 px-3 text-[12px]">
            <Users className="h-3.5 w-3.5" />
            {proposing ? "Asking tethr…" : "Ask tethr to suggest agents"}
          </button>
        </div>
      ) : null}
    </>
  );
}

/** What an agent is, what it's allowed, what it has used, and Pause/Resume. Opens from the chat's avatar. */
export function AgentAbout({ agent, companyId }: { agent: TethrTeamAgent; companyId: string }) {
  const queryClient = useQueryClient();
  const pause = useMutation({
    mutationFn: (paused: boolean) => tethrApi.setTeamAgentPaused(companyId, agent.tag, paused),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.team(companyId) }),
  });
  return (
    <>
      <div>
        <p className="text-[13.5px] font-medium">{agent.title}</p>
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{agent.mission}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {agent.goal?.title ? (
          <>
            <dt className="tethr-text-3">Goal</dt>
            <dd>{agent.goal.title}</dd>
          </>
        ) : null}
        <dt className="tethr-text-3">Runs</dt>
        <dd>{agent.schedule ? agent.schedule.words : `When ${agent.leadTag ?? "tethr"} assigns it work`}</dd>
        <dt className="tethr-text-3">Reports to</dt>
        <dd>{agent.leadTag ? `${agent.leadTag}, its lead` : `${agent.ownerName ?? agent.ownerRole} on Slack, and to tethr`}</dd>
        {agent.lead ? (
          <>
            <dt className="tethr-text-3">Its team</dt>
            <dd>{agent.subTeam.length ? agent.subTeam.join(", ") : "None yet: it sets one up when the work needs it"}</dd>
          </>
        ) : null}
        <dt className="tethr-text-3">Today</dt>
        <dd>
          {agent.runsToday} of {agent.maxRunsPerDay} runs · {agent.openTasks} open {agent.openTasks === 1 ? "task" : "tasks"}
        </dd>
        <dt className="tethr-text-3">Spend</dt>
        <dd>
          {dollars(agent.spentMonthlyCents)} of {dollars(agent.budgetMonthlyCents)} this month
        </dd>
        <dt className="tethr-text-3">Tools</dt>
        <dd>{["Web search", "its files", ...agent.connectors].join(", ")}</dd>
      </dl>
      <div className="flex items-center justify-between gap-3 pt-0.5">
        <span className="text-[11.5px] leading-snug tethr-text-3">
          {agent.paused ? "Paused: no scheduled or assigned runs." : "To change its job or schedule, ask tethr."}
        </span>
        <button
          type="button"
          onClick={() => pause.mutate(!agent.paused)}
          disabled={pause.isPending}
          className={cn("tethr-btn h-8 shrink-0 px-3.5 text-[12.5px]", agent.paused ? "tethr-btn-primary" : "tethr-btn-ghost")}
        >
          {agent.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {agent.paused ? "Resume" : "Pause"}
        </button>
      </div>
    </>
  );
}
