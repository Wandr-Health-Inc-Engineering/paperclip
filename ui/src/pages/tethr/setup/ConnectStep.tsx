import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrConnectorMode, type TethrSetupCheck } from "@/api/tethr";
import { ApiError } from "@/api/client";
import { CHECK_FIX, type CheckFix, type EnvField } from "./fixes";
import { ErrorLine, GLASS_BUTTON, PRIMARY_BUTTON, Segmented, StepActions } from "./controls";
import { useRefreshSetup, type StepKey, type StepProps } from "./shared";

// Step 3: what tethr can read to measure the goals. "Fix" opens the row in
// place (a key to paste, a mode to pick, or what to do), so setup never
// sends you to another page.

const MODE_OPTIONS: Array<{ value: TethrConnectorMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

const MODE_HELP: Record<TethrConnectorMode, string> = {
  off: "tethr can't use it.",
  read: "tethr can look, but can't change anything.",
  ask: "Changes wait for your OK in a card. Recommended.",
  auto: "Changes just happen. Money, anything public and anything medical still ask.",
};

export function ConnectStep({ companyId, data, onDone, goTo }: StepProps & { goTo: (step: StepKey) => void }) {
  const refresh = useRefreshSetup(companyId);
  const [open, setOpen] = useState<string | null>(null);
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

function FixPanel({ fix, companyId, goTo }: { fix: CheckFix; companyId: string; goTo: (step: StepKey) => void }) {
  return (
    <div className="space-y-3 rounded-[10px] bg-[var(--tethr-frost)] p-3.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{fix.how}</p>
      {fix.kind === "env" ? <EnvFix fields={fix.fields} restart={!!fix.restart} companyId={companyId} /> : null}
      {fix.kind === "connector" ? <ConnectorFix connector={fix.connector} companyId={companyId} /> : null}
      {fix.kind === "step" ? (
        <button type="button" onClick={() => goTo(fix.step)} className={GLASS_BUTTON}>
          Go to step 1
        </button>
      ) : null}
    </div>
  );
}

/** Paste one or more keys; saved to the instance .env (values never come back to the page). */
function EnvFix({ fields, restart, companyId }: { fields: EnvField[]; restart: boolean; companyId: string }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSetup(companyId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const env = useQuery({ queryKey: tethrKeys.env(companyId), queryFn: () => tethrApi.env(companyId), retry: false });
  const isSet = (key: string) => !!env.data?.entries.find((e) => e.key === key)?.set;
  const filled = fields.filter((f) => values[f.key]?.trim());
  const save = useMutation({
    mutationFn: async () => {
      for (const field of filled) await tethrApi.setEnv(companyId, field.key, values[field.key].trim());
    },
    onSuccess: () => {
      setValues({});
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: tethrKeys.env(companyId) });
      refresh();
    },
  });

  if (env.error instanceof ApiError && env.error.status === 403) {
    return <p className="text-[12.5px]">Only the person who runs tethr on this computer can add keys. Ask them, or continue and come back.</p>;
  }
  return (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled.length) save.mutate();
      }}
    >
      {fields.map((field) => (
        <label key={field.key} className="block space-y-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-medium">{field.label}</span>
            <span className="font-mono text-[10.5px] tethr-text-3">{field.key}</span>
            {isSet(field.key) ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] tethr-text-3">
                <StatusDot tone="ok" /> set, leave blank to keep
              </span>
            ) : field.optional ? (
              <span className="text-[11px] tethr-text-3">optional</span>
            ) : null}
          </span>
          <Input
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[field.key] ?? ""}
            onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [field.key]: e.target.value }));
            }}
            placeholder={field.placeholder}
            className="h-9 font-mono text-[12.5px] placeholder:font-sans"
          />
        </label>
      ))}
      <ErrorLine error={save.error} />
      <div className="flex flex-wrap items-center justify-end gap-3 pt-0.5">
        {saved ? (
          <span className="mr-auto inline-flex items-center gap-1.5 text-[12px]">
            <StatusDot tone="ok" />
            {restart ? "Saved. Restart tethr from the launcher to use it." : "Saved."}
          </span>
        ) : null}
        <button type="submit" disabled={!filled.length || save.isPending} className={PRIMARY_BUTTON}>
          {save.isPending ? "Saving…" : filled.length > 1 ? `Save ${filled.length}` : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Pick what tethr may do with a connector, saved straight to Integrations. */
function ConnectorFix({ connector, companyId }: { connector: string; companyId: string }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSetup(companyId);
  const integrations = useQuery({ queryKey: tethrKeys.integrations(companyId), queryFn: () => tethrApi.integrations(companyId) });
  const current = integrations.data?.connectors.find((c) => c.label === connector)?.mode ?? "off";
  const update = useMutation({
    mutationFn: (mode: TethrConnectorMode) => tethrApi.updateIntegrations(companyId, { connectors: { [connector]: { mode } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.integrations(companyId) });
      refresh();
    },
  });
  const shown = update.isPending && update.variables ? update.variables : current;
  return (
    <div className="space-y-2">
      <Segmented value={shown} onChange={(mode) => update.mutate(mode)} options={MODE_OPTIONS} />
      <p className="text-[12px] tethr-text-3">{MODE_HELP[shown]}</p>
      <ErrorLine error={update.error} />
    </div>
  );
}
