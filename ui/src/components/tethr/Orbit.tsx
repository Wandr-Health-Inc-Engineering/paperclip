import { cn } from "@/lib/utils";

/**
 * tethr's "still working" loop in the chat's status pill: a small body on an
 * orbit, tethered to a centre point, with a fading trail. The nebula is the
 * avatar's mark (Mark, 2026-11-10: the pill wanted "the same endless loop, just
 * different"). Monochrome (currentColor); styles `.tethr-orbit*` in
 * tethr-theme.css; reduced motion holds it still.
 */
export function Orbit({ className }: { className?: string }) {
  return (
    <span className={cn("tethr-orbit", className)} aria-hidden="true">
      <span className="tethr-orbit-track" />
      <span className="tethr-orbit-arm">
        <span className="tethr-orbit-trail" />
        <span className="tethr-orbit-line" />
        <i />
      </span>
      <span className="tethr-orbit-core" />
    </span>
  );
}
