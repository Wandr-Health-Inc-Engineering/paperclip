import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Crown, Network, Plus } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  AgentStatusDot,
  BudgetBar,
  MonoTag,
  formatCents,
  formatRelative,
  tethrIcon,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrOverviewAgent } from "@/api/tethr";

// The live company: CEO → divisions → agents → subagents. Growth is fully
// populated; the other divisions are real, navigable shells — adding one is
// data, not architecture.

export function TethrCompany() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Company" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.overview(selectedCompanyId!),
    queryFn: () => tethrApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org." />;
  }
  if (isLoading) return <PageSkeleton variant="org-chart" />;
  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }
  if (!data || data.agents.length === 0) {
    return (
      <EmptyState
        icon={Network}
        message="No Tethr org seeded for this company. Switch to Wandr Growth, or run the seed."
      />
    );
  }

  const ceo = data.agents.find((a) => a.profile.tag === "@ceo");
  const byId = new Map(data.agents.map((a) => [a.agent.id, a]));

  return (
    <div className="space-y-8">
      <div>
        <MonoTag className="text-foreground">● tethr · company</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the org</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One company, many divisions. Click an agent to see its routing table, crew,
          and recent work.
        </p>
      </div>

      {/* CEO */}
      {ceo ? (
        <div className="flex justify-center">
          <div className="flex items-center gap-3 border-2 border-foreground bg-foreground px-5 py-3 text-background">
            <Crown className="h-4 w-4" />
            <div>
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">
                tier · 00
              </span>
              <p className="text-sm font-extrabold leading-tight">CEO</p>
            </div>
            <span className="ml-2 border border-background/40 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] opacity-80">
              placeholder
            </span>
          </div>
        </div>
      ) : null}

      {/* Divisions */}
      <div className="grid gap-5 xl:grid-cols-2" data-tethr-stagger>
        {data.divisions.map((division) => {
          const head = division.headAgentId ? byId.get(division.headAgentId) : null;
          const members = data.agents.filter(
            (a) =>
              a.profile.divisionId === division.id &&
              a.agent.id !== division.headAgentId,
          );
          const DivisionIcon = tethrIcon(division.icon);
          const isShell = division.status === "shell";
          return (
            <section
              key={division.id}
              className={cn(
                "border-2 bg-card",
                isShell ? "border-dashed border-foreground/40" : "border-foreground",
              )}
            >
              <header className="flex items-start justify-between gap-3 border-b-2 border-inherit px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <DivisionIcon className="h-4 w-4" />
                  <div>
                    <h2 className="text-base font-extrabold tracking-tight">
                      {division.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">{division.description}</p>
                  </div>
                </div>
                <MonoTag className={cn(!isShell && "text-foreground")}>
                  {isShell ? "ready to fill" : "division · live"}
                </MonoTag>
              </header>

              {isShell ? (
                <div className="space-y-3 px-4 py-5">
                  <div className="flex items-center gap-3 border border-dashed border-foreground/40 px-3 py-2.5">
                    <Plus className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold text-muted-foreground">
                      Head slot open
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {[0, 1].map((i) => (
                      <div
                        key={i}
                        className="flex h-12 items-center justify-center border border-dashed border-foreground/25"
                      >
                        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">
                          agent slot
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Adding this division is data, not architecture: create a head, point
                    its adapter at a spec folder, drop agents in.
                  </p>
                </div>
              ) : (
                <div className="px-4 py-4">
                  {head ? <AgentRow entry={head} isHead /> : null}
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {members.map((entry) => (
                      <AgentRow key={entry.agent.id} entry={entry} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function AgentRow({ entry, isHead }: { entry: TethrOverviewAgent; isHead?: boolean }) {
  const { agent, profile, subagents, pendingApprovals, lastRunAt } = entry;
  const pct =
    agent.budgetMonthlyCents > 0
      ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
      : 0;
  return (
    <Link
      to={`/crew/${agent.id}`}
      className={cn(
        "group block border bg-background transition-colors hover:border-foreground",
        isHead ? "border-2 border-foreground" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border",
              isHead
                ? "border-foreground bg-foreground text-background"
                : "border-foreground",
            )}
          >
            <AgentGlyph icon={agent.icon} />
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-bold leading-tight">
              {agent.name}
              <AgentStatusDot status={agent.status} />
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {profile.tag} · {agent.title}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingApprovals > 0 ? (
            <span className="border border-amber-600 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-amber-700 dark:border-amber-400 dark:text-amber-300">
              {pendingApprovals} in queue
            </span>
          ) : null}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
      <div className="space-y-1.5 border-t border-border px-3 py-2">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <span>last run {formatRelative(lastRunAt)}</span>
          {agent.budgetMonthlyCents > 0 ? (
            <span>
              {formatCents(agent.spentMonthlyCents)} / {formatCents(agent.budgetMonthlyCents)} ·{" "}
              {pct}%
            </span>
          ) : (
            <span>no cap</span>
          )}
        </div>
        {agent.budgetMonthlyCents > 0 ? (
          <BudgetBar
            spentCents={agent.spentMonthlyCents}
            capCents={agent.budgetMonthlyCents}
          />
        ) : null}
        {subagents.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {subagents.map((s) => (
              <span
                key={s.id}
                className="border border-border px-1.5 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground"
              >
                .{s.key}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}
