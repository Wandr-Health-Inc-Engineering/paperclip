import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CHIP_SURFACE } from "@/components/tethr/Chip";

// Small form pieces the setup steps share.

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="block space-y-1.5">
      <span className="block text-[12.5px] font-medium">{label}</span>
      {children}
      {help ? <span className="block text-[11.5px] tethr-text-3">{help}</span> : null}
    </div>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-[12px] text-[var(--tethr-bad)]">{error instanceof Error ? error.message : "Something went wrong."}</p>;
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
      )}
    >
      <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-background transition-[left]", on ? "left-5" : "left-1")} />
    </button>
  );
}

/** A setting with a title, a line of explanation, and its switch. */
export function ToggleRow({ title, children, on, onChange }: { title: string; children: ReactNode; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[12px] text-muted-foreground">{children}</p>
      </div>
      <Toggle on={on} onChange={onChange} label={title} />
    </div>
  );
}

/** One of a few options, as a pill row. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; note?: string }>;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex flex-wrap rounded-full p-0.5", CHIP_SURFACE)}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors",
              selected ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
            {option.note ? <span className={cn("font-mono text-[10.5px]", selected ? "opacity-70" : "tethr-text-3")}>{option.note}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The step's main button, right-aligned. */
export function StepActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

export const PRIMARY_BUTTON = "tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]";
export const GLASS_BUTTON = "tethr-btn tethr-btn-glass h-9 px-4 text-[12.5px]";
