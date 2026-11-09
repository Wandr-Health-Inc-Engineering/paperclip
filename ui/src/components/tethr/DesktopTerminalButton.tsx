import { useEffect, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { cn } from "@/lib/utils";

// The Tethr desktop app's built-in terminal (2026-11-09, Mark: "a small icon at
// the bottom I can click… so I don't have a separate terminal"). The icon only
// appears inside the desktop app, and it only asks the app to show or hide its
// terminal panel. The shell runs in the app itself, in a separate view; this
// page can't type into it or read from it.

interface Bridge {
  postMessage: (message: unknown) => void;
}

/** The desktop app's message handler, when this page runs inside Tethr.app. */
export function desktopBridge(): Bridge | null {
  if (typeof window === "undefined" || !navigator.userAgent.includes("TethrDesktop/")) return null;
  const handlers = (window as unknown as { webkit?: { messageHandlers?: Record<string, Bridge | undefined> } }).webkit?.messageHandlers;
  return handlers?.tethrApp ?? null;
}

export function DesktopTerminalButton({ className }: { className?: string }) {
  const [bridge] = useState(desktopBridge);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    const onState = (event: Event) => setOpen(Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open));
    window.addEventListener("tethr-terminal", onState);
    bridge.postMessage({ terminal: "state" });
    return () => window.removeEventListener("tethr-terminal", onState);
  }, [bridge]);

  if (!bridge) return null;
  const label = open ? "Hide the terminal (⌃`)" : "Open a terminal (⌃`)";
  return (
    <button
      type="button"
      onClick={() => bridge.postMessage({ terminal: "toggle" })}
      aria-pressed={open}
      aria-label={label}
      title={label}
      className={cn(
        "tethr-touch-sized grid h-8 w-8 shrink-0 place-items-center rounded-full text-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground",
        open && "bg-accent/60 text-foreground",
        className,
      )}
    >
      <SquareTerminal className="h-4 w-4" />
    </button>
  );
}
