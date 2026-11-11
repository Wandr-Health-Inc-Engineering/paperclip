import { useMutation } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { StatusDot } from "@/components/tethr/primitives";
import { formatMetric } from "@/components/tethr/Scorecard";
import { tethrApi, type TethrGoal, type TethrRhythmKey } from "@/api/tethr";
import { useNavigate } from "../../../lib/router";
import { ErrorLine, PRIMARY_BUTTON, StepActions } from "./controls";
import { activeGoals, useRefreshSetup, type SetupData, type StepProps } from "./shared";

// The last step: a look at what's set, then the goals interview, which happens
// in the main chat (the one ongoing conversation). Starting it finishes setup,
// so the chat never asks you to "finish setting up".

export function InterviewStep({ companyId, data }: StepProps) {
  const navigate = useNavigate();
  const refresh = useRefreshSetup(companyId);
  const openChat = (threadId: string) => navigate(threadId === companyId ? "/chat" : `/chat?chat=${threadId}`);
  const start = useMutation({
    mutationFn: () => tethrApi.startInterview(companyId),
    // Starting is idempotent: it opens the interview that's already going.
    onSuccess: (r) => {
      refresh();
      openChat(r.threadId);
    },
  });
  const finishWithout = useMutation({
    mutationFn: () => tethrApi.completeSetup(companyId),
    onSuccess: () => {
      refresh();
      navigate("/chat");
    },
  });
  const goals = activeGoals(data);
  const started = !!data.state.interviewThreadId;
  const missing = firstMissingStep(data);

  return (
    <div className="space-y-4">
      <SetupSummary data={data} />
      <p className="text-[12.5px] text-muted-foreground">
        tethr talks the goals through with you in your chat, one at a time. It pulls a starting number from your tools (totals only), proposes a
        realistic target from the trend and your growth pace, and saves each goal once you agree. Goals appear here as they're saved.
      </p>
      {missing ? (
        <p className="flex items-center gap-1.5 text-[12px]">
          <StatusDot tone="warn" /> {missing}
        </p>
      ) : null}
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {goals.length ? goals.map((goal) => <GoalProgress key={goal.id} goal={goal} />) : <p className="px-3 py-3 text-[12.5px] tethr-text-3">No goals yet.</p>}
      </div>
      <ErrorLine error={start.error ?? finishWithout.error} />
      <StepActions>
        {!started && !data.state.completedAt ? (
          <button type="button" onClick={() => finishWithout.mutate()} disabled={finishWithout.isPending} className="tethr-btn tethr-btn-ghost h-9 px-3.5 text-[12.5px]">
            Finish without it
          </button>
        ) : null}
        <button type="button" onClick={() => start.mutate()} disabled={(!started && !goals.length) || start.isPending} className={PRIMARY_BUTTON}>
          {started ? "Continue in your chat" : "Start the goals interview"}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </StepActions>
    </div>
  );
}

/** What should be done before the interview, as an instruction, or null. */
function firstMissingStep(data: SetupData): string | null {
  if (!data.profile?.admin) return "Save your company first (step 1), so tethr knows who it's talking to.";
  if (!activeGoals(data).length) return "Pick what to work on first (step 2).";
  return null;
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

function SetupSummary({ data }: { data: SetupData }) {
  const { profile, state, autonomy } = data;
  const rhythmsOn = (Object.keys(state.rhythm) as TethrRhythmKey[]).filter((key) => state.rhythm[key].enabled);
  const missing = data.checks.filter((c) => !c.ok && !c.optional);
  const onItsOwn = [autonomy.dailyReview.enabled ? `daily review at ${autonomy.dailyReview.time}` : null, autonomy.actOnReports ? "check-ins" : null, autonomy.learner ? "the learner" : null].filter(Boolean);
  const rows: Array<[string, string]> = [
    ["Company", profile?.admin ? `${profile.name}${profile.sells ? `: ${profile.sells}` : ""}` : "not set"],
    ["You", profile?.admin ? `${profile.admin.name}, ${profile.admin.title} (admin)` : "not set"],
    ["Connections", missing.length ? `${missing.length} still to connect: ${missing.map((m) => m.label.split(" (")[0]).join(", ")}` : "all set"],
    [
      "Growth pace",
      `${data.growthPaces.find((p) => p.key === state.growthPace)?.label ?? ""}${state.autoAdjust ? ", targets adjust on their own" : ", targets stay as set"}`,
    ],
    ["Rhythm", rhythmsOn.length ? rhythmsOn.map((key) => data.rhythms[key].label).join(" · ") : "no routines yet"],
    ["On its own", `${onItsOwn.length ? onItsOwn.join(", ") : "waits to be asked"}; new agents ${autonomy.newAgents === "auto" ? "automatic" : "ask you"}`],
  ];
  return (
    <dl className="tethr-inset grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-3.5 py-3 text-[12.5px]">
      {rows.map(([term, value]) => (
        <SummaryRow key={term} term={term} value={value} />
      ))}
    </dl>
  );
}

function SummaryRow({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt className="tethr-text-3">{term}</dt>
      <dd>{value}</dd>
    </>
  );
}
