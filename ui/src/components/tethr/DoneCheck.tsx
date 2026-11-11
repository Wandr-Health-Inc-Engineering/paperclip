import { cn } from "@/lib/utils";

/**
 * A check that draws itself: the ring, then the tick. Shown when a card has been
 * answered (Mark, 2026-11-10: "animate it into a nice check or something to show
 * it was done"). Monochrome (currentColor); styles `.tethr-done*` in
 * tethr-theme.css; reduced motion shows it drawn.
 */
export function DoneCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={cn("tethr-done-check", className)} aria-hidden="true">
      <circle cx="14" cy="14" r="12.25" className="tethr-done-ring" />
      <path d="M8.6 14.6 L12.4 18.2 L19.6 10.4" className="tethr-done-tick" />
    </svg>
  );
}
