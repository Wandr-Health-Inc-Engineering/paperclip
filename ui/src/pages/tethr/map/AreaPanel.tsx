import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Eye, EyeOff, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MonoTag, StatusDot, formatRelative, type StatusTone } from "@/components/tethr/primitives";
import { formatMetric } from "@/components/tethr/Scorecard";
import { tethrApi, tethrKeys, type TethrGrowthArea, type TethrMapMetricState, type TethrMetric } from "@/api/tethr";
import { useNavigate } from "@/lib/router";
import { ringSegment } from "@/lib/tethr-growth-map";

// One area's panel on the growth map (phase 26.9): its level and the six
// unlocks (what earned each, or what would), "Explore with tethr" (an audit in
// the main chat, only when clicked), the last audit, what tethr knows there,
// its numbers, who owns it, its playbooks, its data and what tethr can't see yet.

const METRIC_TONE: Record<TethrMapMetricState, StatusTone> = {
  target_hit: "ok",
  on_track: "ok",
  behind: "warn",
  in_progress: "idle",
  not_measured: "idle",
  no_target: "idle",
};

const METRIC_LABEL: Record<TethrMapMetricState, string> = {
  target_hit: "target hit",
  on_track: "on track",
  behind: "behind",
  in_progress: "in progress",
  not_measured: "not measured yet",
  no_target: "no target yet",
};

/** The six-segment ring, small, for the panel's header and the list. */
export function UnlockRing({ area, size = 40, className }: { area: Pick<TethrGrowthArea, "unlocks" | "level">; size?: number; className?: string }) {
  const c = size / 2;
  const r = size / 2 - 3;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("tethr-galaxy-mini shrink-0", className)} aria-hidden="true">
      {area.unlocks.map((u, i) => (
        <path key={u.key} d={ringSegment(c, c, r, i)} className={cn("tethr-galaxy-seg", u.earned && "is-on")} style={{ strokeWidth: u.earned ? 2.6 : 1.6 }} />
      ))}
      {area.level ? (
        <circle cx={c} cy={c} r={2 + area.level * 0.55} className="tethr-galaxy-core" />
      ) : (
        <circle cx={c} cy={c} r={3} className="tethr-galaxy-core tethr-galaxy-core-empty" />
      )}
    </svg>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t tethr-rule pt-4">
      <MonoTag>{title}</MonoTag>
      {children}
    </section>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function AreaPanel({
  area,
  companyId,
  fresh,
  onClose,
  onOpenFile,
}: {
  area: TethrGrowthArea;
  companyId: string;
  fresh: string[];
  onClose: () => void;
  onOpenFile: (panelPath: string) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const explore = useMutation({
    mutationFn: () => tethrApi.exploreArea(companyId, area.id),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, res.threadId) });
      navigate("/chat");
    },
  });
  const hide = useMutation({
    mutationFn: (hidden: boolean) => tethrApi.setAreaHidden(companyId, area.id, hidden),
    onSuccess: (map) => queryClient.setQueryData(tethrKeys.growthMap(companyId), map),
  });
  const audit = area.lastAudit;
  const knows = area.knowledge.notes.length + area.knowledge.skills.length;

  return (
    <div className="flex flex-col gap-4" aria-label={`${area.name} on the growth map`}>
      <header className="flex items-start gap-3">
        <UnlockRing area={area} size={44} />
        <div className="min-w-0 flex-1">
          <MonoTag>
            level {area.level} · {area.levelName}
            {area.focus ? " · focus this week" : ""}
          </MonoTag>
          <h2 className="mt-1 text-[20px] font-light leading-tight tracking-[-0.02em]">{area.name}</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{area.blurb}</p>
          {area.active ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px]">
              <StatusDot tone="live" /> An agent is working here now.
            </p>
          ) : null}
        </div>
        <button type="button" onClick={onClose} className="tethr-btn tethr-btn-ghost tethr-touch-sized h-8 w-8 shrink-0 p-0" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </header>

      <ol className="space-y-2.5" aria-label="Unlocks">
        {area.unlocks.map((u) => {
          const isNext = area.next?.key === u.key;
          return (
            <li key={u.key} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5">
              <span
                className={cn("mt-[5px] h-2.5 w-2.5 rounded-full", u.earned ? "bg-foreground" : "shadow-[inset_0_0_0_1.5px_var(--tethr-rim-strong)]")}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                  <span className={u.earned ? "" : "text-muted-foreground"}>{u.label}</span>
                  <span className="sr-only">{u.earned ? "unlocked" : "not yet"}</span>
                  {fresh.includes(u.key) ? <span className="tethr-galaxy-new">new</span> : null}
                  {isNext ? <span className="tethr-eyebrow">next</span> : null}
                </p>
                <p className="text-[12.5px] leading-snug text-muted-foreground">{u.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="space-y-2">
        <button type="button" className="tethr-btn tethr-btn-primary h-9 w-full px-4 text-sm" disabled={explore.isPending} onClick={() => explore.mutate()}>
          {explore.isPending ? "Starting…" : audit ? "Explore again with tethr" : "Explore with tethr"}
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <p className="text-[12px] leading-snug text-muted-foreground">
          tethr audits {area.name} in the main chat, using its playbooks, and records a score here. It changes nothing outside tethr.
        </p>
        {explore.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">Couldn't start it: {(explore.error as Error).message}</p> : null}
      </div>

      {audit ? (
        <Section title="last audit">
          <div className="flex items-baseline gap-2">
            <span className="tethr-figure text-[34px] leading-none">{audit.score}</span>
            <span className="text-[12px] text-muted-foreground">/ 100</span>
            {area.scoreChange !== null ? (
              <span className="font-mono text-[11px] tethr-text-3">
                {area.scoreChange >= 0 ? "+" : ""}
                {area.scoreChange} since the first
              </span>
            ) : null}
            <span className="ml-auto font-mono text-[11px] tethr-text-3">
              {shortDate(audit.at)} · {audit.by}
            </span>
          </div>
          <p className="text-[13px] leading-relaxed">{audit.summary}</p>
          {audit.nextSteps.length ? (
            <ol className="list-decimal space-y-1 pl-5 text-[13px] leading-snug">
              {audit.nextSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : null}
          {audit.file ? (
            audit.panelPath ? (
              <button type="button" onClick={() => onOpenFile(audit.panelPath!)} className="tethr-btn tethr-btn-glass h-8 max-w-full px-3 text-[12.5px]">
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{audit.file.split("/").pop()}</span>
              </button>
            ) : (
              <p className="truncate font-mono text-[11.5px] tethr-text-3">{audit.file}</p>
            )
          ) : null}
        </Section>
      ) : null}

      <Section title={`what tethr knows here · ${knows}`}>
        {knows ? (
          <ul className="space-y-2">
            {area.knowledge.notes.map((n, i) => (
              <li key={`n${i}`} className="text-[13px] leading-snug">
                {n.text}
                <span className="mt-0.5 block font-mono text-[10.5px] tethr-text-3">
                  {n.savedBy ? `${n.savedBy} · ` : ""}
                  {n.savedAt ? `${formatRelative(n.savedAt)} · ` : ""}
                  {n.placedBy === "tethr" ? "filed here by tethr" : "placed by its words"}
                </span>
              </li>
            ))}
            {area.knowledge.skills.map((s) => (
              <li key={`s${s.name}`} className="text-[13px] leading-snug">
                <span className="font-mono text-[12px]">{s.name}</span> <span className="text-muted-foreground">skill · {s.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Nothing yet. Notes and skills tethr saves about {area.name.toLowerCase()} show up here.</p>
        )}
      </Section>

      <Section title="numbers">
        {area.metrics.length ? (
          <ul className="space-y-1.5">
            {area.metrics.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 text-[13px]">
                <StatusDot tone={METRIC_TONE[m.state]} className="translate-y-[-1px]" />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                <span className="shrink-0 font-mono text-[11.5px] tethr-text-3">
                  {formatMetric(m.current, m.unit as TethrMetric["unit"])} / {formatMetric(m.target, m.unit as TethrMetric["unit"])} · {METRIC_LABEL[m.state]}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">No goal number measures it yet.</p>
        )}
      </Section>

      <Section title="who's on it">
        {area.agents.length || area.schedules.length ? (
          <ul className="space-y-1 text-[13px]">
            {area.agents.map((a) => (
              <li key={a.tag} className="flex items-center gap-2">
                <StatusDot tone={a.paused ? "paused" : a.running ? "live" : "idle"} />
                <span className="font-mono text-[12px]">{a.tag}</span>
                <span className="text-muted-foreground">{a.paused ? "paused" : a.running ? "working now" : a.name}</span>
              </li>
            ))}
            {area.schedules.map((s) => (
              <li key={s} className="text-muted-foreground">
                {s[0].toUpperCase() + s.slice(1)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Nobody owns it yet.</p>
        )}
      </Section>

      <Section title="playbooks">
        {area.playbooks.length ? (
          <div className="flex flex-wrap gap-1.5">
            {area.playbooks.map((p) => (
              <span key={p} className="tethr-inset rounded-full px-2.5 py-1 font-mono text-[11.5px]">
                {p}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">None of its playbooks are installed on this computer.</p>
        )}
      </Section>

      <Section title="data">
        <p className="text-[12.5px] text-muted-foreground">{area.dataNote}</p>
        <ul className="space-y-1">
          {area.data.map((d) => (
            <li key={d.source} className="flex items-baseline gap-2 text-[13px]">
              <StatusDot tone={d.connected ? "ok" : "idle"} className="translate-y-[-1px]" />
              <span>{d.detail}</span>
            </li>
          ))}
        </ul>
      </Section>

      {area.blindSpots.length ? (
        <Section title="tethr can't see yet">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
            {area.blindSpots.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="border-t tethr-rule pt-3">
        <button
          type="button"
          className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px]"
          disabled={hide.isPending}
          onClick={() => hide.mutate(!area.hidden)}
        >
          {area.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {area.hidden ? "Show this area again" : "Hide this area (it doesn't apply)"}
        </button>
      </div>
    </div>
  );
}
