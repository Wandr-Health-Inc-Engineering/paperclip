import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, Play, Timer } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  MonoTag,
  StatusDot,
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
      {/* Schedule */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>schedule</MonoTag>
        </div>
        {data && !data.schedules.length ? (
          <div className="tethr-empty px-4 py-6 text-center text-sm">Nothing runs on a schedule yet.</div>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-tethr-stagger>
          {data?.schedules.map((schedule) => (
            <div
              key={schedule.routineId}
              className={cn(
                "tethr-panel p-4",
                schedule.status === "paused" && "border-dashed border-[var(--tethr-rim-strong)]",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[15px] font-medium tracking-[-0.01em]">{schedule.title}</p>
                  <p className="tethr-eyebrow mt-1 text-[10px] tracking-[0.14em]">
                    {schedule.agentTag} · {describeCron(schedule.cron)}
                  </p>
                </div>
                <span className="tethr-pill shrink-0 px-2 py-0.5 text-[10px] leading-4">
                  <StatusDot status={schedule.status} />
                  {schedule.status}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {schedule.description}
              </p>
              <div className="tethr-rule mt-3 flex items-center justify-between border-t pt-2.5">
                <span className="font-mono text-[10.5px] text-[var(--tethr-text-3)]">
                  {schedule.enabled && schedule.nextRunAt
                    ? `next: ${new Date(schedule.nextRunAt).toLocaleString("en-US", {
                        weekday: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}`
                    : "trigger disabled"}
                </span>
                {schedule.agentId ? (
                  <button
                    type="button"
                    className="tethr-btn tethr-btn-glass h-7 px-3 text-[12px]"
                    onClick={() => runNow.mutate(schedule.agentId!)}
                    disabled={runNow.isPending}
                  >
                    <Play className="h-3 w-3" />
                    Run now
                  </button>
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
          <div className="tethr-empty px-4 py-10 text-center text-sm">No runs yet.</div>
        )}
      </section>
    </div>
  );
}

function RunRow({ run }: { run: TethrRunRow }) {
  const [expanded, setExpanded] = useState(false);
  const durationMs =
    run.startedAt && run.finishedAt
      ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
      : null;

  return (
    <div className={cn("tethr-panel overflow-hidden", !expanded && "tethr-panel-hover")}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
      >
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
          <AgentGlyph icon={run.agentIcon} className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {run.summary ?? run.triggerDetail ?? `${run.agentName} heartbeat`}
          </p>
          <p className="tethr-eyebrow mt-0.5 truncate text-[10px] tracking-[0.14em]">
            {run.agentTag ?? run.agentName} · {run.invocationSource} ·{" "}
            {formatRelative(run.startedAt)}
            {durationMs != null ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""}
          </p>
        </div>
        <span className="tethr-pill shrink-0 px-2 py-0.5 text-[10px] leading-4">
          <StatusDot status={run.status} />
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
        <div className="tethr-rule border-t px-3 py-3">
          {run.error ? (
            <p className="tethr-tone-bad mb-2 flex items-start gap-1.5 text-xs font-medium">
              <StatusDot tone="bad" className="mt-1" />
              {run.error}
            </p>
          ) : null}
          {run.stdoutExcerpt ? (
            <pre className="tethr-inset overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
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
