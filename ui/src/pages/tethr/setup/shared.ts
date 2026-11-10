import { useQueryClient } from "@tanstack/react-query";
import { tethrKeys, type TethrSetup as SetupData, type TethrSetupStepKey } from "@/api/tethr";

// What the setup steps share: the steps themselves, when each counts as done,
// and refreshing the page's data after a save.

export type { SetupData };

/** The forms come first; the goals interview is last and opens the chat. */
export type StepKey = TethrSetupStepKey;

export const STEPS: Array<{ key: StepKey; title: string; blurb: string }> = [
  { key: "company", title: "Your company", blurb: "The company, and you as its admin." },
  { key: "focus", title: "Focus and pace", blurb: "What to work on first, and how hard to push." },
  { key: "connect", title: "Connections", blurb: "What tethr can read to measure the goals." },
  { key: "rhythm", title: "Rhythm and ideas", blurb: "The routines tethr runs, and how often it chimes in." },
  { key: "autonomy", title: "On its own", blurb: "How much tethr does without being asked." },
  { key: "interview", title: "Goals interview", blurb: "tethr pulls real numbers and sets targets with you, in the chat." },
];

export const LAST_STEP: StepKey = "interview";

export interface StepProps {
  companyId: string;
  data: SetupData;
  onDone: () => void;
}

export const SUGGESTED_AREAS = ["New customers", "Revenue", "Partnerships & distribution"];

export const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "UTC",
];

export function activeGoals(data: SetupData) {
  return data.goals.goals.filter((g) => g.status !== "cancelled");
}

/** Every chosen area has a metric with a baseline and a target. */
export function interviewComplete(data: SetupData): boolean {
  const goals = activeGoals(data);
  return goals.length > 0 && goals.every((g) => g.metrics.some((m) => m.baseline !== null && m.target !== null));
}

export function stepDone(data: SetupData): Record<StepKey, boolean> {
  return {
    company: !!data.state.steps.company && !!data.profile?.admin,
    focus: !!data.state.steps.focus && activeGoals(data).length > 0,
    connect: !!data.state.steps.connect,
    rhythm: !!data.state.steps.rhythm,
    autonomy: !!data.state.steps.autonomy,
    // Starting the interview (or finishing without it) completes setup.
    interview: !!data.state.completedAt,
  };
}

/** Refetch setup and goals after a step saves. */
export function useRefreshSetup(companyId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: tethrKeys.setup(companyId) });
    void queryClient.invalidateQueries({ queryKey: tethrKeys.goals(companyId) });
  };
}
