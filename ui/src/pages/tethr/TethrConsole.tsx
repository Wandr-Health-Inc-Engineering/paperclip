import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, Inbox, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RouteFlow } from "@/components/tethr/RouteFlow";
import {
  MonoTag,
  OutputStatusBadge,
  formatRelative,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrRouteResult,
  type TethrRouteRun,
} from "@/api/tethr";

// The hero screen. Type a request, watch Helm classify it and route it down
// the chain to the right subagent, then see the result land — gated work
// goes to the Queue, safe work publishes to the Drive.

const SUGGESTIONS = [
  "Any travel health news today?",
  "Write a blog post on malaria prophylaxis timing",
  "Can we afford to spend more on the Peru campaign?",
  "Draft a reply to a Reddit thread about typhoid shots",
  "How are ads doing against our guardrails?",
];

export function TethrConsole() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState("");
  const [active, setActive] = useState<{
    request: string;
    result: TethrRouteResult | null;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Console" }]);
  }, [setBreadcrumbs]);

  const { data: history } = useQuery({
    queryKey: tethrKeys.routeRuns(selectedCompanyId!),
    queryFn: () => tethrApi.routeRuns(selectedCompanyId!, 20),
    enabled: !!selectedCompanyId,
  });

  const routeMutation = useMutation({
    mutationFn: (text: string) => tethrApi.route(selectedCompanyId!, text),
    onSuccess: (result) => {
      setActive((prev) => (prev ? { ...prev, result } : prev));
      queryClient.invalidateQueries({ queryKey: tethrKeys.routeRuns(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["tethr", selectedCompanyId, "outputs"] });
    },
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || routeMutation.isPending) return;
    setActive({ request: trimmed, result: null });
    setRequest("");
    routeMutation.mutate(trimmed);
  };

  const replay = (run: TethrRouteRun) => {
    setActive({
      request: run.requestText,
      result: {
        routeRunId: run.id,
        status: run.status,
        hops: run.hops,
        resultText: run.resultText ?? run.error ?? "",
        outputs: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        llmProvider: run.llmProvider ?? "mock",
        durationMs: run.durationMs ?? 0,
      },
    });
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Send} message="Select a company to open the console." />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Hero input */}
      <div className="space-y-4 pt-2">
        <div>
          <MonoTag className="text-foreground">● tethr · console</MonoTag>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight md:text-4xl">
            ask the company
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Helm reads every request, picks the right agent, and the agent picks the
            specialist. Gated work stops in the Queue before it ships.
          </p>
        </div>

        <div className="border-2 border-foreground bg-card">
          <textarea
            ref={inputRef}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(request);
              }
            }}
            rows={2}
            placeholder="Helm, can we afford to spend more on Peru?"
            className="w-full resize-none bg-transparent px-4 py-3 text-base font-semibold outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              enter to route · shift+enter for newline
            </span>
            <Button
              size="sm"
              onClick={() => submit(request)}
              disabled={!request.trim() || routeMutation.isPending}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Route it
            </Button>
          </div>
        </div>

        {!active ? (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => submit(s)}
                className="border border-dashed border-foreground/50 px-3 py-1.5 text-left font-mono text-[11px] font-semibold text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Active route */}
      {active ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
          <div className="border-2 border-foreground bg-card p-5">
            <MonoTag>routing</MonoTag>
            <div className="mt-4">
              <RouteFlow
                request={active.request}
                hops={active.result?.hops ?? []}
                pending={!active.result}
              />
            </div>
          </div>

          <div className="space-y-4">
            {active.result ? (
              <div
                className="tethr-result-animate border-2 border-foreground bg-card p-5"
                style={{
                  animationDelay: `${200 + active.result.hops.length * 240}ms`,
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <MonoTag className="text-foreground">result</MonoTag>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {active.result.llmProvider} ·{" "}
                    {active.result.durationMs ? `${active.result.durationMs}ms` : "replay"}
                  </span>
                </div>
                <div className="mt-3">
                  <MarkdownBody className="text-sm leading-relaxed">
                    {active.result.resultText || "No result text."}
                  </MarkdownBody>
                </div>
                {active.result.outputs.length > 0 ? (
                  <div className="mt-4 space-y-2 border-t border-border pt-3">
                    {active.result.outputs.map((o) => (
                      <Link
                        key={o.outputId}
                        to={`/queue/${o.outputId}`}
                        className="group flex items-center justify-between gap-3 border border-border px-3 py-2 transition-colors hover:border-foreground"
                      >
                        <span className="min-w-0 truncate text-sm font-semibold">
                          {o.title}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <OutputStatusBadge status={o.status} />
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : null}
                {active.result.status === "gated" ? (
                  <div className="mt-3 flex items-center gap-2 bg-secondary px-3 py-2">
                    <Inbox className="h-3.5 w-3.5" />
                    <p className="text-xs font-semibold">
                      Output is gated. Nothing ships until a human approves it in the Queue.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="border-2 border-dashed border-foreground/30 p-5">
                <span className="shimmer-text text-sm font-semibold">
                  working the chain…
                </span>
              </div>
            )}
            {routeMutation.isError ? (
              <p className="text-sm text-destructive">
                {(routeMutation.error as Error).message}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* History */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>recent requests</MonoTag>
        </div>
        {history?.length ? (
          <div className="grid gap-2" data-tethr-stagger>
            {history.map((run) => (
              <button
                key={run.id}
                onClick={() => replay(run)}
                className={cn(
                  "flex min-w-0 items-center justify-between gap-3 overflow-hidden border border-border px-3 py-2.5 text-left transition-colors hover:border-foreground",
                  active?.result?.routeRunId === run.id && "border-foreground",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {run.requestText}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {run.hops.length > 0
                      ? run.hops[run.hops.length - 1]?.actorTag
                      : "unrouted"}{" "}
                    · {run.invocationSource} · {formatRelative(run.createdAt)}
                  </span>
                </span>
                <OutputStatusBadge
                  status={
                    run.status === "done"
                      ? "published"
                      : run.status === "gated"
                        ? "gated"
                        : run.status
                  }
                  className="shrink-0"
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing routed yet. The crew is waiting.
          </p>
        )}
      </div>
    </div>
  );
}
