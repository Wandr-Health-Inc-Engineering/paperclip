import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, OctagonAlert } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  BudgetBar,
  BudgetRing,
  MonoTag,
  StatusDot,
  formatCents,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { tethrApi, tethrKeys } from "@/api/tethr";

// Budgets: per-agent monthly caps, the combined growth line Helm holds, and
// spend over the last 30 days. Tailwind (real money) hard-stops at cap.

export function TethrBudgets() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Budgets" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.budgets(selectedCompanyId!),
    queryFn: () => tethrApi.budgets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, []);

  const daily = useMemo(() => {
    const map = new Map<string, number>();
    for (const point of data?.series ?? []) {
      map.set(point.day, (map.get(point.day) ?? 0) + point.costCents);
    }
    return days.map((day) => ({ day, costCents: map.get(day) ?? 0 }));
  }, [data?.series, days]);

  if (!selectedCompanyId) {
    return <EmptyState icon={DollarSign} message="Select a company to view budgets." />;
  }
  if (isLoading) return <PageSkeleton variant="costs" />;
  if (!data) return null;

  const operatingAgents = data.agents.filter((a) => a.tag !== "@ceo");
  const helm = operatingAgents.find((a) => a.tag === "@helm");
  const crew = operatingAgents.filter((a) => a.tag !== "@helm");
  const totalSpent = crew.reduce((sum, a) => sum + a.spentMonthlyCents, 0);
  const totalCap = helm?.budgetMonthlyCents ?? data.companyPolicy?.amount ?? 0;
  const maxDay = Math.max(...daily.map((d) => d.costCents), 1);

  return (
    <div className="space-y-8">
      <div>
        <MonoTag>tethr · budgets</MonoTag>
        <h1 className="tethr-display mt-2 text-[34px] md:text-[40px]">the growth line</h1>
        <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">
          One combined monthly line for the company. Each agent has its own cap,
          enforced as a hard stop.
        </p>
      </div>

      {/* Combined line */}
      <div className="tethr-panel p-5 md:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <MonoTag>combined growth line · this month</MonoTag>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
              <span className="tethr-figure text-[44px] md:text-[56px]">{formatCents(totalSpent)}</span>
              <span className="text-sm text-muted-foreground">of {formatCents(totalCap)}</span>
            </p>
          </div>
          <p className="tethr-eyebrow">
            held by {helm ? "@helm" : "the company line"} · warn at {data.companyPolicy?.warnPercent ?? 80}%
          </p>
        </div>
        <BudgetBar
          spentCents={totalSpent}
          capCents={totalCap}
          warnPercent={data.companyPolicy?.warnPercent ?? 80}
          className="mt-5"
        />

        {/* 30-day spend chart */}
        <div className="mt-7">
          <MonoTag>spend · last 30 days</MonoTag>
          <div className="mt-3 flex h-24 items-end gap-[3px]">
            {daily.map((point) => (
              <div
                key={point.day}
                className="group relative flex h-full flex-1 flex-col justify-end"
                title={`${point.day}: ${formatCents(point.costCents)}`}
              >
                {point.costCents > 0 ? (
                  <div
                    data-tethr-chart-bar
                    className="w-full bg-[var(--tethr-text-3)] transition-colors group-hover:bg-foreground"
                    style={{
                      height: `${Math.max(4, (point.costCents / maxDay) * 100)}%`,
                    }}
                  />
                ) : (
                  <div className="h-px w-full bg-[var(--tethr-rim-strong)]" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between tethr-eyebrow text-[9.5px]">
            <span>30 days ago</span>
            <span>today</span>
          </div>
        </div>
      </div>

      {/* Per-agent caps — Oura-style rings */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-tethr-stagger>
        {crew.map((agent) => {
          const warnPercent = agent.policy?.warnPercent ?? 80;
          const pct =
            agent.budgetMonthlyCents > 0
              ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
              : 0;
          const over =
            agent.budgetMonthlyCents > 0 && agent.spentMonthlyCents >= agent.budgetMonthlyCents;
          const hot = pct >= warnPercent;
          return (
            <Link
              key={agent.agentId}
              to={`/crew/${agent.agentId}`}
              className="tethr-panel tethr-panel-hover flex flex-col gap-5 p-5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
                    <AgentGlyph icon={agent.icon} className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-medium leading-tight tracking-[-0.01em]">
                      {agent.name}
                    </p>
                    <p className="tethr-eyebrow mt-0.5 text-[9.5px]">{agent.tag}</p>
                  </div>
                </div>
                {agent.policy?.hardStopEnabled ? (
                  <span className="tethr-pill shrink-0 px-2 py-0.5 text-[9.5px] leading-4">
                    <OctagonAlert className="h-2.5 w-2.5" />
                    hard stop
                  </span>
                ) : null}
              </div>
              <div className="flex justify-center">
                <BudgetRing
                  spentCents={agent.spentMonthlyCents}
                  capCents={agent.budgetMonthlyCents}
                  warnPercent={warnPercent}
                  size={140}
                  label={`${agent.tag}: ${formatCents(agent.spentMonthlyCents)} of ${formatCents(agent.budgetMonthlyCents)}, ${pct}%`}
                >
                  <span className="tethr-figure text-[26px]">{formatCents(agent.spentMonthlyCents)}</span>
                  <span className="text-[11px] text-muted-foreground">
                    of {formatCents(agent.budgetMonthlyCents)}
                  </span>
                </BudgetRing>
              </div>
              <p className="tethr-eyebrow flex items-center justify-center gap-2">
                <StatusDot tone={over ? "bad" : hot ? "warn" : "ok"} />
                {pct}% used{over ? " · at cap" : hot ? " · near cap" : ""}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
