import { useMutation } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi } from "@/api/tethr";
import { Link } from "../../../lib/router";
import { ErrorLine, PRIMARY_BUTTON, StepActions } from "./controls";
import { useRefreshSetup, type StepProps } from "./shared";

// Step 3: what tethr can read to measure the goals, with a way to fix each.

export function ConnectStep({ companyId, data, onDone }: StepProps) {
  const refresh = useRefreshSetup(companyId);
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
        tethr measures the goals with these. Connectors come from your Claude account; keys live on the Environment page. Anything outward still asks
        you first.
      </p>
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {data.checks.map((check) => (
          <div key={check.key} className="flex items-center gap-3 px-3 py-2.5">
            <StatusDot tone={check.ok ? "ok" : check.optional ? "idle" : "warn"} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{check.label}</span>
              <span className="block truncate text-[11.5px] tethr-text-3">{check.ok || check.optional ? check.detail : `Needed: ${check.detail}`}</span>
            </span>
            {!check.ok ? (
              <Link to={check.href} className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-3 text-[12px]">
                Fix
              </Link>
            ) : null}
          </div>
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
