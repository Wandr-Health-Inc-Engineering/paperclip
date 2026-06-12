import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Play, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  MonoTag,
  describeCron,
  formatRelative,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrRunRow } from "@/api/tethr";

// Runs: the heartbeat schedule (mapped from the manifest crons) and the run
// history. Human-readable intent first; raw transcript underneath.

export function TethrRuns() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Runs" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.runs(selectedCompanyId!),
    queryFn: () => tethrApi.runs(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15000,
  });

  const runNow = useMutation({
    mutationFn: (agentId: string) => tethrApi.runNow(selectedCompanyId!, agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.runs(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["tethr", selectedCompanyId, "outputs"] });
      queryClient.invalidateQueries({ queryKey: tethrKeys.overview(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Timer} message="Select a company to view runs." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      <div>
        <MonoTag className="text-foreground">● tethr · runs</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">heartbeats</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A heartbeat wakes the agent, routes the standing request down the chain, and
          stages the output — gated work stops in the Queue.
        </p>
      </div>

      {/* Schedule */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>schedule</MonoTag>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-tethr-stagger>
          {data?.schedules.map((schedule) => (
            <div
              key={schedule.routineId}
              className={cn(
                "border-2 bg-card p-4",
                schedule.status === "paused"
                  ? "border-dashed border-foreground/40"
                  : "border-foreground",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-extrabold tracking-tight">{schedule.title}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {schedule.agentTag} · {describeCron(schedule.cron)}
                  </p>
                </div>
                <span
                  className={cn(
                    "border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]",
                    schedule.status === "paused"
                      ? "border-amber-600 text-amber-700 dark:border-amber-400 dark:text-amber-300"
                      : "border-foreground text-foreground",
                  )}
                >
                  {schedule.status}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {schedule.description}
              </p>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
                <span className="font-mono text-[10px] text-muted-foreground">
                  {schedule.enabled && schedule.nextRunAt
                    ? `next: ${new Date(schedule.nextRunAt).toLocaleString("en-US", {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}`
                    : "trigger disabled"}
                </span>
                {schedule.agentId ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => runNow.mutate(schedule.agentId!)}
                    disabled={runNow.isPending}
                  >
                    <Play className="mr-1 h-3 w-3" />
                    Run now
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {runNow.isError ? (
          <p className="mt-2 text-sm text-destructive">{(runNow.error as Error).message}</p>
        ) : null}
      </section>

      {/* History */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Timer className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>run history</MonoTag>
        </div>
        {data?.runs.length ? (
          <div className="space-y-1.5">
            {data.runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        )}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: TethrRunRow }) {
  const [expanded, setExpanded] = useState(false);
  const tone =
    run.status === "succeeded"
      ? "text-emerald-700 border-emerald-700 dark:text-emerald-300 dark:border-emerald-400"
      : run.status === "failed"
        ? "text-destructive border-destructive"
        : run.status === "running"
          ? "text-cyan-700 border-cyan-700 dark:text-cyan-300 dark:border-cyan-400"
          : "text-muted-foreground border-border";
  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  return (
    <div className="border border-border bg-card">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-foreground">
          <AgentGlyph icon={run.agentIcon} className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {run.summary ?? run.triggerDetail ?? `${run.agentName} heartbeat`}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            {run.agentTag ?? run.agentName} · {run.invocationSource} ·{" "}
            {formatRelative(run.startedAt)}
            {durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]",
            tone,
          )}
        >
          {run.status}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div className="border-t border-border bg-secondary/40 px-4 py-3">
          {run.error ? (
            <p className="mb-2 text-xs font-semibold text-destructive">{run.error}</p>
          ) : null}
          {run.stdoutExcerpt ? (
            <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
              {run.stdoutExcerpt}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">No transcript recorded.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
