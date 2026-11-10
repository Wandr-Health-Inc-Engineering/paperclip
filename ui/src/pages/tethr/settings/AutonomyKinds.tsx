import { useEffect, useState, type ReactNode } from "react";
import type { TethrConnectorAutonomy, TethrKindMode } from "@/api/tethr";
import { capProblem } from "@/lib/tethr-autonomy";
import { cn } from "@/lib/utils";

// The three settings a connector has under Automatic (spending with its monthly
// cap, reaching people outside the company, deleting), each "Ask an admin" or
// "Automatic". The same controls on the Integrations page (tethr's own) and in
// an agent's settings sheet (that agent's).

/** A small segmented choice, in the brand's pill style. */
export function Pills<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabledWhy?: string | null }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 items-center gap-0.5 self-start rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)] sm:self-auto">
      {options.map((o) => {
        const off = disabled || !!o.disabledWhy;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            disabled={off}
            title={o.disabledWhy ?? undefined}
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

function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
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

const ASK_AUTO = (autoDisabledWhy?: string | null): Array<{ value: TethrKindMode; label: string; disabledWhy?: string | null }> => [
  { value: "ask", label: "Ask an admin" },
  { value: "auto", label: "Automatic", disabledWhy: autoDisabledWhy },
];

/** The rows for the kinds a connector can do, saved as they change. */
export function AutonomyKinds({
  label,
  kinds,
  readsAccount,
  autonomy,
  onSave,
  disabled,
}: {
  /** The connector's name, for labels. */
  label: string;
  kinds: Array<"spend" | "outside" | "deletes">;
  readsAccount: boolean;
  autonomy: TethrConnectorAutonomy;
  onSave: (autonomy: TethrConnectorAutonomy) => void;
  disabled?: boolean;
}) {
  const [cap, setCap] = useState(autonomy.spend.monthlyCapUsd === null ? "" : String(autonomy.spend.monthlyCapUsd));
  useEffect(() => setCap(autonomy.spend.monthlyCapUsd === null ? "" : String(autonomy.spend.monthlyCapUsd)), [autonomy.spend.monthlyCapUsd]);
  const save = (patch: Partial<TethrConnectorAutonomy>) => onSave({ ...autonomy, ...patch });
  const capNumber = cap.trim() === "" ? null : Number(cap.replace(/[$,\s]/g, ""));
  const problem = cap.trim() === "" ? null : capProblem(capNumber);
  const saveCap = () => {
    if (problem || capNumber === autonomy.spend.monthlyCapUsd) return;
    // No cap means spending can't run on its own.
    save({ spend: { mode: capNumber === null ? "ask" : autonomy.spend.mode, monthlyCapUsd: capNumber === null ? null : Math.round(capNumber) } });
  };
  return (
    <div className="divide-y divide-[var(--tethr-rim)]">
      {kinds.includes("spend") ? (
        <Row
          title="Spending money"
          help={
            readsAccount
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
                  disabled={disabled}
                  onChange={(e) => setCap(e.target.value)}
                  onBlur={saveCap}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  inputMode="decimal"
                  placeholder="none"
                  aria-label={`${label} monthly spending cap`}
                  className="w-16 bg-transparent text-[12.5px] text-foreground outline-none"
                />
              </span>
              <span>a month</span>
            </label>
            <Pills
              label={`${label} spending`}
              value={autonomy.spend.mode}
              disabled={disabled}
              options={ASK_AUTO(autonomy.spend.monthlyCapUsd === null ? "Set a monthly cap first" : null)}
              onChange={(mode) => save({ spend: { ...autonomy.spend, mode } })}
            />
          </div>
        </Row>
      ) : null}
      {kinds.includes("outside") ? (
        <Row title="Reaching people outside the company" help="Email, invites, sharing and public posts to anyone outside the company.">
          <Pills label={`${label} outside people`} value={autonomy.outside} disabled={disabled} options={ASK_AUTO()} onChange={(outside) => save({ outside })} />
        </Row>
      ) : null}
      {kinds.includes("deletes") ? (
        <Row title="Deleting or overwriting" help="Anything that deletes or overwrites. (In an ad account nothing is deleted on its own; tethr pauses instead.)">
          <Pills label={`${label} deletes`} value={autonomy.deletes} disabled={disabled} options={ASK_AUTO()} onChange={(deletes) => save({ deletes })} />
        </Row>
      ) : null}
      {problem ? <p className="py-2 text-[12px] text-[var(--tethr-bad)]">{problem}</p> : null}
    </div>
  );
}
