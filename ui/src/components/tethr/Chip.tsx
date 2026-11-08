import type { ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/** The frosted pill surface chips share (choice chips in setup, file chips in the chat). */
export const CHIP_SURFACE = "bg-[var(--tethr-frost)] shadow-[inset_0_0_0_1px_var(--tethr-rim)]";
export const CHIP_HOVER = "hover:bg-[var(--tethr-frost-strong)]";

/** A pill you pick: ink when selected, frosted otherwise. With `marked`, a check or a plus says which. */
export function ChoiceChip({
  selected,
  onClick,
  marked = false,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  marked?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors",
        selected ? "bg-foreground text-background" : cn(CHIP_SURFACE, CHIP_HOVER),
      )}
    >
      {marked ? selected ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" /> : null}
      {children}
    </button>
  );
}
