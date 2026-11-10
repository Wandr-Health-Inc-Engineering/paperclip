import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { Toggle } from "@/pages/tethr/setup/controls";
import { Link } from "@/lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";

// Phase 26.6: the learner's switch on the Integrations page. Off until a person
// switches it on; it's made then (an agent with a budget and a daily cap), and
// paused again when switched off.

export function LearnerCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: tethrKeys.learning(companyId), queryFn: () => tethrApi.learning(companyId) });
  const toggle = useMutation({
    mutationFn: (on: boolean) => tethrApi.setLearner(companyId, on),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) });
      void queryClient.invalidateQueries({ queryKey: tethrKeys.team(companyId) });
    },
  });
  if (!data) return null;
  const { learner } = data;
  const agent = learner.agent;
  return (
    <section className="tethr-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={learner.enabled ? "ok" : "idle"} />
            Learning · the learner {agent ? <span className="font-mono text-[12px] tethr-text-3">{agent.tag}</span> : null}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            An agent that studies how other companies grow (distribution, sales, customer experience) from public sources, one area a week, and brings
            back lessons as cards. It works in a sealed folder: no memory, no connected tools, no notes about people. Only you apply a lesson.
          </p>
          {agent ? (
            <p className="mt-2 font-mono text-[11px] tethr-text-3">
              {agent.paused ? "paused" : "on"} · up to {agent.maxRunsPerDay} runs a day · ${(agent.spentMonthlyCents / 100).toFixed(2)} of $
              {(agent.budgetMonthlyCents / 100).toFixed(0)} this month · {learner.queue.length} topic{learner.queue.length === 1 ? "" : "s"} queued
            </p>
          ) : null}
          <Link to="/learning" className="mt-2 inline-block text-[12.5px] underline-offset-2 hover:underline">
            Open the Learning page
          </Link>
        </div>
        <Toggle on={learner.enabled} onChange={(on) => toggle.mutate(on)} label={learner.enabled ? "The learner is on" : "The learner is off"} />
      </div>
      {toggle.isError ? <p className="mt-2 text-[12px] text-[var(--tethr-bad)]">{(toggle.error as Error).message}</p> : null}
    </section>
  );
}
