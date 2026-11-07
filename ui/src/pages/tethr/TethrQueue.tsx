import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  FileText,
  FileWarning,
  Inbox,
  Lock,
  MessageSquare,
  ShieldCheck,
  Undo2,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  MonoTag,
  OUTPUT_STATUS_LABEL,
  OutputStatusBadge,
  SensitivityBadge,
  StatusDot,
  formatRelative,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { useNavigate, useParams } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrOutputListItem } from "@/api/tethr";

// The Queue: every gated output (medical / public-facing / spend / PR) stops
// here. Approve publishes to the Drive; reject and request-changes send it
// back. Every decision is recorded with reviewer + reason in the audit log.
// Nothing gated ships any other way.

export function TethrQueue() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const params = useParams<{ outputId?: string }>();
  const selectedId = params.outputId ?? null;
  const [tab, setTab] = useState<"pending" | "decided" | "all">("pending");

  useEffect(() => {
    setBreadcrumbs([{ label: "Queue", href: "/queue" }]);
  }, [setBreadcrumbs]);

  const { data: outputs, isLoading } = useQuery({
    queryKey: tethrKeys.outputs(selectedCompanyId!),
    queryFn: () => tethrApi.outputs(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const filtered = useMemo(() => {
    if (!outputs) return [];
    if (tab === "pending") {
      return outputs.filter((o) => ["gated", "changes_requested"].includes(o.status));
    }
    if (tab === "decided") {
      return outputs.filter((o) =>
        ["published", "approved", "rejected"].includes(o.status),
      );
    }
    return outputs;
  }, [outputs, tab]);

  const pendingCount =
    outputs?.filter((o) => ["gated", "changes_requested"].includes(o.status)).length ?? 0;

  if (!selectedCompanyId) {
    return <EmptyState icon={Inbox} message="Select a company to view the queue." />;
  }
  if (isLoading) return <PageSkeleton variant="approvals" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          items={[
            { value: "pending", label: `Pending${pendingCount ? ` (${pendingCount})` : ""}` },
            { value: "decided", label: "Decided" },
            { value: "all", label: "All" },
          ]}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* List — hidden on mobile when a detail is open */}
        <div className={cn("space-y-2", selectedId && "hidden lg:block")} data-tethr-stagger>
          {filtered.length === 0 ? (
            <div className="tethr-empty flex flex-col items-center px-4 py-12 text-center">
              <ShieldCheck className="mb-3 h-7 w-7 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {tab === "pending"
                  ? "Nothing in the queue."
                  : "No decided items yet."}
              </p>
            </div>
          ) : (
            filtered.map((output) => (
              <QueueCard
                key={output.id}
                output={output}
                selected={output.id === selectedId}
                onOpen={() => navigate(`/queue/${output.id}`)}
              />
            ))
          )}
        </div>

        {/* Detail */}
        <div className={cn(!selectedId && "hidden lg:block")}>
          {selectedId ? (
            <QueueDetail
              companyId={selectedCompanyId}
              outputId={selectedId}
              onBack={() => navigate("/queue")}
            />
          ) : (
            <div className="tethr-empty flex h-full min-h-64 items-center justify-center">
              <p className="px-6 text-center text-sm text-muted-foreground">
                Select an item to review its full content, sensitivity, and history.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Segmented filter: a frosted pill group. */
function PillTabs({
  items,
  value,
  onValueChange,
}: {
  items: { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)]"
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(item.value)}
            className={cn(
              "tethr-btn h-7 px-3.5 text-[12.5px]",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  org_change: Users,
  agent_proposal: UserPlus,
  drive_change: Archive,
  answer: MessageSquare,
  document: FileText,
  brief: FileText,
};

/** The frosted agent tile — a rounded square holding the output's glyph. */
function KindTile({ kind }: { kind: string }) {
  const Icon = KIND_ICON[kind] ?? Bot;
  return (
    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-[var(--tethr-frost-strong)] text-foreground shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function QueueCard({
  output,
  selected,
  onOpen,
}: {
  output: TethrOutputListItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const agentTag = (output.meta?.agentTag as string) ?? output.subagentTag ?? "";
  const pending = ["gated", "changes_requested"].includes(output.status);
  const preview = output.preview.replace(/[#>*`|-]/g, " ").replace(/\s+/g, " ").trim();

  // Awaiting a human: the signature glass card (agent tile, eyebrow, one line).
  if (pending) {
    return (
      <button
        onClick={onOpen}
        className={cn(
          "tethr-glass block w-full p-3.5 text-left transition-[border-color,background-color]",
          selected
            ? "border-[var(--tethr-rim-strong)] bg-[var(--tethr-frost-strong)]"
            : "hover:border-[var(--tethr-rim-strong)]",
        )}
      >
        <div className="flex items-center gap-2.5">
          <KindTile kind={output.kind} />
          <span className="min-w-0 truncate text-[15px] font-medium tracking-[-0.01em]">
            {output.subagentTag ?? agentTag ?? output.title}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--tethr-text-3)]">
            {formatRelative(output.createdAt)}
          </span>
        </div>
        <p className="tethr-eyebrow mt-2 flex items-center gap-1.5">
          {output.status === "changes_requested" ? (
            <StatusDot status={output.status} />
          ) : (
            <Lock className="h-2.5 w-2.5" />
          )}
          {OUTPUT_STATUS_LABEL[output.status] ?? output.status} · {output.sensitivity}
        </p>
        <p className="mt-1.5 text-[13.5px] font-medium leading-snug">{output.title}</p>
        {preview ? (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
            {preview}
          </p>
        ) : null}
      </button>
    );
  }

  return (
    <button
      onClick={onOpen}
      className={cn(
        "tethr-panel block w-full p-3.5 text-left",
        selected ? "tethr-panel-active" : "tethr-panel-hover",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium leading-snug">{output.title}</p>
        <SensitivityBadge sensitivity={output.sensitivity} className="shrink-0" />
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {preview}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="tethr-eyebrow text-[10px] tracking-[0.14em]">
          {output.subagentTag ?? agentTag} · {formatRelative(output.createdAt)}
        </span>
        <OutputStatusBadge status={output.status} />
      </div>
    </button>
  );
}

function QueueDetail({
  companyId,
  outputId,
  onBack,
}: {
  companyId: string;
  outputId: string;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [note, setNote] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.output(companyId, outputId),
    queryFn: () => tethrApi.output(companyId, outputId),
  });

  const decideMutation = useMutation({
    mutationFn: (decision: "approve" | "reject" | "request_changes") =>
      tethrApi.decide(companyId, outputId, decision, note.trim() || undefined),
    onSuccess: () => {
      setNote("");
      queryClient.invalidateQueries({ queryKey: tethrKeys.output(companyId, outputId) });
      queryClient.invalidateQueries({ queryKey: tethrKeys.outputs(companyId) });
      queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "overview"] });
    },
  });

  const reviseMutation = useMutation({
    mutationFn: () => tethrApi.revise(companyId, outputId, note.trim() || undefined),
    onSuccess: (result) => {
      setNote("");
      queryClient.invalidateQueries({ queryKey: tethrKeys.outputs(companyId) });
      queryClient.invalidateQueries({ queryKey: tethrKeys.output(companyId, outputId) });
      if (result?.outputId) navigate(`/queue/${result.outputId}`);
    },
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) {
    return (
      <p className="text-sm text-destructive">
        {(error as Error)?.message ?? "Output not found."}
      </p>
    );
  }
  const { output, approval, subagent, revisions } = data;
  const decidable = ["gated", "changes_requested"].includes(output.status);
  const hasNewerRevision = revisions.some(
    (r) => r.revisionNumber > (revisions.find((x) => x.id === output.id)?.revisionNumber ?? 1),
  );

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px] lg:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> back to queue
      </button>

      <div className="tethr-panel overflow-hidden">
        <header className="tethr-rule border-b px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <SensitivityBadge sensitivity={output.sensitivity} />
            <OutputStatusBadge status={output.status} />
            <span className="tethr-eyebrow ml-auto text-[10px] tracking-[0.14em]">
              {(output.meta?.agentTag as string) ?? ""} · {formatRelative(output.createdAt)}
            </span>
          </div>
          <h2 className="mt-2.5 text-[22px] font-normal leading-tight tracking-[-0.02em]">
            {output.title}
          </h2>
          {subagent ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Produced by <span className="font-mono font-medium text-foreground">{subagent.tag}</span> —{" "}
              {subagent.job}
            </p>
          ) : null}
          {revisions.length > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <MonoTag>lineage</MonoTag>
              {revisions.map((rev, i) => (
                <span key={rev.id} className="flex items-center gap-1.5">
                  {i > 0 ? <span className="text-muted-foreground">→</span> : null}
                  <button
                    onClick={() => navigate(`/queue/${rev.id}`)}
                    className={cn(
                      "tethr-pill px-2 py-0.5 text-[10px] leading-4 transition-colors",
                      rev.id === output.id
                        ? "tethr-pill-solid"
                        : "hover:bg-accent hover:text-foreground",
                    )}
                  >
                    v{rev.revisionNumber} · {OUTPUT_STATUS_LABEL[rev.status] ?? rev.status}
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </header>

        <div className="px-4 py-4">
          <div className="tethr-inset max-h-[28rem] overflow-auto px-4 py-3.5">
            <MarkdownBody className="text-sm leading-relaxed">{output.body}</MarkdownBody>
          </div>
        </div>

        {subagent && subagent.guardrails.length > 0 ? (
          <div className="tethr-rule border-t bg-[var(--tethr-frost)] px-4 py-3">
            <MonoTag>guardrails on this output</MonoTag>
            <ul className="mt-1.5 space-y-1">
              {subagent.guardrails.slice(0, 4).map((rule) => (
                <li key={rule} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-mono text-[var(--tethr-text-3)]">→</span>
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Decision panel */}
        {decidable ? (
          <div className="tethr-rule space-y-3 border-t px-4 py-4">
            <MonoTag className="text-foreground">your decision</MonoTag>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (recorded in the audit log)"
              rows={2}
              className="tethr-field text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="tethr-btn tethr-btn-primary h-9 px-4 text-[13px]"
                onClick={() => decideMutation.mutate("approve")}
                disabled={decideMutation.isPending}
              >
                <Check className="h-3.5 w-3.5" />
                Approve + publish
              </button>
              <button
                type="button"
                className="tethr-btn tethr-btn-glass h-9 px-4 text-[13px]"
                onClick={() => decideMutation.mutate("request_changes")}
                disabled={decideMutation.isPending}
              >
                <Undo2 className="h-3.5 w-3.5" />
                Request changes
              </button>
              <button
                type="button"
                className="tethr-btn tethr-btn-danger h-9 px-4 text-[13px]"
                onClick={() => decideMutation.mutate("reject")}
                disabled={decideMutation.isPending}
              >
                <X className="h-3.5 w-3.5" />
                Reject
              </button>
            </div>
            {decideMutation.isError ? (
              <p className="text-sm text-destructive">
                {(decideMutation.error as Error).message}
              </p>
            ) : null}
            <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--tethr-text-3)]">
              <FileWarning className="h-3 w-3" />
              Approve writes the file to the Drive. Reject and request-changes send it
              back to the agent. All three are audit-logged with your name.
            </p>
          </div>
        ) : approval ? (
          <div className="tethr-rule border-t px-4 py-4">
            <MonoTag>decision record</MonoTag>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm">
              <StatusDot status={approval.status} />
              <span className="font-medium">
                {approval.status === "approved"
                  ? "Approved"
                  : approval.status === "rejected"
                    ? "Rejected"
                    : "Changes requested"}
              </span>{" "}
              by <span className="font-mono text-[13px]">{approval.decidedByUserId}</span>
              {approval.decidedAt ? ` · ${formatRelative(approval.decidedAt)}` : null}
            </p>
            {approval.decisionNote ? (
              <p className="mt-1.5 border-l-2 border-[var(--tethr-rim-strong)] pl-3 text-sm text-muted-foreground">
                {approval.decisionNote}
              </p>
            ) : null}
            {output.publishedAt ? (
              <p className="tethr-eyebrow mt-2.5 flex items-center gap-1.5">
                <StatusDot tone="ok" />
                published to the drive · {formatRelative(output.publishedAt)}
              </p>
            ) : null}
            {["changes_requested", "rejected"].includes(output.status) &&
            !hasNewerRevision ? (
              <div className="tethr-rule mt-3 border-t pt-3">
                <button
                  type="button"
                  className="tethr-btn tethr-btn-glass h-8 px-3.5 text-[13px]"
                  onClick={() => reviseMutation.mutate()}
                  disabled={reviseMutation.isPending}
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {reviseMutation.isPending
                    ? "Agent is revising…"
                    : "Send back to the agent for a revision"}
                </button>
                {reviseMutation.isError ? (
                  <p className="mt-1.5 text-xs text-destructive">
                    {(reviseMutation.error as Error).message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
