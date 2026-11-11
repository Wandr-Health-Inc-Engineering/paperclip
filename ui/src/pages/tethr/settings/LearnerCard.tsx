import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { Toggle } from "@/pages/tethr/setup/controls";
import { Link } from "@/lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { LearningPaceControls } from "./LearningPace";

// The learner's switch on the Integrations page (phase 26.6, rebuilt
// 2026-11-10). Off until a person switches it on; it's made then (an agent with
// a budget), and paused again when switched off. Its pace and whether its skills
// save on their own sit under the switch.

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
    <section className="tethr-panel space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={learner.enabled ? "ok" : "idle"} />
            Learning · Sage {agent ? <span className="font-mono text-[12px] tethr-text-3">{agent.tag}</span> : null}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Sage watches how tethr is doing, studies what would help, and saves what it learns as skills tethr and its agents load before that kind of
            work. Ask it to learn anything in its chat. It researches the web in a room that sees nothing private, and compares what it found with what
            tethr already knows in another room with no web.
          </p>
          {agent ? (
            <p className="mt-2 font-mono text-[11px] tethr-text-3">
              {agent.paused ? "paused" : "on"} · ${(agent.spentMonthlyCents / 100).toFixed(2)} of ${(agent.budgetMonthlyCents / 100).toFixed(0)} this month
            </p>
          ) : null}
          <Link to="/learning" className="mt-2 inline-block text-[12.5px] underline-offset-2 hover:underline">
            What Sage learned
          </Link>
        </div>
        <Toggle on={learner.enabled} onChange={(on) => toggle.mutate(on)} label={learner.enabled ? "Sage is on" : "Sage is off"} />
      </div>
      {toggle.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(toggle.error as Error).message}</p> : null}
      <LearningPaceControls companyId={companyId} learner={learner} />
    </section>
  );
}
