import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Link } from "../../lib/router";
import { cn } from "@/lib/utils";
import { MonoTag, StatusDot, formatRelative, type StatusTone } from "./primitives";
import { tethrApi, tethrKeys, type TethrMetric } from "@/api/tethr";

// The goals scorecard (phase 20): one stat tile per metric — the current value,
// change since the baseline, a meter from baseline to target with a tick where
// it should be by now, an on-track/behind label (a status dot AND words, never
// color alone), and a hoverable trend line with a history table behind it.
// Monochrome by the brand: ink for data, color only in the 6px status dots.

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function formatMetric(value: number | null | undefined, unit: TethrMetric["unit"]): string {
  if (value === null || value === undefined) return "—";
  const n = Math.abs(value) >= 10_000 ? compact.format(value) : plain.format(value);
  if (unit === "usd") return `$${n}`;
  if (unit === "percent") return `${n}%`;
  return n;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

/** How far from baseline to target the metric has moved (0..1), or null. */
export function progressOf(m: Pick<TethrMetric, "baseline" | "current" | "target">): number | null {
  if (m.target === null) return null;
  const cur = m.current ?? m.baseline;
  if (cur === null) return null;
  const base = m.baseline ?? 0;
  const span = m.target - base;
  if (span === 0) return cur === m.target ? 1 : 0;
  return clamp01((cur - base) / span);
}

/** Where it should be by now on a straight line from baseline date to target date. */
export function expectedOf(m: Pick<TethrMetric, "baselineAt" | "targetDate">, now = Date.now()): number | null {
  if (!m.baselineAt || !m.targetDate) return null;
  const start = new Date(m.baselineAt).getTime();
  const end = new Date(m.targetDate).getTime();
  if (!(end > start)) return null;
  return clamp01((now - start) / (end - start));
}

export function metricState(m: TethrMetric, now = Date.now()): { tone: StatusTone; label: string } {
  if (m.target === null) return { tone: "idle", label: "no target yet" };
  if (m.current === null) return { tone: "idle", label: "not measured yet" };
  const p = progressOf(m) ?? 0;
  if (p >= 1) return { tone: "ok", label: "target hit" };
  const e = expectedOf(m, now);
  if (e === null) return { tone: "idle", label: "in progress" };
  return p >= e - 0.1 ? { tone: "ok", label: "on track" } : { tone: "warn", label: "behind" };
}

export function Scorecard({ companyId }: { companyId: string }) {
  const { data } = useQuery({
    queryKey: tethrKeys.goals(companyId),
    queryFn: () => tethrApi.goals(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });
  const measure = useMutation({ mutationFn: () => tethrApi.runRhythm(companyId, "scorecard") });

  if (!data) return null;
  const goals = data.goals.filter((g) => g.status !== "cancelled");
  if (!data.company && !goals.length) {
    return (
      <section className="tethr-panel flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center">
        <Gauge className="h-5 w-5 shrink-0 text-muted-foreground" />
        <p className="flex-1 text-[13.5px] text-muted-foreground">tethr has no goals yet. Set it up to give it goals with real numbers to work toward.</p>
        <Link to="/setup" className="tethr-btn tethr-btn-primary h-8 px-4 text-[12.5px]">
          Set up tethr
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <MonoTag>goals</MonoTag>
          {data.company ? <p className="text-[14px] leading-snug">{data.company.title}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          {measure.isSuccess ? (
            <Link to={`/chat?chat=${measure.data.threadId}`} className="text-[12px] tethr-text-3 hover:text-foreground">
              Measuring in the Operations chat →
            </Link>
          ) : measure.isError ? (
            <span className="text-[12px] text-[var(--tethr-bad)]">{measure.error instanceof Error ? measure.error.message : "Couldn't start it."}</span>
          ) : null}
          <button
            type="button"
            onClick={() => measure.mutate()}
            disabled={measure.isPending || measure.isSuccess}
            className="tethr-btn tethr-btn-glass h-8 px-3.5 text-[12.5px]"
          >
            Measure now
          </button>
          <Link to="/setup" className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px]">
            Edit goals
          </Link>
        </div>
      </div>
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {goals.map((g) => (
          <div key={g.id} className="tethr-panel flex flex-col gap-3 p-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[14px] font-medium">{g.title}</p>
              {g.status !== "active" ? <MonoTag>{g.status}</MonoTag> : null}
            </div>
            {g.metrics.length ? (
              g.metrics.map((m) => <MetricTile key={m.id} metric={m} />)
            ) : (
              <p className="text-[12.5px] tethr-text-3">No metric yet. The goals interview in setup adds one.</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function MetricTile({ metric: m }: { metric: TethrMetric }) {
  const [showHistory, setShowHistory] = useState(false);
  const p = progressOf(m);
  const e = expectedOf(m);
  const state = metricState(m);
  const delta = m.current !== null && m.baseline !== null ? m.current - m.baseline : null;
  const good = delta === null || delta === 0 ? null : (delta > 0) === (m.direction === "up");
  const lastAdjustment = m.adjustments?.length ? m.adjustments[m.adjustments.length - 1] : null;
  return (
    <div className="tethr-inset flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12.5px] text-muted-foreground">{m.name}</p>
          <p className="tethr-figure text-[28px] leading-tight">{formatMetric(m.current ?? m.baseline, m.unit)}</p>
          {delta !== null && delta !== 0 ? (
            <p className="text-[11.5px] tethr-text-3">
              {delta > 0 ? "+" : "−"}
              {formatMetric(Math.abs(delta), m.unit)} since the baseline{m.baselineAt ? ` (${shortDate(m.baselineAt)})` : ""}
              {good === false ? ", the wrong way" : ""}
            </p>
          ) : m.current === null && m.baseline !== null ? (
            <p className="text-[11.5px] tethr-text-3">baseline, not measured since</p>
          ) : null}
        </div>
        {m.history.length >= 2 ? <Sparkline points={m.history} unit={m.unit} /> : null}
      </div>

      {p !== null ? (
        <div className="space-y-1.5">
          <div
            className="relative h-1.5 rounded-full bg-[var(--tethr-frost-strong)]"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p * 100)}
            aria-label={`${m.name}: ${Math.round(p * 100)}% of the way to the target`}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-foreground" style={{ width: `${Math.max(p * 100, p > 0 ? 2 : 0)}%` }} />
            {e !== null && e > 0 && e < 1 ? (
              <span
                className="absolute -top-1 h-3.5 w-px bg-muted-foreground"
                style={{ left: `${e * 100}%` }}
                title={`Where it should be by now: ${Math.round(e * 100)}%`}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11.5px]">
            <span className="flex items-center gap-1.5">
              <StatusDot tone={state.tone} />
              <span>{state.label}</span>
            </span>
            <span className="tethr-text-3">
              target {formatMetric(m.target, m.unit)}
              {m.targetDate ? ` by ${shortDate(m.targetDate)}` : ""}
              {m.direction === "down" ? " (lower is better)" : ""}
            </span>
          </div>
          {lastAdjustment ? (
            <p className="text-[11px] leading-snug tethr-text-3" title={`Because ${lastAdjustment.why}.`}>
              tethr {lastAdjustment.to > lastAdjustment.from === (m.direction !== "down") ? "raised" : "eased"} it from{" "}
              {formatMetric(lastAdjustment.from, m.unit)} on {shortDate(lastAdjustment.at)}, to stay realistic.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[11.5px]">
          <StatusDot tone={state.tone} />
          {state.label}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] tethr-text-3">
        <span title={m.method || undefined}>
          {m.currentAt ? `measured ${formatRelative(m.currentAt)}` : "not measured yet"} · {SOURCE_LABEL[m.source] ?? m.source}
        </span>
        {m.history.length ? (
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="hover:text-foreground">
            {showHistory ? "Hide history" : "History"}
          </button>
        ) : null}
      </div>
      {m.method ? <p className="text-[11px] leading-snug tethr-text-3">How it's measured: {m.method}</p> : null}
      {showHistory ? (
        <table className="w-full text-[11.5px]">
          <thead>
            <tr className="tethr-text-3">
              <th className="py-1 text-left font-normal">Date</th>
              <th className="py-1 text-right font-normal">Value</th>
              <th className="py-1 pl-3 text-left font-normal">Note</th>
            </tr>
          </thead>
          <tbody>
            {[...m.history].reverse().map((pt) => (
              <tr key={pt.at} className="border-t border-[var(--tethr-rim)]">
                <td className="py-1">{shortDate(pt.at)}</td>
                <td className="py-1 text-right tabular-nums">{formatMetric(pt.value, m.unit)}</td>
                <td className="py-1 pl-3 tethr-text-3">{pt.note ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  stripe: "Stripe",
  posthog: "PostHog",
  google_ads: "Google Ads",
  manual: "counted by hand",
  other: "other source",
};

/** A small trend line: history in a quiet ink, the latest point solid; a
 * crosshair + readout follow the pointer (the history table has every value). */
function Sparkline({ points, unit }: { points: TethrMetric["history"]; unit: TethrMetric["unit"] }) {
  const W = 132;
  const H = 40;
  const PAD = 5;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => points.slice(-12), [points]);
  const xs = pts.map((_, i) => PAD + (pts.length === 1 ? 0 : (i * (W - 2 * PAD)) / (pts.length - 1)));
  const min = Math.min(...pts.map((p) => p.value));
  const max = Math.max(...pts.map((p) => p.value));
  const y = (v: number) => (max === min ? H / 2 : PAD + (1 - (v - min) / (max - min)) * (H - 2 * PAD));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = pts.length - 1;
  const at = hover ?? last;

  return (
    <div className="relative shrink-0">
      <svg
        ref={ref}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        className="block overflow-visible"
        role="img"
        aria-label={`Trend: ${pts.map((p) => formatMetric(p.value, unit)).join(", ")}`}
        onPointerMove={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (!box) return;
          const x = ((e.clientX - box.left) / box.width) * W;
          let best = 0;
          xs.forEach((xi, i) => {
            if (Math.abs(xi - x) < Math.abs(xs[best] - x)) best = i;
          });
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <path d={path} fill="none" stroke="currentColor" strokeOpacity={0.4} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null ? <line x1={xs[hover]} x2={xs[hover]} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1} /> : null}
        <circle cx={xs[at]} cy={y(pts[at].value)} r={4} fill="currentColor" stroke="var(--background)" strokeWidth={2} />
      </svg>
      {hover !== null ? (
        <div className={cn("tethr-glass pointer-events-none absolute -top-9 z-10 whitespace-nowrap rounded-md px-2 py-1 text-[11px]", hover > last / 2 ? "right-0" : "left-0")}>
          <span className="font-medium">{formatMetric(pts[hover].value, unit)}</span>
          <span className="tethr-text-3"> · {shortDate(pts[hover].at)}</span>
        </div>
      ) : null}
    </div>
  );
}
