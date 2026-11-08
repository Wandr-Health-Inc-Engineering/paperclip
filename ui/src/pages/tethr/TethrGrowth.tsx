import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Lock, TrendingUp } from "lucide-react";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot, formatRelative, type StatusTone } from "@/components/tethr/primitives";
import { Scorecard } from "@/components/tethr/Scorecard";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { tethrApi, tethrKeys, type TethrGrowthTask, type TethrGrowthWorkflow } from "@/api/tethr";
import { cn } from "@/lib/utils";

// The growth board (phase 16): the COO's home. Customer acquisition run as
// tasks — what each agent is carrying, what's waiting on a human, and which
// recurring growth workflows are switched on.

function taskHref(task: TethrGrowthTask): string {
  return `/issues/${task.identifier ?? task.id}`;
}

function TaskRow({ task, tone }: { task: TethrGrowthTask; tone: StatusTone }) {
  return (
    <Link
      to={taskHref(task)}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--tethr-frost-strong)]"
    >
      <StatusDot tone={tone} className="mt-[7px]" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          {task.identifier ? <span className="shrink-0 font-mono text-[11px] tethr-text-3">{task.identifier}</span> : null}
          <span className="truncate text-[13.5px]">{task.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted-foreground">
          {task.assigneeTag ? <span className="font-mono text-[11.5px]">{task.assigneeTag}</span> : null}
          {task.parentTitle ? <span className="truncate">part of “{task.parentTitle}”</span> : null}
          {task.childCount > 0 ? (
            <span>
              {task.doneChildCount}/{task.childCount} sub-tasks done
            </span>
          ) : null}
        </div>
      </div>
      <span className="shrink-0 pt-0.5 font-mono text-[11px] tethr-text-3">
        {formatRelative(task.completedAt ?? task.updatedAt)}
      </span>
    </Link>
  );
}

function Lane({
  title,
  hint,
  tone,
  tasks,
  empty,
}: {
  title: string;
  hint: string;
  tone: StatusTone;
  tasks: TethrGrowthTask[];
  empty: string;
}) {
  return (
    <section className="tethr-panel flex min-w-0 flex-col">
      <header className="flex items-baseline justify-between gap-3 border-b tethr-rule px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        </div>
        <span className="font-mono text-[11px] tethr-text-3">{tasks.length}</span>
      </header>
      <p className="px-4 pt-2 text-[12px] text-muted-foreground">{hint}</p>
      {tasks.length ? (
        <div className="divide-y divide-[var(--tethr-rim)] pb-1">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} tone={tone} />
          ))}
        </div>
      ) : (
        <p className="px-4 pb-4 pt-2 text-[13px] tethr-text-3">{empty}</p>
      )}
    </section>
  );
}

function WorkflowRow({ wf }: { wf: TethrGrowthWorkflow }) {
  const on = wf.status === "active" && wf.scheduleEnabled;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
      <StatusDot tone={on ? "ok" : "paused"} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px]">{wf.title}</span>
          {wf.ownerTag ? <span className="font-mono text-[11.5px] text-muted-foreground">{wf.ownerTag}</span> : null}
        </div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          {wf.cadence ?? "no schedule"}
          {wf.lastTriggeredAt ? ` · last ran ${formatRelative(wf.lastTriggeredAt)}` : " · never run"}
        </div>
      </div>
      <Link
        to={`/routines/${wf.routineId}`}
        className={cn(
          "tethr-btn h-8 px-3.5 text-[12.5px]",
          on ? "tethr-btn-ghost" : "tethr-btn-glass",
        )}
      >
        {on ? "On" : "Switch on"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

/** A count tile; with `to`, the whole tile links there. */
function Stat({ label, value, tone, sub, to }: { label: string; value: string; tone?: StatusTone; sub?: string; to?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-2">
        {tone ? <StatusDot tone={tone} /> : null}
        <MonoTag>{label}</MonoTag>
      </div>
      <span className="tethr-figure text-[28px]">{value}</span>
      {sub ? <span className="text-[12px] text-muted-foreground">{sub}</span> : null}
    </>
  );
  const className = "tethr-panel flex flex-col gap-1.5 px-4 py-3.5";
  return to ? (
    <Link to={to} className={cn(className, "transition-colors hover:bg-[var(--tethr-frost-strong)]")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

const PENDING_STATUSES = ["gated", "changes_requested"];

export function TethrGrowth() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Growth" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.growth(selectedCompanyId!),
    queryFn: () => tethrApi.growth(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  // "Waiting on you" is everything the Queue holds for a decision (the same list
  // the Queue's Pending tab shows), not only items tied to a task.
  const { data: outputs } = useQuery({
    queryKey: tethrKeys.outputs(selectedCompanyId!),
    queryFn: () => tethrApi.outputs(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  if (isLoading || !data) return <PageSkeleton />;

  const { lanes, counts, workflows } = data;
  const nothingInFlight = counts.open === 0 && counts.doneThisWeek === 0;
  const waitingOnYou = outputs ? outputs.filter((o) => PENDING_STATUSES.includes(o.status)).length : counts.waitingOnYou;

  return (
    <div className="space-y-8">
      <Scorecard companyId={selectedCompanyId!} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-tethr-stagger>
        <Stat
          label="waiting on you"
          value={String(waitingOnYou)}
          tone={waitingOnYou ? "warn" : undefined}
          sub={waitingOnYou ? "decide in the Queue" : "nothing to decide"}
          to={waitingOnYou ? "/queue" : undefined}
        />
        <Stat label="open tasks" value={String(counts.open)} tone={lanes.working.length ? "live" : undefined} sub={`${lanes.working.length} being worked now`} />
        <Stat label="done this week" value={String(counts.doneThisWeek)} tone={counts.doneThisWeek ? "ok" : undefined} />
        <Stat
          label="workflows on"
          value={`${counts.workflowsOn}`}
          sub={counts.workflowsTotal ? `of ${counts.workflowsTotal} · each starts paused` : "none set up"}
        />
      </div>

      {lanes.waitingOnYou.length ? (
        <section className="space-y-3">
          <MonoTag>waiting on you</MonoTag>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {lanes.waitingOnYou.map((t) => (
              <Link
                key={t.id}
                to={t.pendingOutputId ? `/queue/${t.pendingOutputId}` : taskHref(t)}
                className="tethr-glass flex flex-col gap-2 p-4 transition-colors hover:border-[var(--tethr-rim-strong)]"
              >
                <div className="flex items-center gap-2">
                  <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
                    <TrendingUp className="h-3.5 w-3.5" />
                  </span>
                  <span className="text-[15px] font-medium tracking-[-0.01em]">{t.assigneeTag ?? "agent"}</span>
                  <span className="ml-auto font-mono text-[11px] tethr-text-3">{formatRelative(t.updatedAt)}</span>
                </div>
                <span className="tethr-eyebrow inline-flex items-center gap-1.5">
                  <Lock className="h-2.5 w-2.5" />
                  awaiting review{t.identifier ? ` · ${t.identifier}` : ""}
                </span>
                <p className="text-[13px] leading-snug">{t.title}</p>
                {t.parentTitle ? <p className="text-[12px] text-muted-foreground">part of “{t.parentTitle}”</p> : null}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {nothingInFlight ? (
        <div className="tethr-empty tethr-reeds px-6 py-10 text-center">
          <p className="text-[15px] text-foreground">No growth work in flight.</p>
          <p className="mx-auto mt-2 max-w-[56ch] text-[13px]">
            Ask tethr in the chat to plan a push or take on a piece of work. Tasks it opens show up here while
            they're being worked, and anything that needs your OK waits in the Queue.
          </p>
          <Link to="/chat" className="tethr-btn tethr-btn-primary mt-5 h-9 px-4 text-sm">
            Open the chat
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Lane
            title="Working"
            hint="An agent is on it right now."
            tone="live"
            tasks={lanes.working}
            empty="Nobody is mid-task."
          />
          <Lane
            title="Waiting on sub-tasks"
            hint="Delegated pieces are still out; the owner rolls up when they're back."
            tone="idle"
            tasks={lanes.blocked}
            empty="No task is waiting on others."
          />
          <Lane
            title="Up next"
            hint="Assigned and queued for the agent's next wake."
            tone="idle"
            tasks={lanes.queued}
            empty="The queue is clear."
          />
        </div>
      )}

      {lanes.doneThisWeek.length ? (
        <section className="tethr-panel">
          <header className="flex items-baseline justify-between border-b tethr-rule px-4 py-3">
            <div className="flex items-center gap-2">
              <StatusDot tone="ok" />
              <h2 className="text-[15px] font-medium tracking-[-0.01em]">Done this week</h2>
            </div>
            <span className="font-mono text-[11px] tethr-text-3">{lanes.doneThisWeek.length}</span>
          </header>
          <div className="divide-y divide-[var(--tethr-rim)]">
            {lanes.doneThisWeek.map((t) => (
              <TaskRow key={t.id} task={t} tone="ok" />
            ))}
          </div>
        </section>
      ) : null}

      {workflows.length ? (
        <section className="tethr-panel">
          <header className="border-b tethr-rule px-4 py-3">
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Growth workflows</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Each one is a playbook that opens a task for its owner on schedule. They start paused; switch one on
              from its routine page when you're ready for it to run on its own.
            </p>
          </header>
          <div className="divide-y divide-[var(--tethr-rim)]">
            {workflows.map((wf) => (
              <WorkflowRow key={wf.routineId} wf={wf} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
