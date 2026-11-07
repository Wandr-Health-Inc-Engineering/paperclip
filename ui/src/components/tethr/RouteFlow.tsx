import { ArrowDown, CircleUser, Radio, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TethrRouteHop } from "@/api/tethr";
import { CogDuo, MonoTag } from "./primitives";

// The hero visualization: a request travelling down the chain.
//   you → @helm (classify) → @agent (route) → @agent.subagent (do).
// Hops reveal sequentially with the brand's expo-out curve; connector lines
// draw in between nodes. Replays deterministically from recorded hops, so
// history renders with the same choreography as a live run.

const LAYER_LABEL: Record<TethrRouteHop["layer"], string> = {
  helm: "TIER · 01 — CLASSIFY",
  agent: "TIER · 02 — ROUTE",
  subagent: "TIER · 03 — DO",
  tool: "TOOL",
};

function hopKey(hop: TethrRouteHop, index: number): string {
  return `${index}-${hop.actorTag}-${hop.decision}`;
}

export function RouteFlow({
  request,
  hops,
  pending,
  animate = true,
  live = false,
  className,
}: {
  request: string;
  hops: TethrRouteHop[];
  pending?: boolean;
  animate?: boolean;
  /** Live mode: hops arrive on their own schedule, so no stagger delays. */
  live?: boolean;
  className?: string;
}) {
  const baseDelay = live ? 0 : 120;
  const step = live ? 0 : 240;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* The request node */}
      <div
        className={cn("tethr-hop flex items-start gap-3", animate && "tethr-hop-animate")}
        style={animate ? { animationDelay: "0ms" } : undefined}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CircleUser className="h-4 w-4" />
        </div>
        <div className="min-w-0 pt-0.5">
          <MonoTag>request</MonoTag>
          <p className="mt-1 text-sm font-medium leading-snug [overflow-wrap:anywhere]">{request}</p>
        </div>
      </div>

      {hops.map((hop, index) => (
        <div key={hopKey(hop, index)}>
          <Connector
            animate={animate}
            delay={baseDelay + index * step}
          />
          <div
            className={cn(
              "tethr-hop flex items-start gap-3",
              animate && "tethr-hop-animate",
            )}
            style={
              animate
                ? { animationDelay: `${baseDelay + index * step + 80}ms` }
                : undefined
            }
          >
            <div
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full",
                hop.layer === "tool"
                  ? "ml-1 h-7 w-7 border border-dashed border-[var(--tethr-rim-strong)] text-muted-foreground"
                  : "h-9 w-9",
                hop.layer === "subagent"
                  ? "bg-primary text-primary-foreground"
                  : hop.layer === "tool"
                    ? "bg-transparent"
                    : "bg-[var(--tethr-frost-strong)] text-foreground shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
              )}
            >
              {hop.layer === "tool" ? (
                <Wrench className="h-3.5 w-3.5" />
              ) : (
                <Radio className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 pt-0.5">
              <MonoTag>{LAYER_LABEL[hop.layer]}</MonoTag>
              <p className="mt-1 text-sm font-medium [overflow-wrap:anywhere]">
                <span className="font-mono text-[12.5px]">{hop.actorTag}</span>
                <span className="text-[var(--tethr-text-3)]"> · </span>
                {hop.layer === "tool" ? (
                  <span className="font-mono text-[12.5px]">{hop.decision}</span>
                ) : (
                  hop.decision
                )}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {hop.reason}
              </p>
            </div>
          </div>
        </div>
      ))}

      {pending ? (
        <>
          <Connector animate={animate} delay={baseDelay + hops.length * step} />
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--tethr-rim-strong)]">
              <CogDuo className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="pt-1.5">
              <span className="shimmer-text text-sm font-medium">
                classifying…
              </span>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Connector({ animate, delay }: { animate: boolean; delay: number }) {
  return (
    <div className="ml-[17px] flex h-7 items-center">
      <div
        className={cn("tethr-connector h-full w-px bg-[var(--tethr-rim-strong)]", animate && "tethr-connector-animate")}
        style={animate ? { animationDelay: `${delay}ms` } : undefined}
      />
      <ArrowDown
        className={cn(
          "-ml-[6.5px] mt-auto h-3 w-3 text-[var(--tethr-text-3)]",
          animate && "tethr-hop tethr-hop-animate",
        )}
        style={animate ? { animationDelay: `${delay + 60}ms` } : undefined}
      />
    </div>
  );
}
