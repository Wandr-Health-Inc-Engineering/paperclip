import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/brand";

interface TethrWordmarkProps {
  className?: string;
  /** Render as "tethr" (default, matches voice rules) or "Tethr" for formal contexts like bios. */
  variant?: "lowercase" | "formal";
}

/**
 * tethr wordmark — lowercase by default, Geist 500 with tight tracking
 * (Smoked Glass reskin; the logo lockup is still to be designed).
 * Use `variant="formal"` only in bio / signature contexts.
 */
export function TethrWordmark({ className, variant = "lowercase" }: TethrWordmarkProps) {
  const label = variant === "formal" ? APP_NAME[0]!.toUpperCase() + APP_NAME.slice(1) : APP_NAME;
  return (
    <span
      className={cn("inline-block font-sans font-medium leading-none", className)}
      style={{ letterSpacing: "-0.035em" }}
    >
      {label}
    </span>
  );
}
