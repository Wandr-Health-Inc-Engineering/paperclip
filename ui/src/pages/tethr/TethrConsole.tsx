import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, History, Inbox, MessageSquarePlus, Send } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RouteFlow } from "@/components/tethr/RouteFlow";
import {
  CogDuo,
  MonoTag,
  OutputStatusBadge,
  StatusDot,
  formatRelative,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link, useSearchParams } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrRouteRun } from "@/api/tethr";

// The hero screen. Type a request and watch it travel the chain LIVE: Helm
// classifies (or plans a multi-agent sequence), the agent routes, the
// subagent works its tools, and the result lands — gated work stops in the
// Queue. Follow-ups continue the same thread.

const SUGGESTIONS = [
  "Any travel health news today?",
  "Write a blog post on malaria prophylaxis timing",
  "Launch a Peru campaign for the spring season",
  "Draft a reply to a Reddit thread about typhoid shots",
  "Can we afford to spend more on the Peru campaign?",
];

const TERMINAL_STATUSES = new Set(["done", "gated", "failed"]);

export function TethrConsole() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [request, setRequest] = useState("");
  const [active, setActive] = useState<{
    request: string;
    runId: string;
    live: boolean;
  } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    setBreadcrumbs([{ label: "Console" }]);
  }, [setBreadcrumbs]);

  // Opened from a notification's "Ask Tethr to handle this" — pick up the run
  // that was just dispatched and show it live, then clear the params.
  useEffect(() => {
    const runParam = searchParams.get("run");
    if (!runParam) return;
    setActive({ request: searchParams.get("q") ?? "", runId: runParam, live: true });
    const thread = searchParams.get("thread");
    if (thread) setThreadId(thread);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const { data: history } = useQuery({
    queryKey: tethrKeys.routeRuns(selectedCompanyId!),
    queryFn: () => tethrApi.routeRuns(selectedCompanyId!, 20),
    enabled: !!selectedCompanyId,
  });

  const { data: run } = useQuery({
    queryKey: tethrKeys.routeRun(selectedCompanyId!, active?.runId ?? ""),
    queryFn: () => tethrApi.routeRun(selectedCompanyId!, active!.runId),
    enabled: !!selectedCompanyId && !!active?.runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && TERMINAL_STATUSES.has(status) ? false : 600;
    },
  });
  const terminal = run ? TERMINAL_STATUSES.has(run.status) : false;

  // When a live run lands, refresh history + queue surfaces once.
  const settledRef = useRef<string | null>(null);
  useEffect(() => {
    if (run && terminal && active?.live && settledRef.current !== run.id) {
      settledRef.current = run.id;
      queryClient.invalidateQueries({ queryKey: tethrKeys.routeRuns(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: ["tethr", selectedCompanyId, "outputs"] });
    }
  }, [run, terminal, active?.live, queryClient, selectedCompanyId]);

  const routeMutation = useMutation({
    mutationFn: (text: string) => tethrApi.route(selectedCompanyId!, text, threadId),
    onSuccess: (ids, text) => {
      setActive({ request: text, runId: ids.routeRunId, live: true });
      setThreadId(ids.threadId);
    },
  });

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || routeMutation.isPending) return;
    setRequest("");
    routeMutation.mutate(trimmed);
  };

  const replay = (historyRun: TethrRouteRun) => {
    setActive({ request: historyRun.requestText, runId: historyRun.id, live: false });
    setThreadId(historyRun.threadId ?? historyRun.id);
  };

  const newThread = () => {
    setThreadId(null);
    setActive(null);
    inputRef.current?.focus();
  };

  if (!selectedCompanyId) {
    return <EmptyState icon={Send} message="Select a company to open the console." />;
  }

  const outputs = run?.outputs ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Hero input — sits on the reeded light (the Aina streaks). */}
      <div className="tethr-reeds -mx-4 space-y-5 rounded-[20px] px-4 pb-4 pt-2 md:-mx-6 md:px-6">
        {threadId ? (
          <div className="flex justify-end">
            <button type="button" className="tethr-btn tethr-btn-glass h-8 shrink-0 px-3.5 text-[13px]" onClick={newThread}>
              <MessageSquarePlus className="h-3.5 w-3.5" />
              New thread
            </button>
          </div>
        ) : null}

        <div className="tethr-glass rounded-[18px]">
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
            placeholder={
              threadId
                ? "Follow up in this thread…"
                : "Tethr, how did our ads do last month?"
            }
            className="w-full resize-none bg-transparent px-5 pb-2 pt-4 text-base outline-none placeholder:text-[var(--tethr-text-3)]"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-1">
            <span className="tethr-eyebrow">
              {threadId ? "continuing thread · " : ""}enter to route · shift+enter for newline
            </span>
            <button
              type="button"
              className="tethr-btn tethr-btn-primary h-9 px-4 text-[13px]"
              onClick={() => submit(request)}
              disabled={!request.trim() || routeMutation.isPending}
            >
              <Send className="h-3.5 w-3.5" />
              Route it
            </button>
          </div>
        </div>

        {!active ? (
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => submit(s)}
                className="tethr-btn tethr-btn-glass h-8 px-3.5 text-left text-[12.5px] font-normal text-muted-foreground hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {routeMutation.isError ? (
          <p className="text-sm text-destructive">
            {(routeMutation.error as Error).message}
          </p>
        ) : null}
      </div>

      {/* Active route */}
      {active ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
          <div className="tethr-panel p-5">
            <div className="flex items-center justify-between">
              <MonoTag>{active.live && !terminal ? "routing · live" : "routing"}</MonoTag>
              {active.live && !terminal ? <StatusDot tone="live" title="live" /> : null}
            </div>
            <div className="mt-4">
              <RouteFlow
                request={active.request}
                hops={run?.hops ?? []}
                pending={active.live && !terminal}
                live={active.live}
              />
            </div>
          </div>

          <div className="space-y-4">
            {run && terminal ? (
              <div
                className="tethr-result-animate tethr-panel p-5"
                style={{ animationDelay: active.live ? "0ms" : `${200 + (run.hops.length || 1) * 240}ms` }}
              >
                <div className="flex items-center justify-between gap-2">
                  <MonoTag className="inline-flex items-center gap-2">
                    <StatusDot status={run.status === "done" ? "done" : run.status} />
                    result
                  </MonoTag>
                  <span className="font-mono text-[10.5px] text-[var(--tethr-text-3)]">
                    {run.llmProvider} ·{" "}
                    {run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : "replay"}
                  </span>
                </div>
                <div className="mt-3">
                  <MarkdownBody className="text-sm leading-relaxed">
                    {run.resultText || run.error || "No result text."}
                  </MarkdownBody>
                </div>
                {outputs.length > 0 ? (
                  <div className="tethr-rule mt-4 space-y-2 border-t pt-3">
                    {outputs.map((o) => (
                      <Link
                        key={o.id}
                        to={`/queue/${o.id}`}
                        className="tethr-panel tethr-panel-hover group flex min-w-0 items-center justify-between gap-3 rounded-[10px] px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
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
                {run.status === "gated" ? (
                  <div className="tethr-inset mt-3 flex items-center gap-2 px-3 py-2">
                    <StatusDot tone="warn" />
                    <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="text-xs font-medium">
                      Output is gated. Nothing ships until a human approves it in the Queue.
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="tethr-empty flex items-center gap-3 p-5">
                <CogDuo className="h-6 w-6" />
                <span className="shimmer-text text-sm font-medium">
                  {run?.hops.length
                    ? `${run.hops[run.hops.length - 1].actorTag} is working…`
                    : "working the chain…"}
                </span>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* History */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <History className="h-3.5 w-3.5 text-[var(--tethr-text-3)]" />
          <MonoTag>recent requests</MonoTag>
        </div>
        {history?.length ? (
          <div className="grid gap-2" data-tethr-stagger>
            {history.map((historyRun) => (
              <button
                key={historyRun.id}
                onClick={() => replay(historyRun)}
                className={cn(
                  "tethr-panel tethr-panel-hover flex min-w-0 items-center justify-between gap-3 overflow-hidden px-4 py-3 text-left",
                  active?.runId === historyRun.id && "tethr-panel-active",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {historyRun.requestText}
                  </span>
                  <span className="tethr-eyebrow mt-1 block truncate text-[9.5px] tracking-[0.14em]">
                    {historyRun.hops.length > 0
                      ? historyRun.hops[historyRun.hops.length - 1]?.actorTag
                      : "unrouted"}{" "}
                    · {historyRun.invocationSource} · {formatRelative(historyRun.createdAt)}
                  </span>
                </span>
                <OutputStatusBadge
                  status={
                    historyRun.status === "done"
                      ? "published"
                      : historyRun.status === "gated"
                        ? "gated"
                        : historyRun.status
                  }
                  className="shrink-0"
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="tethr-empty px-4 py-8 text-center text-sm">
            Nothing routed yet. The crew is waiting.
          </p>
        )}
      </div>
    </div>
  );
}
