import { useEffect, useRef, useState, type ReactNode } from "react";
import { Nebula } from "@/components/tethr/Nebula";
import { AgentGlyph, StatusDot } from "@/components/tethr/primitives";
import type { TethrTeamAgent } from "@/api/tethr";
import { agentStatusWords, agentTone } from "@/lib/tethr-team";
import { cn } from "@/lib/utils";
import { AgentAbout } from "./team";

// Who you're talking to, top centre of the chat (Mark, 2026-11-10: "an avatar
// like circle in the middle with a static logo and then when it's working it
// gets animated"). In the main chat it's tethr's mark, still until a turn runs.
// In an agent's chat it's that agent's icon. A tap says what it is; side chats
// and agents carry a small caption, the main chat needs none.

export function ChatAvatar({
  working,
  agent,
  caption,
  companyId,
}: {
  /** A turn is running (or waiting) in this chat. */
  working: boolean;
  /** Set in an agent's own chat. */
  agent?: TethrTeamAgent;
  /** A side chat's title. The main chat has none. */
  caption?: string | null;
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const name = agent ? agent.name : "tethr";
  const label = agent ? `${agent.name}: ${agentStatusWords(agent)}` : working ? "tethr is working" : "tethr, your ongoing chat";
  return (
    <div ref={ref} className="pointer-events-auto relative flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={agent ? `About ${agent.name}` : "tethr"}
        className={cn("tethr-avatar tethr-glass tethr-touch-sized", working && "is-working")}
      >
        {agent ? <AgentGlyph icon={agent.icon} className="h-[18px] w-[18px]" /> : <Nebula still={!working} className="text-[26px] text-foreground" />}
      </button>
      {agent ? (
        <Caption>
          <StatusDot tone={agentTone(agent)} title={agentStatusWords(agent)} />
          <span className="truncate">{agent.name}</span>
        </Caption>
      ) : caption ? (
        <Caption>
          <span className="truncate">{caption}</span>
        </Caption>
      ) : null}
      {open ? (
        <div className="tethr-glass tethr-fix-panel absolute left-1/2 top-12 z-30 w-[min(21rem,85vw)] -translate-x-1/2 space-y-3 rounded-[14px] p-3.5 text-left">
          {agent ? (
            <AgentAbout agent={agent} companyId={companyId} />
          ) : (
            <>
              <p className="text-[13.5px] font-medium">{name}</p>
              <p className="text-[12px] leading-snug text-muted-foreground">
                {caption
                  ? "A side chat with tethr, for one task or project. It shares tethr's memory, goals and team with your ongoing chat."
                  : "Your one ongoing chat with tethr. It's always here and can't be closed; open a side chat for a focused task."}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <span className="flex max-w-[min(56vw,20rem)] items-center gap-1.5 text-[11.5px] leading-none tethr-text-3">{children}</span>;
}
