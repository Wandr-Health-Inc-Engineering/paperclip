import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileText,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  Plus,
  Send,
  Wrench,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RouteFlow } from "@/components/tethr/RouteFlow";
import { CogDuo, OutputStatusBadge, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link, useSearchParams } from "../../lib/router";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrChatOutput,
  type TethrChatRun,
  type TethrRouteHop,
  type TethrSideChat,
} from "@/api/tethr";

// The Console as a chat (phase 17, Mark's model): one ONGOING main chat with
// @tethr that everything goes into by default, plus SIDE chats he opens on
// purpose for a focused task or side project. Each message routes through the
// same engine as before; the reply shows which agents handled it (expandable
// to the full route), the answer, anything filed, and an inline approval card
// for gated work (same gate as the Queue).
//
// URL: /console = main chat · ?chat=<threadId> = a side chat · ?chat=new = a
// side chat being started (it gets its thread on the first message).

const TERMINAL = new Set(["done", "gated", "failed"]);
const DECIDABLE = new Set(["gated", "changes_requested"]);
const PAGE = 40;

const SUGGESTIONS = [
  "What's on the plate today?",
  "Any travel health news worth acting on?",
  "Plan a spring-break malaria push",
  "How are we tracking against budget?",
];

export function TethrConsole() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [limit, setLimit] = useState(PAGE);
  const [pending, setPending] = useState<{ text: string; threadId: string | null; runId?: string } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    setBreadcrumbs([{ label: "Console" }]);
  }, [setBreadcrumbs]);

  // Older links (?run=&thread=) from before the chat: just land on the main chat.
  useEffect(() => {
    if (searchParams.get("run") || searchParams.get("thread")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const c = selectedCompanyId ?? "";
  const { data: chats } = useQuery({
    queryKey: tethrKeys.chats(c),
    queryFn: () => tethrApi.chats(c),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });

  const mainThreadId = chats?.mainThreadId ?? c;
  const chatParam = searchParams.get("chat");
  const isDraft = chatParam === "new";
  const threadId = isDraft ? null : chatParam || mainThreadId;
  const isMain = !isDraft && threadId === mainThreadId;
  const sideChat = !isMain && threadId ? chats?.sideChats.find((s) => s.threadId === threadId) : undefined;

  const openChat = (next: string | null) => {
    setLimit(PAGE);
    setSendError(null);
    stickToBottom.current = true;
    setSearchParams(next ? { chat: next } : {});
  };

  const { data: runs, isLoading } = useQuery({
    queryKey: tethrKeys.chatRuns(c, threadId ?? "none"),
    queryFn: () => tethrApi.chatRuns(c, threadId!, limit),
    enabled: !!selectedCompanyId && !!threadId,
    refetchInterval: (q) => (q.state.data?.some((r) => !TERMINAL.has(r.status)) || pending ? 800 : 15_000),
  });

  // Drop the optimistic bubble once its run shows up in the thread.
  useEffect(() => {
    if (pending?.runId && runs?.some((r) => r.id === pending.runId)) setPending(null);
  }, [runs, pending]);

  // When a run lands, refresh the surfaces it may have touched (Queue, list counts).
  const settled = useRef(new Set<string>());
  useEffect(() => {
    for (const r of runs ?? []) {
      if (TERMINAL.has(r.status) && !settled.current.has(r.id)) {
        if (settled.current.size) {
          queryClient.invalidateQueries({ queryKey: ["tethr", c, "outputs"] });
          queryClient.invalidateQueries({ queryKey: tethrKeys.chats(c) });
        }
        settled.current.add(r.id);
      }
    }
  }, [runs, c, queryClient]);

  const send = useMutation({
    mutationFn: async (text: string) => {
      if (isDraft) {
        const res = await tethrApi.openSideChat(c, text);
        return { ...res, opened: true };
      }
      const res = await tethrApi.route(c, text, threadId);
      return { ...res, opened: false };
    },
    onMutate: (text) => {
      setSendError(null);
      stickToBottom.current = true;
      setPending({ text, threadId });
    },
    onSuccess: (res, text) => {
      setPending({ text, threadId: res.threadId, runId: res.routeRunId });
      if (res.opened) {
        queryClient.invalidateQueries({ queryKey: tethrKeys.chats(c) });
        setSearchParams({ chat: res.threadId });
      }
      queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(c, res.threadId) });
    },
    onError: (e) => {
      setPending(null);
      setSendError(e instanceof Error ? e.message : "Couldn't reach tethr.");
    },
  });

  const removeChat = useMutation({
    mutationFn: (id: string) => tethrApi.removeSideChat(c, id),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.chats(c) });
      if (id === threadId) openChat(null);
    },
  });

  // Follow the conversation down while the reader is at the bottom.
  const last = runs?.[runs.length - 1];
  const tick = `${threadId}|${runs?.length ?? 0}|${last?.status}|${last?.hops.length}|${pending?.text ?? ""}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tick]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Send} message="Select a company to open the console." />;
  }

  const visibleRuns = runs ?? [];
  const showPending = pending && (pending.threadId === threadId || (isDraft && !pending.threadId));
  const empty = !isLoading && !visibleRuns.length && !showPending;

  return (
    <div className="relative flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col md:h-[calc(100dvh-6rem)]">
      <ChatSwitcher
        isMain={isMain}
        isDraft={isDraft}
        title={isMain ? "tethr" : isDraft ? "New side chat" : (sideChat?.title ?? "Side chat")}
        running={visibleRuns.some((r) => !TERMINAL.has(r.status))}
        mainLastAt={chats?.main.lastAt ?? null}
        sideChats={chats?.sideChats ?? []}
        activeThreadId={threadId}
        onOpenMain={() => openChat(null)}
        onOpenSide={(id) => openChat(id)}
        onNewSide={() => openChat("new")}
        onRemoveSide={(id) => removeChat.mutate(id)}
      />

      {/* One area: the conversation sits on the page, under the floating bar. */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent_0,#000_44px,#000_calc(100%-14px),transparent_100%)]"
      >
        {empty ? (
          <ChatEmpty isDraft={isDraft} onPick={(s) => send.mutate(s)} />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-4 pb-6 pt-16 md:px-6">
            {visibleRuns.length >= limit && limit < 100 ? (
              <button
                type="button"
                onClick={() => {
                  stickToBottom.current = false;
                  setLimit(100);
                }}
                className="tethr-btn tethr-btn-ghost mx-auto h-8 px-3.5 text-[12.5px]"
              >
                Load earlier messages
              </button>
            ) : null}
            {isLoading ? <p className="text-center font-mono text-[11px] tethr-text-3">Loading…</p> : null}
            {visibleRuns.map((run) => (
              <Turn key={run.id} run={run} companyId={c} />
            ))}
            {showPending && !visibleRuns.some((r) => r.id === pending?.runId) ? (
              <div className="flex flex-col gap-4">
                <UserBubble text={pending!.text} />
                <Working label="sending…" />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Composer
        key={threadId ?? "draft"}
        placeholder={isDraft ? "What's this side chat about?" : isMain ? "Message tethr…" : "Message this side chat…"}
        hint={isMain ? "Everything goes to your ongoing chat with tethr." : undefined}
        busy={send.isPending}
        error={sendError}
        onSend={(text) => send.mutate(text)}
      />
    </div>
  );
}

// ---- floating chat bar ----------------------------------------------------------

/** A glass pill floating over the conversation: shows which chat you're in;
 * click it for the main chat and your side chats; + starts a new side chat. */
function ChatSwitcher({
  isMain,
  isDraft,
  title,
  running,
  mainLastAt,
  sideChats,
  activeThreadId,
  onOpenMain,
  onOpenSide,
  onNewSide,
  onRemoveSide,
}: {
  isMain: boolean;
  isDraft: boolean;
  title: string;
  running: boolean;
  mainLastAt: string | null;
  sideChats: TethrSideChat[];
  activeThreadId: string | null;
  onOpenMain: () => void;
  onOpenSide: (threadId: string) => void;
  onNewSide: () => void;
  onRemoveSide: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1 z-20 flex justify-center px-3">
      <div className="tethr-glass pointer-events-auto flex max-w-full items-center gap-0.5 rounded-full p-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Switch chat"
              className="flex h-8 min-w-0 items-center gap-2 rounded-full pl-1 pr-2.5 transition-colors hover:bg-[var(--tethr-select-blur)]"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                {isMain ? <MessagesSquare className="h-3 w-3" /> : <MessageSquarePlus className="h-3 w-3" />}
              </span>
              <span className="min-w-0 max-w-[44vw] truncate text-[13px] font-medium md:max-w-[340px]">{title}</span>
              {running ? <StatusDot tone="live" /> : null}
              <span className="hidden shrink-0 font-mono text-[9.5px] uppercase tracking-[0.16em] tethr-text-3 sm:inline">
                {isMain ? "main chat" : isDraft ? "new" : "side chat"}
              </span>
              {sideChats.length ? (
                <span className="shrink-0 rounded-full bg-[var(--tethr-select-blur)] px-1.5 font-mono text-[10px] leading-4">
                  {sideChats.length}
                </span>
              ) : null}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 tethr-text-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="center" sideOffset={8} className="w-[min(340px,calc(100vw-2rem))] p-1.5">
            <button
              type="button"
              onClick={() => pick(onOpenMain)}
              className={cn(
                "flex w-full items-center gap-3 rounded-[10px] px-2 py-2 text-left transition-colors",
                isMain ? "bg-[var(--tethr-select-blur)]" : "hover:bg-[var(--tethr-select-blur)]",
              )}
            >
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-primary text-primary-foreground">
                <MessagesSquare className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">tethr</span>
                <span className="block truncate text-[11.5px] text-muted-foreground">
                  {mainLastAt ? `main chat · ${formatRelative(mainLastAt)}` : "main chat · ongoing"}
                </span>
              </span>
            </button>

            <p className="tethr-eyebrow px-2 pb-1 pt-3">side chats</p>
            {sideChats.map((s) => (
              <div
                key={s.threadId}
                className={cn(
                  "group flex items-center rounded-[10px] transition-colors",
                  s.threadId === activeThreadId ? "bg-[var(--tethr-select-blur)]" : "hover:bg-[var(--tethr-select-blur)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => pick(() => onOpenSide(s.threadId))}
                  title={s.title}
                  className="min-w-0 flex-1 px-2 py-1.5 text-left"
                >
                  <span className="block truncate text-[13px]">{s.title}</span>
                  <span className="block text-[11px] tethr-text-3">{formatRelative(s.lastAt)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveSide(s.threadId)}
                  title="Close side chat (its history stays in Activity)"
                  aria-label={`Close ${s.title}`}
                  className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-full tethr-text-3 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {!sideChats.length ? (
              <p className="px-2 pb-1 text-[12px] leading-snug tethr-text-3">
                None yet. Open one for a focused task or side project; it stays out of your main chat.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => pick(onNewSide)}
              className="mt-1.5 flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-[13px] transition-colors hover:bg-[var(--tethr-select-blur)]"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              New side chat
            </button>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={onNewSide}
          title="New side chat"
          aria-label="New side chat"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---- messages --------------------------------------------------------------------

function ChatEmpty({ isDraft, onPick }: { isDraft: boolean; onPick: (text: string) => void }) {
  return (
    <div className="tethr-reeds flex h-full flex-col items-center justify-center gap-5 px-6 pt-12 text-center">
      <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-primary text-primary-foreground">
        {isDraft ? <MessageSquarePlus className="h-5 w-5" /> : <MessagesSquare className="h-5 w-5" />}
      </span>
      <div className="space-y-2">
        <h2 className="tethr-display text-[28px] md:text-[32px]">
          {isDraft ? "A new side chat" : "What should we work on?"}
        </h2>
        <p className="mx-auto max-w-[46ch] text-[13.5px] text-muted-foreground">
          {isDraft
            ? "Start with what this chat is about. It stays separate from your main chat with tethr."
            : "This is your ongoing chat with tethr. Ask anything; it routes the work to the right agent."}
        </p>
      </div>
      {!isDraft ? (
        <div className="flex max-w-xl flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="tethr-btn tethr-btn-glass h-8 px-3.5 text-[12.5px] font-normal"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UserBubble({ text, at }: { text: string; at?: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-[var(--tethr-frost-strong)] px-4 py-2.5 text-[14px] leading-relaxed shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)] [overflow-wrap:anywhere]">
        {text}
      </div>
      {at ? <span className="font-mono text-[10.5px] tethr-text-3">{formatRelative(at)}</span> : null}
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 text-[13px]">
      <CogDuo className="h-5 w-5 text-muted-foreground" />
      <span className="shimmer-text font-medium">{label}</span>
    </div>
  );
}

function Turn({ run, companyId }: { run: TethrChatRun; companyId: string }) {
  const [showRoute, setShowRoute] = useState(false);
  const running = !TERMINAL.has(run.status);
  const lastHop = run.hops[run.hops.length - 1];
  const filed = run.outputs.filter((o) => o.kind !== "answer");
  const gated = filed.filter((o) => DECIDABLE.has(o.status));
  const other = filed.filter((o) => !DECIDABLE.has(o.status));

  return (
    <div className="flex flex-col gap-4">
      <UserBubble text={run.requestText} at={run.createdAt} />

      <div className="flex flex-col gap-3">
        {/* Who handled it: a compact route, expandable to the full chain. */}
        {run.hops.length ? (
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <button
              type="button"
              onClick={() => setShowRoute((v) => !v)}
              aria-expanded={showRoute}
              className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-full text-left"
              title={showRoute ? "Hide the route" : "Show every step"}
            >
              {showRoute ? (
                <ChevronDown className="h-3.5 w-3.5 tethr-text-3" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 tethr-text-3" />
              )}
              <HopChips hops={run.hops} />
            </button>
            <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] tethr-text-3">
              <StatusDot
                tone={
                  running
                    ? "live"
                    : run.status === "failed"
                      ? "bad"
                      : run.status === "gated"
                        ? "warn"
                        : "ok"
                }
              />
              {running
                ? "working"
                : run.status === "gated"
                  ? "waiting on you"
                  : run.status === "failed"
                    ? "failed"
                    : "done"}
              {!running && run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}
            </span>
          </div>
        ) : null}
        {showRoute ? (
          <div className="tethr-inset px-4 py-3">
            <RouteFlow request={run.requestText} hops={run.hops} animate={false} />
          </div>
        ) : null}

        {running ? (
          <Working label={lastHop ? `${lastHop.actorTag} is working…` : "tethr is reading your message…"} />
        ) : run.status === "failed" ? (
          <p className="text-[14px] text-[var(--tethr-bad)]">{run.error || run.resultText || "This one failed."}</p>
        ) : run.resultText ? (
          <MarkdownBody className="text-[14px] leading-relaxed">{run.resultText}</MarkdownBody>
        ) : null}

        {gated.map((o) => (
          <ApprovalCard key={o.id} output={o} companyId={companyId} threadId={run.threadId ?? ""} />
        ))}
        {other.length ? (
          <div className="flex flex-col gap-1.5">
            {other.map((o) => (
              <Link
                key={o.id}
                to={`/queue/${o.id}`}
                className="tethr-panel tethr-panel-hover group flex min-w-0 items-center gap-3 rounded-[12px] px-3 py-2"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{o.title}</span>
                <span className="hidden shrink-0 text-[11.5px] text-muted-foreground sm:inline">{kindLabel(o.kind)}</span>
                <OutputStatusBadge status={o.status} className="shrink-0" />
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const LAYER_LABEL: Record<TethrRouteHop["layer"], string> = {
  helm: "router",
  agent: "route",
  subagent: "do",
  tool: "tool",
};

/** The route as chips: @tethr router — @rank route — @rank.keywords do. Tool hops fold into a count. */
function HopChips({ hops }: { hops: TethrRouteHop[] }) {
  const people = hops.filter((h) => h.layer !== "tool");
  const tools = hops.length - people.length;
  return (
    <>
      {people.map((hop, i) => (
        <span key={`${i}-${hop.actorTag}`} className="flex items-center gap-1.5">
          {i > 0 ? <span className="h-px w-3 bg-[var(--tethr-rim-strong)]" /> : null}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--tethr-frost)] py-0.5 pl-2.5 pr-2 text-[12px] shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
            <span className="font-mono">{hop.actorTag}</span>
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] tethr-text-3">{LAYER_LABEL[hop.layer]}</span>
          </span>
        </span>
      ))}
      {tools ? (
        <span className="inline-flex items-center gap-1 font-mono text-[10.5px] tethr-text-3">
          <Wrench className="h-3 w-3" />
          {tools} {tools === 1 ? "tool" : "tools"}
        </span>
      ) : null}
    </>
  );
}

/** A gated output, decided right here. Same endpoint and gate as the Queue. */
function ApprovalCard({ output, companyId, threadId }: { output: TethrChatOutput; companyId: string; threadId: string }) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => tethrApi.decide(companyId, output.id, decision),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, threadId) });
      queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "outputs"] });
      queryClient.invalidateQueries({ queryKey: tethrKeys.chats(companyId) });
    },
  });
  const snippet = useMemo(() => previewText(output.body), [output.body]);
  return (
    <div className="tethr-glass flex max-w-2xl flex-col gap-2.5 p-4">
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <Lock className="h-3 w-3" />
        {output.status === "changes_requested" ? "changes requested" : "awaiting review"} · {kindLabel(output.kind)} ·{" "}
        {output.sensitivity}
      </span>
      <p className="text-[14.5px] font-medium leading-snug">{output.title}</p>
      {snippet ? <p className="line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{snippet}</p> : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => decide.mutate("approve")}
          className="tethr-btn tethr-btn-primary h-8 px-4 text-[12.5px]"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => decide.mutate("reject")}
          className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]"
        >
          Reject
        </button>
        <Link
          to={`/queue/${output.id}`}
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          Open in Queue
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {decide.isError ? (
        <p className="text-[12px] text-[var(--tethr-bad)]">
          {decide.error instanceof Error ? decide.error.message : "That didn't go through."}
        </p>
      ) : null}
    </div>
  );
}

// ---- composer --------------------------------------------------------------------

function Composer({
  placeholder,
  hint,
  busy,
  error,
  onSend,
}: {
  placeholder: string;
  hint?: string;
  busy: boolean;
  error: string | null;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  // Grow with the text, up to ~8 lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 md:px-6 md:pb-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="tethr-glass flex items-end gap-2 rounded-[22px] py-1.5 pl-4 pr-1.5">
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            aria-label="Message"
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14.5px] leading-relaxed outline-none placeholder:text-[var(--tethr-text-3)]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || busy}
            aria-label="Send"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 px-2">
          <span className="truncate text-[11.5px] tethr-text-3">
            {error ? <span className="text-[var(--tethr-bad)]">{error}</span> : hint}
          </span>
          <span className="hidden shrink-0 font-mono text-[10.5px] tethr-text-3 sm:inline">
            enter to send · shift+enter for a new line
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- helpers -----------------------------------------------------------------------

function kindLabel(kind: string): string {
  const k = kind.replace(/_/g, " ");
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/** A plain-text taste of a body: front matter and Markdown marks stripped. */
function previewText(body: string): string {
  return body
    .replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "")
    .replace(/[#>*_`|[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}
