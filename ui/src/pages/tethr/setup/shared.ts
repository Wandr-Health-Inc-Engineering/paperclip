import { useQueryClient } from "@tanstack/react-query";
import { tethrKeys, type TethrSetup as SetupData } from "@/api/tethr";

// What the setup steps share: the steps themselves, when each counts as done,
// and refreshing the page's data after a save.

export type { SetupData };

export type StepKey = "company" | "focus" | "connect" | "interview" | "rhythm" | "finish";

export const STEPS: Array<{ key: StepKey; title: string; blurb: string }> = [
  { key: "company", title: "Your company", blurb: "The company, and you as its admin." },
  { key: "focus", title: "Focus and pace", blurb: "What to work on first, and how hard to push." },
  { key: "connect", title: "Connections", blurb: "What tethr can read to measure the goals." },
  { key: "interview", title: "Goals interview", blurb: "tethr pulls real numbers and sets targets with you." },
  { key: "rhythm", title: "Rhythm and ideas", blurb: "What tethr does on its own, and how often it chimes in." },
  { key: "finish", title: "Finish", blurb: "Check it over and start." },
];

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
    interview: !!data.state.steps.interview || interviewComplete(data),
    rhythm: !!data.state.steps.rhythm,
    finish: !!data.state.completedAt,
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
