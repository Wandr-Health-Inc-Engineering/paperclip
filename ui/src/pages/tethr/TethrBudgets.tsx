import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign, OctagonAlert } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  BudgetBar,
  MonoTag,
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
    <div className="space-y-6">
      <div>
        <MonoTag className="text-foreground">● tethr · budgets</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the growth line</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Helm holds the combined budget. Each agent has a monthly cap; Tailwind
          hard-stops because it moves real money.
        </p>
      </div>

      {/* Combined line */}
      <div className="border-2 border-foreground bg-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <MonoTag>combined growth line · this month</MonoTag>
            <p className="mt-1 text-4xl font-extrabold tracking-tight">
              {formatCents(totalSpent)}
              <span className="ml-2 text-base font-bold text-muted-foreground">
                of {formatCents(totalCap)}
              </span>
            </p>
          </div>
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            held by @helm · warn at {data.companyPolicy?.warnPercent ?? 80}%
          </p>
        </div>
        <BudgetBar
          spentCents={totalSpent}
          capCents={totalCap}
          warnPercent={data.companyPolicy?.warnPercent ?? 80}
          className="mt-4 h-2.5"
        />

        {/* 30-day spend chart */}
        <div className="mt-6">
          <MonoTag>spend · last 30 days</MonoTag>
          <div className="mt-2 flex h-24 items-end gap-[3px]">
            {daily.map((point) => (
              <div
                key={point.day}
                className="group relative flex h-full flex-1 flex-col justify-end"
                title={`${point.day}: ${formatCents(point.costCents)}`}
              >
                {point.costCents > 0 ? (
                  <div
                    data-tethr-chart-bar
                    className="w-full bg-foreground transition-colors group-hover:bg-cyan-500"
                    style={{
                      height: `${Math.max(4, (point.costCents / maxDay) * 100)}%`,
                    }}
                  />
                ) : (
                  <div className="h-0.5 w-full bg-muted" />
                )}
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
            <span>30 days ago</span>
            <span>today</span>
          </div>
        </div>
      </div>

      {/* Per-agent caps */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-tethr-stagger>
        {crew.map((agent) => {
          const pct =
            agent.budgetMonthlyCents > 0
              ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
              : 0;
          const hot = pct >= (agent.policy?.warnPercent ?? 80);
          return (
            <Link
              key={agent.agentId}
              to={`/crew/${agent.agentId}`}
              className="block border-2 border-border bg-card p-4 transition-colors hover:border-foreground"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center border border-foreground">
                    <AgentGlyph icon={agent.icon} className="h-3.5 w-3.5" />
                  </div>
                  <div>
                    <p className="text-sm font-extrabold leading-tight">{agent.name}</p>
                    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {agent.tag}
                    </p>
                  </div>
                </div>
                {agent.policy?.hardStopEnabled ? (
                  <span className="flex items-center gap-1 border border-foreground bg-foreground px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-background">
                    <OctagonAlert className="h-2.5 w-2.5" />
                    hard stop
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-xl font-extrabold tracking-tight">
                {formatCents(agent.spentMonthlyCents)}
                <span className="ml-1.5 text-xs font-bold text-muted-foreground">
                  / {formatCents(agent.budgetMonthlyCents)}
                </span>
              </p>
              <BudgetBar
                spentCents={agent.spentMonthlyCents}
                capCents={agent.budgetMonthlyCents}
                warnPercent={agent.policy?.warnPercent ?? 80}
                className="mt-2"
              />
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                {pct}% used{hot ? " · over warn threshold" : ""}
              </p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
