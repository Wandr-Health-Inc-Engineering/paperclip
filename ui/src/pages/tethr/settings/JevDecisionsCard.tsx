import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrDecisionKind } from "@/api/tethr";
import { cn } from "@/lib/utils";

// Phase 26.2: Jev decisions on the Integrations page. One row per kind of
// decision: Off, Suggest or Automatic, with its record (how often Jev's pick
// was what you went with, the backtest) and why Automatic isn't open yet.
// Automatic has to be earned; two undone automatic decisions in a week put a
// kind back to Suggest on its own.

const MODES: Array<{ value: TethrDecisionKind["mode"]; label: string }> = [
  { value: "off", label: "Off" },
  { value: "suggest", label: "Suggest" },
  { value: "auto", label: "Automatic" },
];

function KindRow({ kind, companyId, onError }: { kind: TethrDecisionKind; companyId: string; onError: (msg: string | null) => void }) {
  const queryClient = useQueryClient();
  const set = useMutation({
    mutationFn: (mode: string) => tethrApi.setDecisions(companyId, { kind: kind.key, mode }),
    onSuccess: (data) => {
      onError(null);
      queryClient.setQueryData(tethrKeys.decisions(companyId), data);
    },
    onError: (err) => onError(err instanceof Error ? err.message : String(err)),
  });
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13.5px]">{kind.label}</p>
        <div role="radiogroup" aria-label={kind.label} className="inline-flex rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
          {MODES.map((m) => {
            const locked = m.value === "auto" && (kind.neverAuto || !!kind.autoBlocked) && kind.mode !== "auto";
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={kind.mode === m.value}
                disabled={set.isPending || locked}
                title={locked ? (kind.autoBlocked ?? undefined) : undefined}
                onClick={() => set.mutate(m.value)}
                className={cn(
                  "tethr-touch-sized h-7 rounded-full px-3 text-[12px] transition-colors disabled:opacity-40",
                  kind.mode === m.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>
      <p className="text-[12px] text-muted-foreground">{kind.about}</p>
      {kind.sendsConversation ? <p className="text-[12px] text-[var(--tethr-warn)]">It sends what people said in Slack to TypeSafe, so it's off until you switch it on.</p> : null}
      <p className="font-mono text-[11px] tethr-text-3">
        {kind.backtest}
        {kind.bar !== null ? ` · acts alone above ${Math.round(kind.bar * 100)}% sure` : ""}
        {kind.pending ? ` · ${kind.pending} waiting on you` : ""}
        {!kind.neverAuto && kind.autoBlocked && kind.mode !== "auto" ? ` · Automatic: ${kind.autoBlocked}` : ""}
      </p>
    </div>
  );
}

export function JevDecisionsCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: tethrKeys.decisions(companyId), queryFn: () => tethrApi.decisions(companyId) });
  const [cap, setCap] = useState<string>("");
  const saveCap = useMutation({
    mutationFn: () => tethrApi.setDecisions(companyId, { monthlyCapUsd: Number(cap) }),
    onSuccess: (d) => {
      setCap("");
      queryClient.setQueryData(tethrKeys.decisions(companyId), d);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });
  if (!data) return null;
  const over = data.spentUsd >= data.capUsd;
  return (
    <section className="tethr-panel overflow-hidden">
      <header className="space-y-1.5 border-b tethr-rule px-4 py-3">
        <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          <StatusDot tone={data.jev.toLowerCase().includes("connected") ? "ok" : "idle"} />
          Jev decisions
        </p>
        <p className="text-sm text-muted-foreground">
          Jev makes tethr's quick calls (where a file goes, whether a report needs you, how good a lesson is). Suggest shows its pick for you to tap;
          Automatic acts when Jev is sure enough, once its record has earned it. Money, anything public and anything medical never run on their own.
        </p>
        <p className="font-mono text-[11px] tethr-text-3">
          {data.jev} · ${data.spentUsd.toFixed(4)} of ${data.capUsd.toFixed(2)} this month{over ? " · cap reached: items come to you without a suggestion" : ""}
        </p>
      </header>
      <div className="divide-y divide-[var(--tethr-rim)]">
        {data.kinds.map((k) => (
          <KindRow key={k.key} kind={k} companyId={companyId} onError={setError} />
        ))}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t tethr-rule px-4 py-3">
        <label className="text-[12.5px] text-muted-foreground" htmlFor="jev-cap">
          Monthly cap ($)
        </label>
        <input
          id="jev-cap"
          inputMode="decimal"
          placeholder={data.capUsd.toFixed(2)}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className="tethr-inset h-8 w-24 rounded-[10px] px-2.5 text-[13px]"
        />
        <button type="button" disabled={!cap || saveCap.isPending} onClick={() => saveCap.mutate()} className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]">
          Save
        </button>
        {error ? <p className="w-full text-[12px] text-[var(--tethr-bad)]">{error}</p> : null}
      </footer>
    </section>
  );
}
