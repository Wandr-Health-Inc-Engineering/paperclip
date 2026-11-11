import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ChoiceChip } from "@/components/tethr/Chip";
import { tethrApi, type TethrGrowthPace } from "@/api/tethr";
import { ErrorLine, Field, PRIMARY_BUTTON, Segmented, StepActions, ToggleRow } from "./controls";
import { SUGGESTED_AREAS, useRefreshSetup, type StepProps } from "./shared";

// Step 2: what to work on first, and how hard the goals push.

const PACE_HELP: Record<TethrGrowthPace, string> = {
  steady: "Targets a little above the current trend. Calm and very likely.",
  balanced: "A real stretch above the trend, still realistic.",
  ambitious: "A big push above the trend. Expect to work for it.",
};

export function FocusStep({ companyId, data, onDone }: StepProps) {
  const refresh = useRefreshSetup(companyId);
  const [areas, setAreas] = useState<string[]>(data.state.areas);
  const [pace, setPace] = useState<TethrGrowthPace>(data.state.growthPace);
  const [autoAdjust, setAutoAdjust] = useState(data.state.autoAdjust);
  const save = useMutation({
    mutationFn: () => tethrApi.setupFocus(companyId, { areas, growthPace: pace, autoAdjust }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const toggleArea = (area: string) => setAreas((list) => (list.includes(area) ? list.filter((x) => x !== area) : [...list, area]));
  const companySaved = !!data.profile?.admin;

  return (
    <div className="space-y-4">
      {!companySaved ? <p className="text-[12.5px] text-[var(--tethr-bad)]">Save your company first.</p> : null}
      <Field label="What to work on first" help="The goal areas. Numbers come in the goals interview.">
        <div className="flex flex-wrap gap-1.5">
          {[...new Set([...SUGGESTED_AREAS, ...areas])].map((area) => (
            <ChoiceChip key={area} selected={areas.includes(area)} onClick={() => toggleArea(area)} marked>
              {area}
            </ChoiceChip>
          ))}
          <AddArea onAdd={(area) => setAreas((list) => [...new Set([...list, area])])} />
        </div>
      </Field>
      <Field label="Growth pace" help="How far above the current trend the targets aim.">
        <Segmented
          value={pace}
          onChange={setPace}
          options={data.growthPaces.map((p) => ({ value: p.key, label: p.label, note: `+${Math.round(p.uplift * 100)}%` }))}
        />
        <span className="block text-[12px] text-muted-foreground">{PACE_HELP[pace]}</span>
      </Field>
      <ToggleRow title="Let tethr adjust targets" on={autoAdjust} onChange={setAutoAdjust}>
        As real numbers come in, tethr eases a target that's out of reach or raises one you're beating, in small steps, and tells you each time.
      </ToggleRow>
      <ErrorLine error={save.error} />
      <StepActions>
        <button type="button" onClick={() => save.mutate()} disabled={!areas.length || !companySaved || save.isPending} className={PRIMARY_BUTTON}>
          Save and continue
        </button>
      </StepActions>
    </div>
  );
}

function AddArea({ onAdd }: { onAdd: (area: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && text.trim()) {
          onAdd(text.trim());
          setText("");
        }
      }}
      placeholder="Add another"
      aria-label="Add a goal area"
      className="h-8 w-36 text-[12.5px]"
    />
  );
}
