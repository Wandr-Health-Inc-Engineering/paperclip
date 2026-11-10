import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { ApiError } from "@/api/client";
import { ErrorLine, PRIMARY_BUTTON, Segmented, StepActions, ToggleRow } from "./controls";
import { useRefreshSetup, type StepProps } from "./shared";

// Step 5, "On its own": the switches that decide how much tethr does without
// being asked. They all live in Integrations too; this puts the ones that
// matter in front of a new team once. Nothing applies until Save.

const REVIEW_TIMES = [
  { value: "07:30", label: "7:30" },
  { value: "08:30", label: "8:30" },
  { value: "09:30", label: "9:30" },
];

export function AutonomyStep({ companyId, data, onDone }: StepProps) {
  const refresh = useRefreshSetup(companyId);
  const queryClient = useQueryClient();
  const now = data.autonomy;
  // A first visit starts from the picks we'd recommend; after that, from what's saved.
  const firstVisit = !data.state.steps.autonomy;
  const [newAgents, setNewAgents] = useState(now.newAgents);
  const [actOnReports, setActOnReports] = useState(firstVisit ? true : now.actOnReports);
  const [reviewOn, setReviewOn] = useState(firstVisit ? true : now.dailyReview.enabled);
  const [reviewTime, setReviewTime] = useState(REVIEW_TIMES.some((t) => t.value === now.dailyReview.time) ? now.dailyReview.time : "08:30");
  const [learner, setLearner] = useState(now.learner);
  const [toolActions, setToolActions] = useState<"ask" | "auto">(now.defaultMode === "auto" ? "auto" : "ask");

  const save = useMutation({
    mutationFn: () =>
      tethrApi.setupAutonomy(companyId, {
        newAgents,
        actOnReports,
        dailyReview: { enabled: reviewOn, time: reviewTime, weekdaysOnly: now.dailyReview.weekdaysOnly },
        learner,
        defaultMode: toolActions,
      }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: tethrKeys.integrations(companyId) });
      onDone();
    },
  });

  return (
    <div className="space-y-5">
      <p className="text-[12.5px] text-muted-foreground">
        Left alone, tethr answers when you write to it and waits. These decide when it comes to you. Money, anything public and anything medical
        always ask you first, whatever you pick here.
      </p>

      <Group title="Coming to you">
        <ToggleRow title="Daily review" on={reviewOn} onChange={setReviewOn}>
          Each weekday morning tethr checks the goals and the team and decides the day's moves. Recommended.
        </ToggleRow>
        {reviewOn ? (
          <div className="flex flex-wrap items-center gap-2.5 pl-0.5">
            <span className="text-[12px] tethr-text-3">At</span>
            <Segmented value={reviewTime} onChange={setReviewTime} options={REVIEW_TIMES} />
            <span className="text-[12px] tethr-text-3">{data.state.timezone}</span>
          </div>
        ) : null}
        <ToggleRow title="Check-ins when agents report" on={actOnReports} onChange={setActOnReports}>
          When an agent reports back, tethr reads it and acts on it instead of waiting for you to ask. Recommended.
        </ToggleRow>
      </Group>

      <Group title="Its team">
        <div className="space-y-2">
          <p className="text-[13px] font-medium">New agents</p>
          <Segmented
            value={newAgents}
            onChange={setNewAgents}
            options={[
              { value: "ask", label: "Ask me", note: "recommended" },
              { value: "auto", label: "Automatic" },
            ]}
          />
          <p className="text-[12px] text-muted-foreground">
            {newAgents === "ask"
              ? "tethr proposes an agent as a card; it's created when you approve."
              : "tethr creates agents itself, inside the team's limits (how many, and the monthly budget). Raising a budget still asks."}
          </p>
        </div>
        <ToggleRow title="Learner (@sage)" on={learner} onChange={setLearner}>
          An agent that studies how other companies grow once a week and brings back lessons. You choose which ones to apply. It works in a sealed
          room: it can read the web, never your tools or memory.
        </ToggleRow>
      </Group>

      <Group title="Your tools">
        <div className="space-y-2">
          <p className="text-[13px] font-medium">Actions in your connected tools</p>
          <Segmented
            value={toolActions}
            onChange={setToolActions}
            options={[
              { value: "ask", label: "Ask me", note: "recommended" },
              { value: "auto", label: "Automatic" },
            ]}
          />
          <p className="text-[12px] text-muted-foreground">
            {toolActions === "ask"
              ? "Reading is free. Anything that changes, sends or creates waits for your OK in a card."
              : "Changes inside your tools just happen. Money, anything public and anything medical still ask."}
          </p>
        </div>
        <HermesMemoryRow companyId={companyId} />
      </Group>

      <ErrorLine error={save.error} />
      <StepActions>
        <span className="text-[12px] tethr-text-3">You can change any of these later in Integrations.</span>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className={PRIMARY_BUTTON}>
          {save.isPending ? "Saving…" : "Save and continue"}
        </button>
      </StepActions>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3.5">
      <p className="tethr-eyebrow">{title}</p>
      <div className="tethr-inset space-y-4 px-3.5 py-3.5">{children}</div>
    </section>
  );
}

/** Memory in Hermes, when Hermes is on this computer. Switches at once (it moves notes), not with Save. */
function HermesMemoryRow({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const memory = useQuery({ queryKey: tethrKeys.memory(companyId), queryFn: () => tethrApi.memory(companyId) });
  const toggle = useMutation({
    mutationFn: (on: boolean) => tethrApi.setHermesMemory(companyId, on),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: tethrKeys.memory(companyId) }),
  });
  const hermes = memory.data?.hermes;
  if (!hermes?.installed) return null;
  const adminOnly = toggle.error instanceof ApiError && toggle.error.status === 403;
  return (
    <div className="space-y-1.5">
      <ToggleRow title="Memory in Hermes" on={toggle.isPending ? !!toggle.variables : hermes.on} onChange={(on) => toggle.mutate(on)}>
        Keeps tethr's notes and every past conversation searchable in Hermes on this computer. Hermes only stores; it never runs a model. Switches
        right away.
      </ToggleRow>
      {adminOnly ? <p className="text-[12px] tethr-text-3">Only the person who runs tethr on this computer can switch this.</p> : <ErrorLine error={toggle.error} />}
    </div>
  );
}
