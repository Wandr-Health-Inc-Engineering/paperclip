import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, type TethrSetupCheck } from "@/api/tethr";
import { CHECK_FIX } from "./fixes";
import { FixPanel } from "./FixPanel";
import { ErrorLine, PRIMARY_BUTTON, StepActions } from "./controls";
import { useRefreshSetup, type StepKey, type StepProps } from "./shared";

// Step 3: what tethr can read to measure the goals. "Fix" opens the row in
// place (a key to paste, a mode to pick, or what to do), so setup never
// sends you to another page.

export function ConnectStep({ companyId, data, onDone, goTo }: StepProps & { goTo: (step: StepKey) => void }) {
  const refresh = useRefreshSetup(companyId);
  // Someone wrote to tethr in Slack and isn't linked yet: open that row, "That's me" is one tap.
  const [open, setOpen] = useState<string | null>(data.state.slackClaim && !data.profile?.admin?.slackUserId ? "approver" : null);
  // Re-read the checks on arrival: a key may have been added since the page loaded.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit to the step
  }, []);
  const markDone = useMutation({
    mutationFn: () => tethrApi.setupStep(companyId, "connect"),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const missing = data.checks.filter((c) => !c.ok && !c.optional);
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        tethr measures the goals with these. Connectors come from your Claude account; keys are saved to this computer's tethr settings. Fix opens
        each one right here. Anything outward still asks you first.
      </p>
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {data.checks.map((check) => (
          <CheckRow
            key={check.key}
            check={check}
            companyId={companyId}
            open={open === check.key}
            onToggle={() => setOpen((current) => (current === check.key ? null : check.key))}
            goTo={goTo}
          />
        ))}
      </div>
      <ErrorLine error={markDone.error} />
      <StepActions>
        {missing.length ? <span className="text-[12px] tethr-text-3">{missing.length} not connected yet; you can continue and fix them later.</span> : null}
        <button type="button" onClick={() => markDone.mutate()} disabled={markDone.isPending} className={PRIMARY_BUTTON}>
          Continue
        </button>
      </StepActions>
    </div>
  );
}

function CheckRow({
  check,
  companyId,
  open,
  onToggle,
  goTo,
}: {
  check: TethrSetupCheck;
  companyId: string;
  open: boolean;
  onToggle: () => void;
  goTo: (step: StepKey) => void;
}) {
  const fix = CHECK_FIX[check.key];
  const panelId = `fix-${check.key}`;
  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <StatusDot tone={check.ok ? "ok" : check.optional ? "idle" : "warn"} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px]">{check.label}</span>
          <span className="block truncate text-[11.5px] tethr-text-3">{check.ok || check.optional ? check.detail : `Needed: ${check.detail}`}</span>
        </span>
        {fix && (open || !check.ok) ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            className="tethr-btn tethr-btn-ghost tethr-touch-sized h-7 shrink-0 px-3 text-[12px]"
          >
            {open ? "Close" : check.optional ? "Add" : "Fix"}
          </button>
        ) : null}
      </div>
      {fix && open ? (
        <div id={panelId} className="tethr-fix-panel px-3 pb-3.5">
          <FixPanel fix={fix} companyId={companyId} goTo={goTo} />
        </div>
      ) : null}
    </div>
  );
}
