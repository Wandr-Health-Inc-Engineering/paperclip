import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { formatRelative } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrConnectorAutonomy, type TethrIntegrationConnector, type TethrKindMode } from "@/api/tethr";
import { autonomySummary, capProblem, spendLine } from "@/lib/tethr-autonomy";
import { cn } from "@/lib/utils";

// What a connector may do on its own (Mark, 2026-11-10: "any connector needs to
// have ability to be autonomous or manual with approval"). The same panel under
// every connector on the Integrations page: spending (with its monthly cap),
// reaching people outside the company, and deleting, each "Ask an admin" or
// "Automatic". Anything medical always asks. Below it, what tethr did there lately.

const KIND_TITLE = {
  spend: "Spending money",
  outside: "Reaching people outside the company",
  deletes: "Deleting or overwriting",
} as const;

const KIND_HELP = {
  outside: "Email, invites, sharing and public posts to anyone outside the company.",
  deletes: "Anything that deletes or overwrites. (In an ad account nothing is deleted on its own; tethr pauses instead.)",
} as const;

function Choice({ value, onChange, autoDisabled }: { value: TethrKindMode; onChange: (v: TethrKindMode) => void; autoDisabled?: string | null }) {
  const options: Array<{ value: TethrKindMode; label: string }> = [
    { value: "ask", label: "Ask an admin" },
    { value: "auto", label: "Automatic" },
  ];
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 self-start rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)] sm:self-auto">
      {options.map((o) => {
        const disabled = o.value === "auto" && !!autoDisabled;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={disabled}
            title={disabled ? (autoDisabled ?? undefined) : undefined}
            onClick={() => value !== o.value && onChange(o.value)}
            className={cn(
              "tethr-touch-sized h-7 rounded-full px-3 text-[12px] transition-colors disabled:pointer-events-none disabled:opacity-30",
              value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11.5px] leading-snug tethr-text-3">{help}</p>
      </div>
      {children}
    </div>
  );
}

export function ConnectorAutonomy({
  companyId,
  connector,
  onSave,
}: {
  companyId: string;
  connector: TethrIntegrationConnector;
  onSave: (autonomy: TethrConnectorAutonomy) => void;
}) {
  const [open, setOpen] = useState(false);
  const autonomy = connector.autonomy;
  const [cap, setCap] = useState(autonomy.spend.monthlyCapUsd === null ? "" : String(autonomy.spend.monthlyCapUsd));
  useEffect(() => setCap(autonomy.spend.monthlyCapUsd === null ? "" : String(autonomy.spend.monthlyCapUsd)), [autonomy.spend.monthlyCapUsd]);
  const { data: activity } = useQuery({
    queryKey: tethrKeys.connectorActivity(companyId, connector.label),
    queryFn: () => tethrApi.connectorActivity(companyId, connector.label),
    enabled: open,
  });
  const auto = connector.mode === "auto";
  const save = (patch: Partial<TethrConnectorAutonomy>) => onSave({ ...autonomy, ...patch });
  const capNumber = cap.trim() === "" ? null : Number(cap.replace(/[$,\s]/g, ""));
  const problem = capProblem(capNumber);
  const saveCap = () => {
    if (problem && cap.trim() !== "") return;
    if (capNumber === autonomy.spend.monthlyCapUsd) return;
    // No cap means spending can't be automatic.
    save({ spend: { mode: capNumber === null ? "ask" : autonomy.spend.mode, monthlyCapUsd: capNumber === null ? null : Math.round(capNumber) } });
  };

  return (
    <div className="rounded-[10px] bg-[var(--tethr-frost)] shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted-foreground">
          {auto ? autonomySummary(connector.kinds, autonomy) : "Changes ask first. Switch to Automatic to choose what runs on its own."}
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="border-t border-[var(--tethr-rim)] px-3 pb-3">
          {auto ? (
            <div className="divide-y divide-[var(--tethr-rim)]">
              {connector.kinds.includes("spend") ? (
                <Row
                  title={KIND_TITLE.spend}
                  help={
                    connector.readsAccount
                      ? "Budgets, turning things on, purchases. The cap is checked against what the account plans to spend."
                      : "Purchases and payments. The cap counts what tethr's own calls commit; a call with no amount always asks."
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <span>Cap</span>
                      <span className="tethr-inset flex h-7 items-center px-2">
                        <span className="tethr-text-3">$</span>
                        <input
                          value={cap}
                          onChange={(e) => setCap(e.target.value)}
                          onBlur={saveCap}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          inputMode="decimal"
                          placeholder="none"
                          aria-label={`${connector.label} monthly spending cap`}
                          className="w-16 bg-transparent text-[12.5px] text-foreground outline-none"
                        />
                      </span>
                      <span>a month</span>
                    </label>
                    <Choice
                      value={autonomy.spend.mode}
                      onChange={(mode) => save({ spend: { ...autonomy.spend, mode } })}
                      autoDisabled={autonomy.spend.monthlyCapUsd === null ? "Set a monthly cap first" : null}
                    />
                  </div>
                </Row>
              ) : null}
              {connector.kinds.includes("outside") ? (
                <Row title={KIND_TITLE.outside} help={KIND_HELP.outside}>
                  <Choice value={autonomy.outside} onChange={(outside) => save({ outside })} />
                </Row>
              ) : null}
              {connector.kinds.includes("deletes") ? (
                <Row title={KIND_TITLE.deletes} help={KIND_HELP.deletes}>
                  <Choice value={autonomy.deletes} onChange={(deletes) => save({ deletes })} />
                </Row>
              ) : null}
              {problem && cap.trim() !== "" ? <p className="py-2 text-[12px] text-[var(--tethr-bad)]">{problem}</p> : null}
              <p className="pt-2.5 text-[11.5px] tethr-text-3">Anything medical always asks. Read only stops every change at once.</p>
            </div>
          ) : null}
          <div className={cn("space-y-1.5", auto && "mt-3 border-t border-[var(--tethr-rim)] pt-3")}>
            {activity && connector.kinds.includes("spend") ? <p className="text-[12px] text-muted-foreground">{spendLine(activity)}</p> : null}
            <p className="tethr-eyebrow pt-0.5">recent changes</p>
            {!activity ? (
              <p className="text-[12px] tethr-text-3">Loading…</p>
            ) : activity.recent.length ? (
              <ul className="space-y-1">
                {activity.recent.map((c) => (
                  <li key={c.id} className="flex flex-col gap-0.5 text-[12px] sm:flex-row sm:items-baseline sm:gap-2">
                    <span className="min-w-0 sm:flex-1 sm:truncate">{c.summary}</span>
                    <span className={cn("shrink-0 font-mono text-[10.5px] tethr-text-3", c.ok === false && "text-[var(--tethr-bad)]")}>
                      {c.ok === false ? "failed" : c.how === "auto" ? "on its own" : "approved"} · {c.by} · {formatRelative(c.at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] tethr-text-3">Nothing yet.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
