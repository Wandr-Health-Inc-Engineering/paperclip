import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  StatusDot,
  formatRelative,
  type StatusTone,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrAuditEvent } from "@/api/tethr";

// The audit log: every route hop, run, output, and approval decision —
// the reconstructable trail the compliance layer promises.

const KINDS = [
  { value: "all", label: "everything" },
  { value: "routing", label: "routing" },
  { value: "outputs", label: "outputs" },
  { value: "approvals", label: "approvals" },
  { value: "runs", label: "runs" },
  { value: "drive", label: "drive" },
];

const ACTION_LABEL: Record<string, string> = {
  tethr_route_hop: "route hop",
  tethr_output_gated: "output gated",
  tethr_output_created: "output created",
  tethr_output_published: "published",
  tethr_output_approved: "approved",
  tethr_output_rejected: "rejected",
  tethr_output_changes_requested: "changes requested",
  tethr_run_now: "manual run",
  tethr_drive_file_saved: "drive write",
};

/** Outcome dot per event: what happened to the work, at a glance. */
const ACTION_TONE: Record<string, StatusTone> = {
  tethr_output_published: "ok",
  tethr_output_approved: "ok",
  tethr_drive_file_saved: "ok",
  tethr_output_gated: "warn",
  tethr_output_changes_requested: "changes",
  tethr_output_rejected: "bad",
};

function actionTone(action: string): StatusTone {
  if (ACTION_TONE[action]) return ACTION_TONE[action];
  if (/fail|error|reject/.test(action)) return "bad";
  return "idle";
}

const PER_PAGE = 20;

export function TethrAudit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [kind, setKind] = useState("all");
  const [actor, setActor] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Activity" }]);
  }, [setBreadcrumbs]);

  // A new filter is a new trail — jump back to the first page.
  useEffect(() => {
    setPage(0);
  }, [kind, actor, selectedCompanyId]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.audit(selectedCompanyId!, kind, actor),
    queryFn: () =>
      tethrApi.audit(selectedCompanyId!, {
        kind,
        actor: actor.trim() || undefined,
        limit: 150,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ScrollText} message="Select a company to view the audit log." />;
  }

  const total = data?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PER_PAGE;
  const pageItems = (data ?? []).slice(start, start + PER_PAGE);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={kind === option.value}
              onClick={() => setKind(option.value)}
              className={cn(
                "tethr-btn tethr-touch-sized h-7 shrink-0 px-3 text-[12.5px] pointer-coarse:h-8",
                kind === option.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="filter by actor (@tethr, a name…)"
          className="ml-auto h-8 w-72 px-3 font-mono text-xs max-md:ml-0 max-md:w-full"
        />
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : total ? (
        <>
          <div className="tethr-panel overflow-hidden">
            {pageItems.map((event, index) => (
              <AuditRow
                key={event.id}
                event={event}
                last={index === pageItems.length - 1}
              />
            ))}
          </div>

          {pageCount > 1 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="tethr-eyebrow tabular-nums">
                {start + 1}–{start + pageItems.length} of {total}
                {total === 150 ? "+" : ""}
              </span>
              <div className="flex items-center gap-2">
                <PagerButton
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage === 0}
                >
                  ← prev
                </PagerButton>
                <span className="tethr-eyebrow tabular-nums">
                  {safePage + 1} / {pageCount}
                </span>
                <PagerButton
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pageCount - 1}
                >
                  next →
                </PagerButton>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <div className="tethr-empty flex flex-col items-center px-4 py-12">
          <SearchX className="mb-3 h-7 w-7 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No events match this filter.</p>
        </div>
      )}
    </div>
  );
}

function PagerButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="tethr-btn tethr-btn-glass h-7 px-3 text-[12px]"
    >
      {children}
    </button>
  );
}

function AuditRow({ event, last }: { event: TethrAuditEvent; last: boolean }) {
  const details = event.details ?? {};
  const summary =
    (details.title as string) ??
    (details.decision as string) ??
    (details.path as string) ??
    (details.reason as string) ??
    (details.request as string) ??
    "";
  const decision = details.decision ? ` → ${String(details.decision)}` : "";
  const note = details.note ? String(details.note) : null;
  const reviewer = details.reviewer ? String(details.reviewer) : null;

  return (
    <div
      className={cn(
        "grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5 max-md:grid-cols-1 max-md:gap-1",
        !last && "tethr-rule border-b",
      )}
    >
      <span className="tethr-eyebrow flex items-center gap-2 text-[10px] tracking-[0.14em]">
        <StatusDot tone={actionTone(event.action)} className="translate-y-[-1px]" />
        {formatRelative(event.createdAt)}
      </span>
      <span className="min-w-0 text-sm">
        <span className="font-mono text-[12px] font-medium">{event.actorId}</span>{" "}
        <span className="font-medium">
          {ACTION_LABEL[event.action] ?? event.action.replace(/[._]/g, " ")}
        </span>
        {summary ? (
          <span className="text-muted-foreground">
            {" "}
            — {summary}
            {decision}
          </span>
        ) : null}
        {reviewer && note ? (
          <span className="mt-1 block border-l-2 border-[var(--tethr-rim-strong)] pl-2 text-xs text-muted-foreground">
            {reviewer}: “{note}”
          </span>
        ) : null}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--tethr-text-3)]">
        {event.entityType.replace("tethr_", "")}
      </span>
    </div>
  );
}
