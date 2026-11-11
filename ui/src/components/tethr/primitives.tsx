import type { LucideIcon } from "lucide-react";
import {
  Atom,
  Bot,
  Brain,
  Bug,
  Calculator,
  CircuitBoard,
  Code,
  Cog,
  Cpu,
  Crown,
  Database,
  Eye,
  FileCode,
  Fingerprint,
  Flame,
  Gem,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Hexagon,
  Lightbulb,
  Lock,
  Mail,
  MessageCircle,
  MessageSquare,
  Microscope,
  Package,
  Pentagon,
  Puzzle,
  Radar,
  Rocket,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Swords,
  Target,
  Telescope,
  Terminal,
  TrendingUp,
  Wand,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Shared Tethr UI vocabulary: sensitivity + status badges, mono eyebrows,
// agent glyphs, money formatting. Everything composes the existing token set.

const ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  cpu: Cpu,
  brain: Brain,
  zap: Zap,
  rocket: Rocket,
  terminal: Terminal,
  shield: Shield,
  "shield-check": ShieldCheck,
  eye: Eye,
  search: Search,
  wrench: Wrench,
  hammer: Hammer,
  lightbulb: Lightbulb,
  sparkles: Sparkles,
  star: Star,
  heart: Heart,
  flame: Flame,
  cog: Cog,
  database: Database,
  globe: Globe,
  lock: Lock,
  mail: Mail,
  "message-square": MessageSquare,
  "message-circle": MessageCircle,
  "file-code": FileCode,
  "git-branch": GitBranch,
  package: Package,
  puzzle: Puzzle,
  target: Target,
  wand: Wand,
  calculator: Calculator,
  "trending-up": TrendingUp,
  // The rest of core's agent icons (AGENT_ICON_NAMES), so an agent looks the same here as in the sidebar.
  code: Code,
  bug: Bug,
  atom: Atom,
  "circuit-board": CircuitBoard,
  radar: Radar,
  swords: Swords,
  telescope: Telescope,
  microscope: Microscope,
  crown: Crown,
  gem: Gem,
  hexagon: Hexagon,
  pentagon: Pentagon,
  fingerprint: Fingerprint,
};

export function tethrIcon(name: string | null | undefined): LucideIcon {
  return (name && ICONS[name]) || Bot;
}

export function AgentGlyph({
  icon,
  className,
}: {
  icon: string | null | undefined;
  className?: string;
}) {
  const Icon = tethrIcon(icon);
  return <Icon className={cn("h-4 w-4", className)} />;
}

/**
 * The machinery-at-work indicator: two meshed line-art cogs counter-rotating
 * (phase 15). Monochrome via currentColor; spin lives in the theme
 * (.tethr-cog-spin, reduced-motion-guarded). Size via h/w classes on className.
 */
export function CogDuo({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-block h-5 w-5 shrink-0", className)} aria-hidden="true">
      <Cog className="tethr-cog-spin absolute left-0 top-0 h-[68%] w-[68%]" />
      <Cog className="tethr-cog-spin-reverse absolute bottom-0 right-0 h-[52%] w-[52%]" />
    </span>
  );
}

/** Mono uppercase eyebrow label — the "AWAITING REVIEW · SPEND" voice. */
export function MonoTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("tethr-eyebrow", className)}>{children}</span>;
}

export const SENSITIVITY_LABEL: Record<string, string> = {
  medical: "medical",
  public: "public",
  spend: "spend",
  pr: "pr",
  org: "org",
  destructive: "destructive",
  external: "outward",
  internal: "internal",
  safe: "safe",
};

const SENSITIVITY_GATED = new Set(["medical", "public", "spend", "pr", "org", "destructive", "external"]);

export function isGated(sensitivity: string): boolean {
  return SENSITIVITY_GATED.has(sensitivity);
}

export function SensitivityBadge({
  sensitivity,
  className,
}: {
  sensitivity: string;
  className?: string;
}) {
  const gated = isGated(sensitivity);
  return (
    <span
      className={cn(
        "tethr-pill px-2 py-0.5 text-[10px] leading-4",
        gated && "tethr-pill-solid",
        className,
      )}
    >
      {gated ? <Lock className="h-2.5 w-2.5" /> : null}
      {SENSITIVITY_LABEL[sensitivity] ?? sensitivity}
    </span>
  );
}

/**
 * Status tones — one meaning each (Smoked Glass "different dots for different
 * situations"):
 *   ok       published · approved · done · succeeded · active
 *   warn     awaiting review · pending approval · near a cap
 *   changes  changes requested (amber ring)
 *   bad      rejected · failed · error
 *   live     running now (pulses)
 *   idle     queued · draft · on request
 *   paused   paused · disabled · archived (hollow ring)
 */
export type StatusTone = "ok" | "warn" | "changes" | "bad" | "live" | "idle" | "paused";

const TONE_BY_STATUS: Record<string, StatusTone> = {
  published: "ok",
  approved: "ok",
  applied: "ok",
  done: "ok",
  completed: "ok",
  complete: "ok",
  succeeded: "ok",
  success: "ok",
  ok: "ok",
  active: "ok",
  answered: "ok",
  gated: "warn",
  awaiting_review: "warn",
  pending_approval: "warn",
  needs_approval: "warn",
  warning: "warn",
  changes_requested: "changes",
  revising: "changes",
  rejected: "bad",
  failed: "bad",
  error: "bad",
  errored: "bad",
  blocked: "bad",
  timed_out: "bad",
  running: "live",
  in_progress: "live",
  processing: "live",
  routing: "live",
  started: "live",
  live: "live",
  queued: "idle",
  pending: "idle",
  draft: "idle",
  idle: "idle",
  scheduled: "idle",
  waiting: "idle",
  paused: "paused",
  disabled: "paused",
  archived: "paused",
  terminated: "paused",
  cancelled: "paused",
  canceled: "paused",
  skipped: "paused",
};

export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return "idle";
  return TONE_BY_STATUS[status.toLowerCase()] ?? "idle";
}

/** A 6px status dot. Pass a tone, or a raw status string to map. */
export function StatusDot({
  tone,
  status,
  className,
  title,
}: {
  tone?: StatusTone;
  status?: string | null;
  className?: string;
  title?: string;
}) {
  const t = tone ?? statusTone(status);
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={cn("tethr-dot", `tethr-dot-${t}`, className)}
    />
  );
}

export const OUTPUT_STATUS_LABEL: Record<string, string> = {
  gated: "awaiting review",
  changes_requested: "changes requested",
  published: "published",
  approved: "approved",
  rejected: "rejected",
  draft: "draft",
};

export function OutputStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span className={cn("tethr-pill px-2 py-0.5 text-[10px] leading-4", className)}>
      <StatusDot status={status} />
      {OUTPUT_STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function AgentStatusDot({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return <StatusDot status={status} className={className} title={status.replace(/_/g, " ")} />;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function describeCron(cron: string | null): string {
  if (!cron) return "on request";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;
  const time = (h: string, m: string) => {
    const hr = Number(h);
    const mn = Number(m);
    if (Number.isNaN(hr) || Number.isNaN(mn)) return null;
    const period = hr >= 12 ? "PM" : "AM";
    const h12 = hr % 12 === 0 ? 12 : hr % 12;
    return `${h12}:${String(mn).padStart(2, "0")} ${period}`;
  };
  const t = time(hour, min);
  if (!t) return cron;
  if (dow !== "*") {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const day = dayNames[Number(dow)] ?? dow;
    return `${day}s at ${t}`;
  }
  return `daily at ${t}`;
}

function budgetPercent(spentCents: number, capCents: number): number {
  return capCents > 0 ? Math.min(100, (spentCents / capCents) * 100) : 0;
}

/** Thin budget meter with a warn-threshold tick. Amber at/over the threshold. */
export function BudgetBar({
  spentCents,
  capCents,
  warnPercent = 80,
  className,
}: {
  spentCents: number;
  capCents: number;
  warnPercent?: number;
  className?: string;
}) {
  const pct = budgetPercent(spentCents, capCents);
  const hot = pct >= warnPercent;
  const over = capCents > 0 && spentCents >= capCents;
  return (
    <div className={cn("tethr-meter relative w-full", className)}>
      <span
        className={cn(over ? "tethr-ring-bad" : hot ? "tethr-ring-warn" : undefined)}
        style={{ width: `${pct}%` }}
      />
      {capCents > 0 ? (
        <div
          className="absolute top-0 h-full w-px bg-[var(--tethr-text-3)] opacity-60"
          style={{ left: `${warnPercent}%` }}
        />
      ) : null}
    </div>
  );
}

/**
 * Oura-style progress ring for spend against a cap. Children render in the
 * centre (typically the big light figure). Amber at the warn threshold, clay
 * at/over the cap.
 */
export function BudgetRing({
  spentCents,
  capCents,
  warnPercent = 80,
  size = 132,
  stroke = 4,
  label,
  children,
  className,
}: {
  spentCents: number;
  capCents: number;
  warnPercent?: number;
  size?: number;
  stroke?: number;
  label?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const pct = budgetPercent(spentCents, capCents);
  const hot = pct >= warnPercent;
  const over = capCents > 0 && spentCents >= capCents;
  const r = 50 - stroke;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 100 100"
        className="tethr-ring h-full w-full"
        role="img"
        aria-label={label ?? `${Math.round(pct)}% of cap used`}
      >
        <circle className="tethr-ring-track" cx="50" cy="50" r={r} strokeWidth={stroke * 0.75} />
        {pct > 0 ? (
          <circle
            className={cn("tethr-ring-value", over ? "tethr-ring-bad" : hot ? "tethr-ring-warn" : undefined)}
            cx="50"
            cy="50"
            r={r}
            strokeWidth={stroke}
            pathLength={100}
            strokeDasharray={`${Math.max(pct, 0.5)} 100`}
          />
        ) : null}
      </svg>
      {children ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
          {children}
        </div>
      ) : null}
    </div>
  );
}
