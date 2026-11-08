import { useMutation } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { formatMetric } from "@/components/tethr/Scorecard";
import { tethrApi, type TethrGoal } from "@/api/tethr";
import { Link, useNavigate } from "../../../lib/router";
import { ErrorLine, GLASS_BUTTON, PRIMARY_BUTTON, StepActions } from "./controls";
import { activeGoals, interviewComplete, useRefreshSetup, type StepProps } from "./shared";

// Step 4: tethr interviews you in a side chat and saves goals with numbers;
// they appear here as they're saved.

export function InterviewStep({ companyId, data, onDone }: StepProps) {
  const navigate = useNavigate();
  const refresh = useRefreshSetup(companyId);
  const start = useMutation({
    mutationFn: () => tethrApi.startInterview(companyId),
    onSuccess: (r) => {
      refresh();
      navigate(`/chat?chat=${r.threadId}`);
    },
  });
  const markDone = useMutation({
    mutationFn: () => tethrApi.setupStep(companyId, "interview"),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const goals = activeGoals(data);

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted-foreground">
        tethr talks it through with you in a side chat, one goal at a time. It pulls a baseline from your tools (aggregate numbers only), proposes a
        realistic target from the trend and your growth pace, and saves each goal once you agree. It also fills in its memory with your products,
        customers and channels. Goals appear here as they're saved.
      </p>
      {!goals.length ? <p className="text-[12.5px] text-[var(--tethr-bad)]">Pick what to work on first (step 2).</p> : null}
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {goals.length ? goals.map((goal) => <GoalProgress key={goal.id} goal={goal} />) : <p className="px-3 py-3 text-[12.5px] tethr-text-3">No goals yet.</p>}
      </div>
      <ErrorLine error={start.error ?? markDone.error} />
      <StepActions>
        {data.state.interviewThreadId ? (
          <Link to={`/chat?chat=${data.state.interviewThreadId}`} className={GLASS_BUTTON}>
            Continue the interview
          </Link>
        ) : (
          <button type="button" onClick={() => start.mutate()} disabled={!goals.length || start.isPending} className={PRIMARY_BUTTON}>
            Start the interview
          </button>
        )}
        {interviewComplete(data) || data.state.steps.interview ? (
          <button type="button" onClick={() => markDone.mutate()} disabled={markDone.isPending} className={PRIMARY_BUTTON}>
            Goals look right, continue
          </button>
        ) : null}
      </StepActions>
    </div>
  );
}

function GoalProgress({ goal }: { goal: TethrGoal }) {
  const hasNumbers = goal.metrics.some((m) => m.baseline !== null && m.target !== null);
  return (
    <div className="space-y-1 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StatusDot tone={hasNumbers ? "ok" : "idle"} />
        <span className="text-[13px] font-medium">{goal.title}</span>
      </div>
      {goal.metrics.length ? (
        goal.metrics.map((m) => (
          <p key={m.id} className="pl-4 text-[12px] text-muted-foreground">
            {m.name}: {formatMetric(m.baseline, m.unit)} now → {formatMetric(m.target, m.unit)}
            {m.targetDate ? ` by ${new Date(m.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
          </p>
        ))
      ) : (
        <p className="pl-4 text-[12px] tethr-text-3">waiting for the interview</p>
      )}
    </div>
  );
}
