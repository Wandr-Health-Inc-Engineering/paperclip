import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, SearchX } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, formatRelative } from "@/components/tethr/primitives";
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

export function TethrAudit() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [kind, setKind] = useState("all");
  const [actor, setActor] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit" }]);
  }, [setBreadcrumbs]);

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

  return (
    <div className="space-y-5">
      <div>
        <MonoTag className="text-foreground">● tethr · audit</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the trail</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every hop, run, output, and decision. A request's full path is always
          reconstructable.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {KINDS.map((option) => (
          <button
            key={option.value}
            onClick={() => setKind(option.value)}
            className={cn(
              "border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] transition-colors",
              kind === option.value
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
        <Input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="filter by actor (@sonar, mark…)"
          className="ml-auto h-8 w-56 font-mono text-xs"
        />
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : data?.length ? (
        <div className="border-2 border-foreground bg-card">
          {data.map((event, index) => (
            <AuditRow key={event.id} event={event} last={index === data.length - 1} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center border border-dashed border-foreground/30 px-4 py-12">
          <SearchX className="mb-3 h-7 w-7 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No events match this filter.</p>
        </div>
      )}
    </div>
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
        !last && "border-b border-border",
      )}
    >
      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {formatRelative(event.createdAt)}
      </span>
      <span className="min-w-0 text-sm">
        <span className="font-mono text-[12px] font-bold">{event.actorId}</span>{" "}
        <span className="font-semibold">
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
          <span className="mt-0.5 block border-l-2 border-foreground pl-2 text-xs text-muted-foreground">
            {reviewer}: “{note}”
          </span>
        ) : null}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground/70">
        {event.entityType.replace("tethr_", "")}
      </span>
    </div>
  );
}
