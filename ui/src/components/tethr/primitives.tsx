import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Brain,
  Calculator,
  Cog,
  Cpu,
  Database,
  Eye,
  FileCode,
  Flame,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Lightbulb,
  Lock,
  Mail,
  MessageCircle,
  MessageSquare,
  Package,
  Puzzle,
  Rocket,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Target,
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

/** Mono uppercase eyebrow tag — the brand's TIER · 01 voice. */
export function MonoTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const SENSITIVITY_LABEL: Record<string, string> = {
  medical: "medical",
  public: "public",
  spend: "spend",
  pr: "pr",
  internal: "internal",
  safe: "safe",
};

const SENSITIVITY_GATED = new Set(["medical", "public", "spend", "pr"]);

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
        "inline-flex items-center gap-1 border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]",
        gated
          ? "border-foreground bg-foreground text-background"
          : "border-border text-muted-foreground",
        className,
      )}
    >
      {gated ? <Lock className="h-2.5 w-2.5" /> : null}
      {SENSITIVITY_LABEL[sensitivity] ?? sensitivity}
    </span>
  );
}

const OUTPUT_STATUS_STYLES: Record<string, string> = {
  gated: "border-amber-600 text-amber-700 dark:border-amber-400 dark:text-amber-300",
  changes_requested:
    "border-amber-600 text-amber-700 dark:border-amber-400 dark:text-amber-300",
  published:
    "border-emerald-700 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300",
  approved:
    "border-emerald-700 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300",
  rejected: "border-destructive text-destructive",
  draft: "border-border text-muted-foreground",
};

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
    <span
      className={cn(
        "inline-flex items-center border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em]",
        OUTPUT_STATUS_STYLES[status] ?? "border-border text-muted-foreground",
        className,
      )}
    >
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
  const tone =
    status === "running"
      ? "bg-cyan-500"
      : status === "error"
        ? "bg-destructive"
        : status === "paused"
          ? "bg-amber-500"
          : "bg-emerald-500";
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)}>
      {status === "running" ? (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" />
      ) : null}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", tone)} />
    </span>
  );
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

/** Budget usage bar with warn threshold marker. */
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
  const pct = capCents > 0 ? Math.min(100, (spentCents / capCents) * 100) : 0;
  const hot = pct >= warnPercent;
  return (
    <div className={cn("relative h-1.5 w-full overflow-hidden bg-muted", className)}>
      <div
        className={cn(
          "h-full transition-[width] duration-700 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)]",
          hot ? "bg-amber-500" : "bg-foreground",
        )}
        style={{ width: `${pct}%` }}
      />
      {capCents > 0 ? (
        <div
          className="absolute top-0 h-full w-px bg-muted-foreground/50"
          style={{ left: `${warnPercent}%` }}
        />
      ) : null}
    </div>
  );
}
