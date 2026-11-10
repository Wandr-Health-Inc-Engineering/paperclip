import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { formatRelative } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrConnectorAutonomy, type TethrIntegrationConnector } from "@/api/tethr";
import { autonomySummary, spendLine } from "@/lib/tethr-autonomy";
import { cn } from "@/lib/utils";
import { AutonomyKinds } from "./AutonomyKinds";

// What a connector may do on its own for tethr itself (Mark, 2026-11-10: "any
// connector needs to have ability to be autonomous or manual with approval").
// Under every connector on the Integrations page: spending (with its monthly
// cap), reaching people outside the company, and deleting, each "Ask an admin"
// or "Automatic". Anything medical always asks. Below it, what was done there
// lately. Each agent has its own settings in its pane (chat/agent-settings.tsx).

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
  const { data: activity } = useQuery({
    queryKey: tethrKeys.connectorActivity(companyId, connector.label),
    queryFn: () => tethrApi.connectorActivity(companyId, connector.label),
    enabled: open,
  });
  const auto = connector.mode === "auto";

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
            <>
              <AutonomyKinds label={connector.label} kinds={connector.kinds} readsAccount={connector.readsAccount} autonomy={autonomy} onSave={onSave} />
              <p className="border-t border-[var(--tethr-rim)] pt-2.5 text-[11.5px] tethr-text-3">Anything medical always asks. Read only stops every change at once.</p>
            </>
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
