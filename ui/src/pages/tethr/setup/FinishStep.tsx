import { useMutation } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, type TethrRhythmKey } from "@/api/tethr";
import { Link, useNavigate } from "../../../lib/router";
import { ErrorLine, GLASS_BUTTON, PRIMARY_BUTTON, StepActions } from "./controls";
import { activeGoals, useRefreshSetup, type SetupData, type StepKey } from "./shared";

// Step 6: a summary of everything set, the first scorecard, and finishing.

export function FinishStep({ companyId, data, done }: { companyId: string; data: SetupData; done: Record<StepKey, boolean> }) {
  const navigate = useNavigate();
  const refresh = useRefreshSetup(companyId);
  const measure = useMutation({ mutationFn: () => tethrApi.runRhythm(companyId, "scorecard") });
  const finish = useMutation({
    mutationFn: () => tethrApi.completeSetup(companyId),
    onSuccess: () => {
      refresh();
      navigate("/growth");
    },
  });
  const hasMetrics = activeGoals(data).some((g) => g.metrics.length > 0);
  const nextMissing = firstMissingStep(done);

  return (
    <div className="space-y-4">
      <SetupSummary data={data} />
      {nextMissing ? (
        <p className="flex items-center gap-1.5 text-[12px]">
          <StatusDot tone="warn" /> {nextMissing} so tethr has numbers to work toward.
        </p>
      ) : null}
      <ErrorLine error={measure.error ?? finish.error} />
      <StepActions>
        {measure.isSuccess ? (
          <Link to={`/chat?chat=${measure.data.threadId}`} className="text-[12px] tethr-text-3 hover:text-foreground">
            Measuring in the Operations chat →
          </Link>
        ) : (
          <button type="button" onClick={() => measure.mutate()} disabled={!hasMetrics || measure.isPending} className={GLASS_BUTTON}>
            Run the first scorecard now
          </button>
        )}
        <button type="button" onClick={() => finish.mutate()} disabled={finish.isPending} className={PRIMARY_BUTTON}>
          {data.state.completedAt ? "Done" : "Finish setup"}
        </button>
      </StepActions>
    </div>
  );
}

/** What still stands between setup and real numbers, as an instruction, or null. */
function firstMissingStep(done: Record<StepKey, boolean>): string | null {
  if (!done.company) return "Save your company";
  if (!done.focus) return "Pick what to work on";
  if (!done.interview) return "Finish the goals interview";
  return null;
}

function SetupSummary({ data }: { data: SetupData }) {
  const { profile, state } = data;
  const goals = activeGoals(data);
  const metricCount = goals.reduce((sum, g) => sum + g.metrics.length, 0);
  const rhythmsOn = (Object.keys(state.rhythm) as TethrRhythmKey[]).filter((key) => state.rhythm[key].enabled);
  const missing = data.checks.filter((c) => !c.ok && !c.optional);
  const rows: Array<[string, string]> = [
    ["Company", profile?.admin ? `${profile.name}${profile.sells ? `: ${profile.sells}` : ""}` : "not set"],
    ["You", profile?.admin ? `${profile.admin.name}, ${profile.admin.title} (admin)` : "not set"],
    ["Goals", `${goals.length ? goals.map((g) => g.title).join(" · ") : "none yet"} (${metricCount} ${metricCount === 1 ? "metric" : "metrics"})`],
    ["Connections", missing.length ? `${missing.length} still to connect: ${missing.map((m) => m.label.split(" (")[0]).join(", ")}` : "all set"],
    [
      "Growth pace",
      `${data.growthPaces.find((p) => p.key === state.growthPace)?.label ?? ""}${state.autoAdjust ? ", targets adjust on their own" : ", targets stay as set"}`,
    ],
    ["Rhythm", rhythmsOn.length ? rhythmsOn.map((key) => data.rhythms[key].label).join(" · ") : "nothing on its own yet"],
    [
      "Ideas",
      `${data.ideasLevels.find((l) => l.key === state.ideas.level)?.label ?? ""}, ${data.ideasPace.now} right now${state.ideas.slackListen ? ", listening in Slack" : ""}`,
    ],
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
