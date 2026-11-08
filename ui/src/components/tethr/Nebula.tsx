import { cn } from "@/lib/utils";

/**
 * tethr's "working" mark: a small nebula, soft clouds drifting around a bright
 * core with motes on tilted orbits, looping for as long as a turn runs.
 * Monochrome (currentColor), so it reads in Day and Night. Styles:
 * `.tethr-nebula*` in tethr-theme.css; reduced motion shows it still.
 */
export function Nebula({ className }: { className?: string }) {
  return (
    <span className={cn("tethr-nebula", className)} aria-hidden="true">
      <span className="tethr-nebula-cloud" />
      <span className="tethr-nebula-cloud tethr-nebula-cloud-inner" />
      <span className="tethr-nebula-core" />
      <span className="tethr-nebula-orbit">
        <i />
      </span>
      <span className="tethr-nebula-orbit tethr-nebula-orbit-tight">
        <i />
      </span>
      <span className="tethr-nebula-orbit tethr-nebula-orbit-wide">
        <i />
      </span>
    </span>
  );
}
