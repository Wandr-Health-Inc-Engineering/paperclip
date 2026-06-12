import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  FileWarning,
  Inbox,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  MonoTag,
  OutputStatusBadge,
  SensitivityBadge,
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <MonoTag className="text-foreground">● tethr · queue</MonoTag>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {pendingCount > 0
              ? `${pendingCount} item${pendingCount === 1 ? "" : "s"} awaiting review. Gated output cannot ship without a decision here.`
              : "Nothing waiting. The crew will let you know when something needs you."}
          </p>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <PageTabBar
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            items={[
              { value: "pending", label: `Pending${pendingCount ? ` (${pendingCount})` : ""}` },
              { value: "decided", label: "Decided" },
              { value: "all", label: "All" },
            ]}
          />
        </Tabs>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* List — hidden on mobile when a detail is open */}
        <div className={cn("space-y-2", selectedId && "hidden lg:block")} data-tethr-stagger>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center border border-dashed border-foreground/30 px-4 py-12 text-center">
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
            <div className="flex h-full min-h-64 items-center justify-center border border-dashed border-foreground/30">
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
  return (
    <button
      onClick={onOpen}
      className={cn(
        "block w-full border-2 bg-card p-3.5 text-left transition-colors",
        selected ? "border-foreground" : "border-border hover:border-foreground/60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-bold leading-snug">{output.title}</p>
        <SensitivityBadge sensitivity={output.sensitivity} className="shrink-0" />
      </div>
      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {output.preview.replace(/[#>*`|-]/g, " ").replace(/\s+/g, " ").trim()}
      </p>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
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

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) {
    return (
      <p className="text-sm text-destructive">
        {(error as Error)?.message ?? "Output not found."}
      </p>
    );
  }
  const { output, approval, subagent } = data;
  const decidable = ["gated", "changes_requested"].includes(output.status);

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground lg:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> back to queue
      </button>

      <div className="border-2 border-foreground bg-card">
        <header className="border-b-2 border-foreground px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <SensitivityBadge sensitivity={output.sensitivity} />
            <OutputStatusBadge status={output.status} />
            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {(output.meta?.agentTag as string) ?? ""} · {formatRelative(output.createdAt)}
            </span>
          </div>
          <h2 className="mt-2 text-xl font-extrabold leading-tight tracking-tight">
            {output.title}
          </h2>
          {subagent ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Produced by <span className="font-mono font-semibold">{subagent.tag}</span> —{" "}
              {subagent.job}
            </p>
          ) : null}
        </header>

        <div className="max-h-[28rem] overflow-auto px-4 py-4">
          <MarkdownBody className="text-sm leading-relaxed">{output.body}</MarkdownBody>
        </div>

        {subagent && subagent.guardrails.length > 0 ? (
          <div className="border-t border-border bg-secondary/60 px-4 py-3">
            <MonoTag>guardrails on this output</MonoTag>
            <ul className="mt-1.5 space-y-1">
              {subagent.guardrails.slice(0, 4).map((rule) => (
                <li key={rule} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <span className="font-mono font-bold text-foreground">→</span>
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Decision panel */}
        {decidable ? (
          <div className="space-y-3 border-t-2 border-foreground px-4 py-4">
            <MonoTag className="text-foreground">your decision</MonoTag>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason (recorded in the audit log)"
              rows={2}
              className="text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => decideMutation.mutate("approve")}
                disabled={decideMutation.isPending}
              >
                <Check className="mr-1.5 h-3.5 w-3.5" />
                Approve + publish
              </Button>
              <Button
                variant="outline"
                onClick={() => decideMutation.mutate("request_changes")}
                disabled={decideMutation.isPending}
              >
                <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                Request changes
              </Button>
              <Button
                variant="destructive"
                onClick={() => decideMutation.mutate("reject")}
                disabled={decideMutation.isPending}
              >
                <X className="mr-1.5 h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
            {decideMutation.isError ? (
              <p className="text-sm text-destructive">
                {(decideMutation.error as Error).message}
              </p>
            ) : null}
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <FileWarning className="h-3 w-3" />
              Approve writes the file to the Drive. Reject and request-changes send it
              back to the agent. All three are audit-logged with your name.
            </p>
          </div>
        ) : approval ? (
          <div className="border-t-2 border-foreground px-4 py-4">
            <MonoTag>decision record</MonoTag>
            <p className="mt-1.5 text-sm">
              <span className="font-bold">
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
              <p className="mt-1 border-l-2 border-foreground pl-3 text-sm text-muted-foreground">
                {approval.decisionNote}
              </p>
            ) : null}
            {output.publishedAt ? (
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                published to the drive · {formatRelative(output.publishedAt)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
