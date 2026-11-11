import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Segmented } from "@/pages/tethr/setup/controls";
import { tethrApi, tethrKeys, type TethrLearning, type TethrLearningPace } from "@/api/tethr";

// The learner's pace and whether its skills save on their own (2026-11-10, Mark:
// "I should be able to get sage to run however often I want based on how
// aggressive learning"). Shown on Integrations → Learning and in Sage's settings
// sheet. Each change saves at once.

const PRESETS: Array<{ value: TethrLearningPace["preset"]; label: string }> = [
  { value: "light", label: "Light" },
  { value: "steady", label: "Steady" },
  { value: "aggressive", label: "Aggressive" },
  { value: "custom", label: "Custom" },
];

const PRESET_NOTE: Record<Exclude<TethrLearningPace["preset"], "custom">, string> = {
  light: "Watches Monday and Thursday mornings; at most 1 study a day, quick ones, and only for a clear gap.",
  steady: "Watches every weekday morning; at most 2 studies a day, and a deep one at most once a week.",
  aggressive: "Watches every 2 hours on weekdays; up to 6 studies a day, deep when the gap is big. Uses your Claude plan's limits faster.",
};

const HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

const FIELD = "tethr-inset tethr-touch-sized h-8 rounded-[10px] px-2.5 text-[13px] pointer-coarse:h-10";

export function LearningPaceControls({ companyId, learner }: { companyId: string; learner: TethrLearning["learner"] }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TethrLearningPace | null>(null);
  const pace = draft ?? learner.pace;
  const save = useMutation({
    mutationFn: (body: { pace?: TethrLearningPace; applyMode?: "auto" | "ask" }) => tethrApi.learningSettings(companyId, body),
    onSuccess: () => setDraft(null),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) });
      void queryClient.invalidateQueries({ queryKey: tethrKeys.team(companyId) });
    },
  });
  const setPace = (next: TethrLearningPace) => {
    setDraft(next);
    save.mutate({ pace: next });
  };
  const custom = { everyHours: 24, days: "weekdays" as const, cap: 2, depth: "quick" as const, eager: false, ...pace };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-[12.5px] font-medium">How much it learns on its own</p>
        <Segmented value={pace.preset} onChange={(preset) => setPace(preset === "custom" ? { ...custom, preset } : { preset })} options={PRESETS} />
        {pace.preset !== "custom" ? (
          <p className="text-[12px] text-muted-foreground">{PRESET_NOTE[pace.preset]}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px] text-muted-foreground">
            <label className="flex items-center gap-1.5">
              Every
              <select value={custom.everyHours} onChange={(e) => setPace({ ...custom, preset: "custom", everyHours: Number(e.target.value) })} className={FIELD} aria-label="How often it watches">
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h === 1 ? "hour" : h === 24 ? "day" : `${h} hours`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              on
              <select value={custom.days} onChange={(e) => setPace({ ...custom, preset: "custom", days: e.target.value === "every" ? "every" : "weekdays" })} className={FIELD} aria-label="Which days">
                <option value="weekdays">weekdays</option>
                <option value="every">every day</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              up to
              <input
                type="number"
                min={1}
                max={10}
                value={custom.cap}
                onChange={(e) => setDraft({ ...custom, preset: "custom", cap: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })}
                onBlur={() => draft && save.mutate({ pace: draft })}
                className={`${FIELD} w-14`}
                aria-label="Studies a day"
              />
              a day
            </label>
            <Segmented
              value={custom.depth}
              onChange={(depth) => setPace({ ...custom, preset: "custom", depth })}
              options={[
                { value: "quick", label: "Quick" },
                { value: "deep", label: "Deep allowed" },
              ]}
            />
            <Segmented
              value={custom.eager ? "eager" : "picky"}
              onChange={(v) => setPace({ ...custom, preset: "custom", eager: v === "eager" })}
              options={[
                { value: "picky", label: "Only clear gaps" },
                { value: "eager", label: "Always find something" },
              ]}
            />
          </div>
        )}
        <p className="text-[12px] tethr-text-3">Now: {learner.schedule.words}, up to {learner.schedule.cap} a day on its own. You can always ask it to learn something.</p>
      </div>
      <div className="space-y-1.5">
        <p className="text-[12.5px] font-medium">What it learns</p>
        <Segmented
          value={learner.applyMode}
          onChange={(applyMode) => save.mutate({ applyMode })}
          options={[
            { value: "auto", label: "Saves skills on its own" },
            { value: "ask", label: "Asks first" },
          ]}
        />
        <p className="text-[12px] text-muted-foreground">
          {learner.applyMode === "auto"
            ? "Each skill is checked, then saved; tethr uses it from its next turn. Undo any of them. A change to a skill tethr or you saved still asks."
            : "Each skill comes to you as a card first."}
        </p>
      </div>
      {save.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(save.error as Error).message}</p> : null}
    </div>
  );
}
