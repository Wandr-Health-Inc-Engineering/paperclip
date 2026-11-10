import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pause, Play, Plus, Settings2, X } from "lucide-react";
import { AgentGlyph, StatusDot } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrAgentSettingsPatch, type TethrAgentTool } from "@/api/tethr";
import { cn } from "@/lib/utils";
import { AutonomyKinds, Pills } from "../settings/AutonomyKinds";

// An agent's own settings, in its pane (Mark, 2026-11-10: "nesting settings for
// the agent within the agent panes themselves is better… if there's a paid ad
// agent that's the head that's where all the settings should live"). What runs
// on its own and what needs approval, then each tool's mode (Read only, Approval
// needed, Automatic) with spending, outside people and deletes under
// Automatic, its limits, and for a lead its sub-team. A sub-agent works under
// its lead's tool settings; its sheet points there. A person's change here
// applies at once.

type ToolMode = "read" | "ask" | "auto";
const MODE_OPTIONS: Array<{ value: ToolMode; label: string }> = [
  { value: "read", label: "Read only" },
  { value: "ask", label: "Approval needed" },
  { value: "auto", label: "Automatic" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "That didn't save.";
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="tethr-eyebrow">{title}</p>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SummaryList({ title, tone, items }: { title: string; tone: "ok" | "warn"; items: string[] }) {
  return (
    <div className="tethr-inset space-y-1.5 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
        <StatusDot tone={tone} />
        {title}
      </p>
      {items.length ? (
        <ul className="space-y-1 text-[12.5px] leading-snug text-muted-foreground">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] tethr-text-3">Nothing yet</p>
      )}
    </div>
  );
}

function NumberField({ label, prefix, suffix, value, min, onSave }: { label: string; prefix?: string; suffix: string; value: number; min: number; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n) && n >= min && n !== value) onSave(n);
    else setText(String(value));
  };
  return (
    <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <span className="min-w-0 flex-1">{label}</span>
      <span className="tethr-inset flex h-8 items-center px-2.5">
        {prefix ? <span className="tethr-text-3">{prefix}</span> : null}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          inputMode="decimal"
          aria-label={label}
          className="w-14 bg-transparent text-right text-[13px] text-foreground outline-none"
        />
      </span>
      <span className="w-16 shrink-0 tethr-text-3">{suffix}</span>
    </label>
  );
}

function ToolRow({
  tool,
  locked,
  onMode,
  onAutonomy,
  onRemove,
}: {
  tool: TethrAgentTool;
  /** A sub-agent's settings live on its lead. */
  locked: boolean;
  onMode: (mode: ToolMode) => void;
  onAutonomy: (autonomy: TethrAgentTool["autonomy"]) => void;
  onRemove: () => void;
}) {
  const off = tool.company === "off";
  const mode: ToolMode = tool.mode === "off" ? "read" : (tool.mode as ToolMode);
  return (
    <div className="space-y-2.5 rounded-[12px] bg-[var(--tethr-frost)] px-3 py-3 shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[13.5px] font-medium">{tool.connector}</span>
        {!locked ? (
          <button type="button" onClick={onRemove} aria-label={`Remove ${tool.connector}`} className="tethr-btn tethr-btn-ghost tethr-touch-sized h-7 w-7 shrink-0 pointer-coarse:h-8 pointer-coarse:w-8">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {off ? (
        <p className="text-[12px] text-muted-foreground">Off in Integrations, so it's off for everyone. Switch it on there first.</p>
      ) : (
        <>
          <Pills label={`${tool.connector} mode`} value={mode} disabled={locked} options={MODE_OPTIONS} onChange={onMode} />
          {!tool.own && !locked ? <p className="text-[11.5px] tethr-text-3">Follows tethr's settings until you change it here.</p> : null}
          {mode === "auto" && tool.kinds.length ? (
            <AutonomyKinds label={tool.connector} kinds={tool.kinds} readsAccount={tool.readsAccount} autonomy={tool.autonomy} onSave={onAutonomy} disabled={locked} />
          ) : null}
        </>
      )}
    </div>
  );
}

export function AgentSettingsSheet({ companyId, tag, onClose }: { companyId: string; tag: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(tag);
  const [adding, setAdding] = useState("");
  const { data, error: loadError } = useQuery({
    queryKey: tethrKeys.agentSettings(companyId, current),
    queryFn: () => tethrApi.agentSettings(companyId, current),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "team"] });
  };
  const save = useMutation({
    mutationFn: (patch: TethrAgentSettingsPatch) => tethrApi.updateAgentSettings(companyId, current, patch),
    onSettled: refresh,
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => tethrApi.setTeamAgentPaused(companyId, current, paused),
    onSettled: refresh,
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const locked = !!data?.settingsFrom;
  const setTool = (connector: string, setting: { mode: ToolMode; autonomy?: TethrAgentTool["autonomy"] }) => save.mutate({ tools: { [connector]: setting } });

  return createPortal(
    <div className="tethr-scrim fixed inset-0 z-[70] flex justify-end" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={data ? `${data.name}'s settings` : "Agent settings"}
        className="tethr-glass-heavy flex h-full w-full max-w-[34rem] flex-col rounded-none sm:rounded-l-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b border-[var(--tethr-rim)] px-5 py-4">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium tracking-[-0.01em]">{data ? `${data.name}'s settings` : "Settings"}</h2>
          <span className="font-mono text-[11px] tethr-text-3">{current}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="tethr-btn tethr-btn-ghost tethr-touch-sized h-8 w-8">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:px-5">
          {loadError ? <p className="text-[13px] text-[var(--tethr-bad)]">{errorText(loadError)}</p> : null}
          {!data ? (
            loadError ? null : <p className="text-[12.5px] tethr-text-3">Loading…</p>
          ) : (
            <>
              {locked ? (
                <div className="tethr-inset flex flex-wrap items-center gap-2 px-3 py-2.5 text-[12.5px]">
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    It works under its lead's settings: they live on {data.settingsFrom}.
                  </span>
                  <button type="button" onClick={() => setCurrent(data.settingsFrom!)} className="tethr-btn tethr-btn-glass h-8 px-3 text-[12px]">
                    Open {data.settingsFrom}'s settings
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}

              <div className="grid gap-2.5 sm:grid-cols-2">
                <SummaryList title="Runs on its own" tone="ok" items={data.summary.onItsOwn} />
                <SummaryList title="Needs your approval" tone="warn" items={data.summary.needsApproval} />
              </div>
              {data.summary.lookOnly.length ? <p className="-mt-3 text-[12px] tethr-text-3">Looks only: {data.summary.lookOnly.join(", ")}</p> : null}

              <Section title="tools">
                {data.tools.length ? (
                  data.tools.map((tool) => (
                    <ToolRow
                      key={tool.connector}
                      tool={tool}
                      locked={locked}
                      onMode={(mode) => setTool(tool.connector, { mode, autonomy: tool.autonomy })}
                      onAutonomy={(autonomy) => setTool(tool.connector, { mode: "auto", autonomy })}
                      onRemove={() => save.mutate({ connectors: data.connectors.filter((c) => c !== tool.connector) })}
                    />
                  ))
                ) : (
                  <p className="text-[12.5px] tethr-text-3">Only web search and its files.</p>
                )}
                {data.canAdd.length ? (
                  <div className="flex items-center gap-2">
                    <select
                      value={adding}
                      onChange={(e) => setAdding(e.target.value)}
                      aria-label="Add a tool"
                      className="tethr-inset h-8 min-w-0 flex-1 bg-transparent px-2.5 text-[12.5px] outline-none"
                    >
                      <option value="">Add a tool…</option>
                      {data.canAdd.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!adding || save.isPending}
                      onClick={() => {
                        save.mutate({ connectors: [...data.connectors, adding] });
                        setAdding("");
                      }}
                      className="tethr-btn tethr-btn-glass h-8 px-3 text-[12px]"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add
                    </button>
                  </div>
                ) : null}
                <p className="text-[11.5px] tethr-text-3">A new tool starts on Approval needed. Anything medical always asks.</p>
              </Section>

              <Section title="limits">
                <div className="space-y-2">
                  <NumberField label="Monthly budget" prefix="$" suffix="a month" value={data.limits.budgetMonthlyUsd} min={1} onSave={(n) => save.mutate({ budgetMonthlyUsd: n })} />
                  <NumberField label="Runs" suffix="a day" value={data.limits.maxRunsPerDay} min={1} onSave={(n) => save.mutate({ maxRunsPerDay: Math.round(n) })} />
                  <p className="text-[11.5px] tethr-text-3">${data.limits.spentMonthlyUsd.toFixed(2)} spent this month. It stops at the budget.</p>
                </div>
              </Section>

              {data.subTeam.length ? (
                <Section title={`its team · ${data.subTeam.length}`}>
                  <p className="-mt-1 text-[11.5px] tethr-text-3">They work under these settings.</p>
                  <ul className="space-y-1.5">
                    {data.subTeam.map((s) => (
                      <li key={s.tag} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-[var(--tethr-select-blur)]">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
                          <AgentGlyph icon={s.icon} className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">
                            {s.name} <span className="font-mono text-[10.5px] tethr-text-3">{s.tag}</span>
                          </span>
                          <span className="block truncate text-[11.5px] tethr-text-3">
                            {s.paused ? "Paused · " : ""}${s.budgetMonthlyUsd} a month · {s.maxRunsPerDay} runs a day
                          </span>
                        </span>
                        <button type="button" onClick={() => setCurrent(s.tag)} className="tethr-btn tethr-btn-ghost h-8 shrink-0 px-2.5 text-[12px]">
                          Open
                          <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {save.isError ? <p className="text-[12.5px] text-[var(--tethr-bad)]">{errorText(save.error)}</p> : null}

              <div className="flex items-center justify-between gap-3 border-t border-[var(--tethr-rim)] pt-4">
                <span className="text-[12px] leading-snug tethr-text-3">{data.paused ? "Paused: no scheduled or assigned runs." : "Changes here apply at once."}</span>
                <button
                  type="button"
                  onClick={() => pause.mutate(!data.paused)}
                  disabled={pause.isPending}
                  className={cn("tethr-btn h-8 shrink-0 px-3.5 text-[12.5px]", data.paused ? "tethr-btn-primary" : "tethr-btn-ghost")}
                >
                  {data.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {data.paused ? "Resume" : "Pause"}
                </button>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
