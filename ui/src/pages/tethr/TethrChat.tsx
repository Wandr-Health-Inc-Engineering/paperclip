import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  FileImage,
  FileText,
  Lightbulb,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RouteFlow } from "@/components/tethr/RouteFlow";
import { CHIP_HOVER, CHIP_SURFACE } from "@/components/tethr/Chip";
import { OutputPanel, type PanelFile } from "@/components/tethr/OutputPanel";
import { TethrSetupNudge } from "@/components/tethr/SetupNavItem";
import { Nebula } from "@/components/tethr/Nebula";
import { OutputStatusBadge, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link, useSearchParams } from "../../lib/router";
import { cn } from "@/lib/utils";
import { formatBytes } from "./drive/filePreview";
import {
  refreshAfterDecision,
  tethrApi,
  tethrKeys,
  type TethrChatAttachment,
  type TethrChatOutput,
  type TethrChatRun,
  type TethrRouteHop,
  type TethrSideChat,
} from "@/api/tethr";

// Chat (phase 17, formerly the Console; Mark's model): one ONGOING chat with
// @tethr that everything goes into by default, plus SIDE chats he opens on
// purpose for a focused task or side project. Since phase 18 each thread runs
// as ONE Claude Code session with Mark's connectors (SessionTurn: live activity
// rows, streaming answer, Stop); older turns from the multi-agent engine keep
// their route view (Turn). Gated outputs show as inline approval cards (same
// gate as the Queue).
//
// URL: /chat = the ongoing chat · ?chat=<threadId> = a side chat · ?chat=new =
// a side chat being started (it gets its thread on the first message). The old
// /console route redirects here.

const TERMINAL = new Set(["done", "gated", "failed", "stopped"]);
const DECIDABLE = new Set(["gated", "changes_requested"]);
const PAGE = 40;

const SUGGESTIONS = [
  "What's on the plate today?",
  "Any travel health news worth acting on?",
  "Plan a spring-break malaria push",
  "How are we tracking against budget?",
];

export function TethrChat() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [limit, setLimit] = useState(PAGE);
  const [pending, setPending] = useState<{
    text: string;
    attachments: TethrChatAttachment[];
    threadId: string | null;
    runId?: string;
  } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [panelPath, setPanelPath] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
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
    setPanelPath(null);
    setSendError(null);
    stickToBottom.current = true;
    setSearchParams(next ? { chat: next } : {});
  };

  const { data: runs, isLoading } = useQuery({
    queryKey: tethrKeys.chatRuns(c, threadId ?? "none"),
    queryFn: () => tethrApi.chatRuns(c, threadId!, limit),
    enabled: !!selectedCompanyId && !!threadId,
    refetchInterval: (q) => (q.state.data?.some((r) => !TERMINAL.has(r.status)) || pending ? 500 : 15_000),
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
    mutationFn: async ({ text, attachments }: Outgoing) => {
      const paths = attachments.map((a) => a.path);
      if (isDraft) {
        const res = await tethrApi.openSideChat(c, text, paths);
        return { ...res, opened: true };
      }
      const res = await tethrApi.sendChatMessage(c, threadId!, text, paths);
      return { ...res, opened: false };
    },
    onMutate: ({ text, attachments }) => {
      setSendError(null);
      stickToBottom.current = true;
      setPending({ text, attachments, threadId });
    },
    onSuccess: (res, { text, attachments }) => {
      setPending({ text, attachments, threadId: res.threadId, runId: res.routeRunId });
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

  // "Start over": a fresh Claude session for this thread (messages and
  // Memory.md stay). Also lifts the web-page approvals a session that has read
  // your tools gets.
  const [resetNote, setResetNote] = useState(false);
  const resetSession = useMutation({
    mutationFn: () => tethrApi.resetChatSession(c, threadId!),
    onSuccess: () => {
      setResetNote(true);
      window.setTimeout(() => setResetNote(false), 4000);
    },
  });

  const removeChat = useMutation({
    mutationFn: (id: string) => tethrApi.removeSideChat(c, id),
    onSuccess: (_r, id) => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.chats(c) });
      if (id === threadId) openChat(null);
    },
  });

  // Files Tethr wrote in this thread (newest edit wins the version), for the
  // side panel. A file that lands while you watch opens itself; Memory.md
  // edits only show as a chip.
  const threadFiles = useMemo(() => panelFilesOf(runs ?? []), [runs]);
  const seenFiles = useRef<Map<string, string> | null>(null);
  const liveRuns = useRef<Set<string>>(new Set());
  useEffect(() => {
    seenFiles.current = null;
    liveRuns.current = new Set();
  }, [threadId]);
  useEffect(() => {
    if (!runs) return;
    const prev = seenFiles.current;
    const wasLive = liveRuns.current;
    seenFiles.current = new Map(threadFiles.map((f) => [f.path, f.version]));
    liveRuns.current = new Set(runs.filter((r) => !TERMINAL.has(r.status)).map((r) => r.id));
    if (!prev) return; // first load of this thread: nothing pops open
    // Only a turn you watched working opens the panel (not older turns that
    // "Load earlier messages" brings in).
    const fresh = threadFiles.filter((f) => {
      const runId = f.version.split(":")[0];
      return prev.get(f.path) !== f.version && !isMemoryFile(f.path) && (wasLive.has(runId) || liveRuns.current.has(runId));
    });
    if (fresh.length) setPanelPath(fresh[fresh.length - 1].path);
  }, [threadFiles, runs]);
  const panelFile = panelPath ? (threadFiles.find((f) => f.path === panelPath) ?? { path: panelPath, version: "" }) : null;

  // Follow the conversation down while the reader is at the bottom.
  const last = runs?.[runs.length - 1];
  const tick = `${threadId}|${runs?.length ?? 0}|${last?.status}|${last?.hops.length}|${last?.resultText?.length ?? 0}|${pending?.text ?? ""}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [tick]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Send} message="Select a company to open the chat." />;
  }

  const visibleRuns = runs ?? [];
  const showPending = pending && (pending.threadId === threadId || (isDraft && !pending.threadId));
  const empty = !isLoading && !visibleRuns.length && !showPending;

  return (
    <div
      className={cn(
        "relative flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col md:h-[calc(100dvh-6rem)]",
        panelFile && "md:pr-[calc(min(600px,52%)_+_16px)]",
      )}
    >
      <SideChats
        isMain={isMain}
        isDraft={isDraft}
        sideTitle={sideChat?.title ?? "Side chat"}
        sideChats={chats?.sideChats ?? []}
        activeThreadId={threadId}
        onOpenMain={() => openChat(null)}
        onOpenSide={(id) => openChat(id)}
        onNewSide={() => openChat("new")}
        onRemoveSide={(id) => removeChat.mutate(id)}
      />

      {threadId && !isDraft && visibleRuns.length ? (
        <div className="absolute right-0 top-1 z-20 flex items-center gap-2">
          {resetNote ? (
            <span className="tethr-glass rounded-full px-3 py-1.5 text-[12px]">Fresh start: your next message begins a new session.</span>
          ) : null}
          <button
            type="button"
            title="Start over"
            aria-label="Start this chat over"
            disabled={resetSession.isPending}
            onClick={() => {
              if (
                window.confirm(
                  "Start this chat over? tethr begins a fresh session: it keeps Memory.md and the messages here, but forgets this chat's working context.",
                )
              ) {
                resetSession.mutate();
              }
            }}
            className="tethr-glass grid h-9 w-9 place-items-center rounded-full text-foreground/80 transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {isMain ? (
        <div className="absolute left-1/2 top-1 z-20 -translate-x-1/2">
          <TethrSetupNudge />
        </div>
      ) : null}

      {/* One area: the conversation sits on the page, under the floating bar. */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent_0,transparent_40px,#000_68px,#000_calc(100%-14px),transparent_100%)]"
      >
        {empty ? (
          <ChatEmpty isDraft={isDraft} onPick={(s) => send.mutate({ text: s, attachments: [] })} />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-4 pb-6 pt-[72px] md:px-6">
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
              run.sourceKey === "tethr-idea" ? (
                <IdeaCard key={run.id} run={run} companyId={c} />
              ) : run.invocationSource === "chat" ? (
                <SessionTurn key={run.id} run={run} companyId={c} onOpenFile={setPanelPath} />
              ) : (
                <Turn key={run.id} run={run} companyId={c} />
              )
            ))}
            {showPending && !visibleRuns.some((r) => r.id === pending?.runId) ? (
              <div className="flex flex-col gap-4">
                <UserBubble text={pending!.text} attachments={pending!.attachments} />
                <Working label="sending…" />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <Composer
        key={threadId ?? "draft"}
        companyId={c}
        placeholder={isDraft ? "What's this side chat about?" : isMain ? "Message tethr…" : "Message this side chat…"}
        hint={undefined}
        busy={send.isPending}
        error={sendError}
        onSend={(text, attachments) => send.mutate({ text, attachments })}
      />

      {panelFile ? (
        <OutputPanel
          companyId={c}
          files={threadFiles.some((f) => f.path === panelFile.path) ? threadFiles : [...threadFiles, panelFile]}
          current={panelFile}
          onSelect={setPanelPath}
          onClose={() => setPanelPath(null)}
        />
      ) : null}
    </div>
  );
}

/** Distinct files written in a thread, in first-seen order; version = the
 * latest run + step that touched it, so a re-edit refreshes the preview. */
function panelFilesOf(runs: TethrChatRun[]): PanelFile[] {
  const byPath = new Map<string, string>();
  for (const run of runs) {
    if (run.invocationSource !== "chat") continue;
    run.hops.forEach((h, i) => {
      if (h.layer === "tool" && h.file && h.status === "ok") byPath.set(h.file, `${run.id}:${i}`);
    });
  }
  return [...byPath].map(([path, version]) => ({ path, version }));
}

const isMemoryFile = (p: string) => /(^|\/)Memory\.md$/i.test(p);

// ---- side chats drawer ---------------------------------------------------------

/** A sidebar icon at the chat's top-left that slides out your side chats. In a
 * side chat, a small chip shows its title with a way back to tethr. */
function SideChats({
  isMain,
  isDraft,
  sideTitle,
  sideChats,
  activeThreadId,
  onOpenMain,
  onOpenSide,
  onNewSide,
  onRemoveSide,
}: {
  isMain: boolean;
  isDraft: boolean;
  sideTitle: string;
  sideChats: TethrSideChat[];
  activeThreadId: string | null;
  onOpenMain: () => void;
  onOpenSide: (threadId: string) => void;
  onNewSide: () => void;
  onRemoveSide: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !toggleRef.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  const pick = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <div className="absolute left-0 top-1 z-20 flex max-w-[calc(100%-1rem)] items-center gap-2">
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Hide side chats" : "Show side chats"}
          aria-expanded={open}
          title="Side chats"
          className="tethr-glass relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:text-foreground"
        >
          {open ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          {sideChats.length && !open ? (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-[10px] text-primary-foreground">
              {sideChats.length}
            </span>
          ) : null}
        </button>
        {!isMain ? (
          <span className="tethr-glass flex h-9 min-w-0 items-center gap-1 rounded-full pl-3.5 pr-1 text-[13px]">
            <span className="min-w-0 truncate">{isDraft ? "New side chat" : sideTitle}</span>
            <button
              type="button"
              onClick={onOpenMain}
              title="Back to tethr"
              aria-label="Back to tethr"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
      </div>

      <div
        ref={panelRef}
        aria-label="Side chats"
        aria-hidden={!open}
        inert={!open || undefined}
        className={cn(
          "tethr-glass absolute bottom-2 left-0 top-12 z-30 flex w-72 max-w-[85vw] flex-col gap-1 overflow-y-auto p-2 transition-[transform,opacity] duration-200 ease-out",
          open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-3 opacity-0",
        )}
      >
        <div className="flex items-center justify-between px-2 pb-1 pt-0.5">
          <span className="tethr-eyebrow">side chats</span>
          <button
            type="button"
            onClick={() => pick(onNewSide)}
            className="tethr-btn tethr-btn-glass h-7 px-3 text-[12px]"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        </div>
        {!isMain ? (
          <button
            type="button"
            onClick={() => pick(onOpenMain)}
            className="flex items-center gap-2 rounded-[10px] px-2 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
          >
            <CornerUpLeft className="h-3.5 w-3.5 shrink-0" />
            Back to tethr
          </button>
        ) : null}
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
              title="Remove from the list (its history stays in Activity)"
              aria-label={`Remove ${s.title}`}
              className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-full tethr-text-3 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {!sideChats.length ? (
          <p className="px-2 py-1 text-[12px] leading-snug tethr-text-3">
            None yet. Start one for a focused task or side project; it stays separate from your chat with tethr.
          </p>
        ) : null}
      </div>
    </>
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
            ? "Start with what this chat is about. It stays separate from your chat with tethr."
            : "Ask anything. tethr keeps the conversation going and works toward your goals."}
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

type Outgoing = { text: string; attachments: TethrChatAttachment[] };

function UserBubble({
  text,
  at,
  attachments,
  onOpenFile,
}: {
  text: string;
  at?: string;
  attachments?: TethrChatAttachment[];
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {text ? (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-[16px_16px_4px_16px] bg-[var(--tethr-frost-strong)] px-4 py-2.5 text-[14px] leading-[1.6] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)] [overflow-wrap:anywhere]">
          {text}
        </div>
      ) : null}
      {attachments?.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {attachments.map((a) => (
            <FileChip key={a.path} name={a.name} kind={a.kind} onClick={a.panelPath && onOpenFile ? () => onOpenFile(a.panelPath!) : undefined} />
          ))}
        </div>
      ) : null}
      {at ? <span className="font-mono text-[10.5px] tethr-text-3">{formatRelative(at)}</span> : null}
    </div>
  );
}

/** A file pill: opens in the side panel when it can. */
function FileChip({
  name,
  kind,
  detail,
  tone,
  onClick,
  onRemove,
}: {
  name: string;
  kind?: TethrChatAttachment["kind"];
  detail?: string;
  tone?: "live" | "bad";
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const Icon = kind === "image" ? FileImage : FileText;
  const body = (
    <>
      {tone ? <StatusDot tone={tone} /> : <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="max-w-[200px] truncate">{name}</span>
      {detail ? <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">{detail}</span> : null}
    </>
  );
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full py-1 text-[12px]", CHIP_SURFACE, onRemove ? "pl-2.5 pr-1" : "px-2.5", onClick && CHIP_HOVER)}>
      {onClick ? (
        <button type="button" onClick={onClick} title={`Open ${name}`} className="inline-flex min-w-0 items-center gap-1.5">
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={name}>
          {body}
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--tethr-frost-strong)] hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

/** The live status row while a turn runs: the nebula (looping until the turn
 * ends), what's happening, how long it's been going, and Stop. */
function Working({ label, since, onStop, stopping }: { label: string; since?: string; onStop?: () => void; stopping?: boolean }) {
  const elapsed = useElapsed(since);
  return (
    <div className="flex min-w-0 items-center gap-2.5 text-[13px]">
      <Nebula className="text-[24px] text-foreground" />
      <span role="status" className="shimmer-text min-w-0 truncate font-medium">
        {label}
      </span>
      {elapsed ? (
        <span aria-hidden="true" className="shrink-0 font-mono text-[11px] tabular-nums tethr-text-3">
          {elapsed}
        </span>
      ) : null}
      {onStop ? (
        <button type="button" onClick={onStop} disabled={stopping} className="tethr-btn tethr-btn-ghost ml-1 h-7 shrink-0 px-3 text-[12px]">
          <Square className="h-3 w-3" />
          Stop
        </button>
      ) : null}
    </div>
  );
}

/** "12s", "1m 04s": time since `since`, ticking every second; null without a start. */
function useElapsed(since: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  if (Number.isNaN(seconds)) return null;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** What a running turn is doing right now, in a few words. */
function turnActivity(run: TethrChatRun, tools: TethrRouteHop[], waitingOnYou: boolean): string {
  if (run.status === "queued") return "waiting for the previous message…";
  if (waitingOnYou) return "waiting for your approval…";
  const step = [...tools].reverse().find((h) => h.status === "running");
  if (step) return `${step.decision}…`;
  if (run.resultText) return "writing…";
  return tools.length ? "working…" : "thinking…";
}

const ACTIVE = new Set(["queued", "running"]);

/** A phase-18 turn: one step of the thread's Claude session. */
function SessionTurn({
  run,
  companyId,
  onOpenFile,
}: {
  run: TethrChatRun;
  companyId: string;
  onOpenFile: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const running = ACTIVE.has(run.status);
  const isSystem = run.sourceKey === "chat-system";
  const tools = run.hops.filter((h) => h.layer === "tool");
  const files = [...new Set(tools.filter((h) => h.file && h.status === "ok").map((h) => h.file as string))];
  const gated = run.outputs.filter((o) => DECIDABLE.has(o.status));
  const stop = useMutation({
    mutationFn: () => tethrApi.stopChatTurn(companyId, run.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, run.threadId ?? "") }),
  });

  return (
    <div className="flex flex-col gap-3">
      {isSystem ? (
        <SystemLine text={run.requestText} />
      ) : (
        <UserBubble text={run.requestText} at={run.createdAt} attachments={run.attachments} onOpenFile={onOpenFile} />
      )}
      {tools.length ? <ActivityRows hops={tools} live={running} /> : null}
      {run.resultText ? <MarkdownBody className="tethr-chat-md">{run.resultText}</MarkdownBody> : null}
      {run.status === "failed" ? (
        <p className="text-[13.5px] text-[var(--tethr-bad)]">{run.error || "Something went wrong."}</p>
      ) : null}
      {run.status === "stopped" ? <p className="text-[12.5px] tethr-text-3">Stopped.</p> : null}
      {files.length ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <FileChip key={f} name={f.split("/").pop() ?? f} onClick={() => onOpenFile(f)} />
          ))}
        </div>
      ) : null}
      {gated.map((o) => (
        <ApprovalCard key={o.id} output={o} companyId={companyId} threadId={run.threadId ?? ""} />
      ))}
      {run.outputs
        .filter((o) => o.kind === "external_action" && !DECIDABLE.has(o.status))
        .map((o) => (
          <ActionStatus key={o.id} output={o} />
        ))}
      {running ? (
        <Working
          label={turnActivity(run, tools, gated.length > 0)}
          since={run.createdAt}
          onStop={() => stop.mutate()}
          stopping={stop.isPending}
        />
      ) : null}
    </div>
  );
}

/** Tool steps: live while the turn runs, then folded into a one-line summary. */
function ActivityRows({ hops, live }: { hops: TethrRouteHop[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const connectors = [...new Set(hops.map((h) => h.actorTag).filter((t) => t && t !== "tethr"))];
  const blocked = hops.filter((h) => h.status === "blocked").length;
  if (!live && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start text-[12px] tethr-text-3 transition-colors hover:text-foreground"
      >
        <ChevronRight className="h-3.5 w-3.5" />
        {hops.length} {hops.length === 1 ? "step" : "steps"}
        {connectors.length ? ` · ${connectors.join(", ")}` : ""}
        {blocked ? ` · ${blocked} blocked` : ""}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {!live ? (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex items-center gap-1.5 self-start text-[12px] tethr-text-3 transition-colors hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Hide steps
        </button>
      ) : null}
      {hops.map((h, i) => (
        <div key={`${h.toolUseId ?? i}`} className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <StatusDot
            tone={h.status === "ok" ? "ok" : h.status === "failed" ? "bad" : h.status === "blocked" ? "warn" : "live"}
            title={h.status}
          />
          <span className="shrink-0 font-mono text-[11.5px] tethr-text-3">{h.actorTag}</span>
          <span className="min-w-0 truncate text-muted-foreground">{h.decision}</span>
          {h.status === "blocked" && h.reason ? (
            <span className="min-w-0 truncate text-[11.5px] tethr-text-3">· {h.reason}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** An outward action after Mark decided it: approved (running), done, or rejected. */
function ActionStatus({ output }: { output: TethrChatOutput }) {
  const grant = ((output.meta as Record<string, unknown>)?.grant ?? {}) as Record<string, unknown>;
  const expired = output.status === "approved" && typeof grant.expiresAt === "string" && Date.parse(grant.expiresAt) < Date.now();
  const [tone, label] =
    output.status === "published"
      ? (["ok", "Done"] as const)
      : output.status === "rejected"
        ? (["bad", "Rejected"] as const)
        : grant.status === "failed"
          ? (["bad", "Approved, but it didn't go through"] as const)
          : expired
          ? (["paused", "Approval expired"] as const)
          : grant.status === "used"
            ? (["live", "Running"] as const)
            : (["live", "Approved, running"] as const);
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
      <StatusDot tone={tone} />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{output.title}</span>
    </div>
  );
}

/** A turn Tethr started itself (e.g. after an approval): a quiet centered line. */
/** An idea tethr offered on its own (phase 21): from a Slack conversation it
 * heard, a goal falling behind, or a quiet stretch. Useful / Not now tune how
 * often tethr speaks up. */
function IdeaCard({ run, companyId }: { run: TethrChatRun; companyId: string }) {
  const queryClient = useQueryClient();
  const idea = run.idea ?? null;
  const feedback = useMutation({
    mutationFn: (verdict: "useful" | "not_now") => tethrApi.ideaFeedback(companyId, idea!.id, verdict),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, run.threadId ?? "") }),
  });
  const origin = run.requestText.replace(/^Idea from tethr · /, "");
  const decided = idea?.status === "useful" ? "Marked useful" : idea?.status === "not_now" ? "Not now" : null;
  return (
    <div className="tethr-glass space-y-2.5 rounded-[16px] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11.5px] tethr-text-3">
        <Lightbulb className="h-3.5 w-3.5" />
        <span>Idea from tethr · {origin}</span>
        <span className="ml-auto font-mono text-[10.5px]">{formatRelative(run.createdAt)}</span>
      </div>
      <MarkdownBody className="tethr-chat-md">{run.resultText ?? ""}</MarkdownBody>
      {idea ? (
        <div className="flex flex-wrap items-center gap-2">
          {decided ? (
            <span className="flex items-center gap-1.5 text-[12px] tethr-text-3">
              <StatusDot tone={idea.status === "useful" ? "ok" : "idle"} />
              {decided}
            </span>
          ) : (
            <>
              <button
                type="button"
                disabled={feedback.isPending}
                onClick={() => feedback.mutate("useful")}
                className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[12.5px]"
              >
                Useful
              </button>
              <button
                type="button"
                disabled={feedback.isPending}
                onClick={() => feedback.mutate("not_now")}
                className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]"
              >
                Not now
              </button>
              <span className="text-[11.5px] tethr-text-3">Reply below to take it further.</span>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SystemLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 text-[11.5px] tethr-text-3">
      <span className="h-px flex-1 bg-[var(--tethr-rim)]" />
      <span className="max-w-[70%] truncate">{text.split("\n")[0]}</span>
      <span className="h-px flex-1 bg-[var(--tethr-rim)]" />
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
          <MarkdownBody className="tethr-chat-md">{run.resultText}</MarkdownBody>
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
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] tethr-text-3">{LAYER_LABEL[hop.layer]}</span>
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
      queryClient.invalidateQueries({ queryKey: tethrKeys.chats(companyId) });
      refreshAfterDecision(queryClient, companyId);
    },
  });
  const snippet = useMemo(() => previewText(output.body), [output.body]);
  const isAction = output.kind === "external_action";
  const actionBody = isAction ? output.body.split("\n").slice(2).join("\n").trim() : "";
  return (
    <div className="tethr-glass flex max-w-2xl flex-col gap-2.5 p-4">
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <Lock className="h-3 w-3" />
        {isAction
          ? `needs your ok · ${String((output.meta as Record<string, unknown>)?.connector ?? "action")}${output.sensitivity !== "external" ? ` · ${output.sensitivity === "spend" ? "money" : output.sensitivity}` : ""}`
          : `${output.status === "changes_requested" ? "changes requested" : "awaiting review"} · ${kindLabel(output.kind)} · ${output.sensitivity}`}
      </span>
      <p className="text-[14.5px] font-medium leading-snug">{output.title}</p>
      {isAction ? (
        actionBody ? (
          // Plain text on purpose: exactly what will be sent, with no Markdown
          // to hide text or dress a link up as something else.
          <pre className="tethr-inset max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-sans text-[13px] leading-relaxed">
            {actionBody}
          </pre>
        ) : null
      ) : snippet ? (
        <p className="line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{snippet}</p>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={decide.isPending}
          onClick={() => decide.mutate("approve")}
          className="tethr-btn tethr-btn-primary h-8 px-4 text-[12.5px]"
        >
          {isAction ? "Approve & run" : "Approve"}
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
          className="-my-2 ml-auto inline-flex items-center gap-1 py-2 text-[12px] text-muted-foreground hover:text-foreground"
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

const MAX_ATTACHMENTS = 6;
const ATTACH_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.log,.ics,.rtf";

type DraftFile = {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  file?: TethrChatAttachment;
};

function Composer({
  companyId,
  placeholder,
  hint,
  busy,
  error,
  onSend,
}: {
  companyId: string;
  placeholder: string;
  hint?: string;
  busy: boolean;
  error: string | null;
  onSend: (text: string, attachments: TethrChatAttachment[]) => void;
}) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = useRef(0);

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

  // Each file uploads as soon as it's picked; the message only names it.
  const addFiles = (list: FileList | File[]) => {
    const room = MAX_ATTACHMENTS - drafts.length;
    const files = Array.from(list);
    setNote(files.length > room ? `At most ${MAX_ATTACHMENTS} files per message.` : null);
    for (const f of files.slice(0, Math.max(0, room))) {
      const id = `f${++count.current}`;
      const upload = f.name ? f : new File([f], "pasted-image.png", { type: f.type });
      setDrafts((d) => [...d, { id, name: upload.name, size: f.size, status: "uploading" }]);
      tethrApi
        .uploadChatAttachment(companyId, upload)
        .then((file) => setDrafts((d) => d.map((x) => (x.id === id ? { ...x, status: "ready", name: file.name, file } : x))))
        .catch((e) =>
          setDrafts((d) =>
            d.map((x) => (x.id === id ? { ...x, status: "error", error: e instanceof Error ? e.message : "Couldn't attach it." } : x)),
          ),
        );
    }
    ref.current?.focus({ preventScroll: true });
  };

  const ready = drafts.flatMap((d) => (d.status === "ready" && d.file ? [d.file] : []));
  const uploading = drafts.some((d) => d.status === "uploading");
  const failed = drafts.find((d) => d.status === "error");
  const canSend = !busy && !uploading && (!!text.trim() || ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), ready);
    setText("");
    setDrafts([]);
    setNote(null);
  };

  const status = error ?? (failed ? `${failed.name}: ${failed.error}` : note);

  return (
    <div className="shrink-0 px-3 pb-3 pt-1 md:px-6 md:pb-4">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "tethr-glass rounded-[22px] p-1.5 transition-shadow",
            dragging && "shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
          )}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {drafts.length ? (
            <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-0.5">
              {drafts.map((d) => (
                <FileChip
                  key={d.id}
                  name={d.name}
                  kind={d.file?.kind ?? (/\.(png|jpe?g|gif|webp)$/i.test(d.name) ? "image" : "text")}
                  detail={d.status === "uploading" ? "attaching…" : d.status === "error" ? "couldn't attach" : formatBytes(d.size)}
                  tone={d.status === "uploading" ? "live" : d.status === "error" ? "bad" : undefined}
                  onRemove={() => setDrafts((all) => all.filter((x) => x.id !== d.id))}
                />
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-1">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={drafts.length >= MAX_ATTACHMENTS}
              aria-label="Attach files"
              title="Attach files (images, PDFs, text)"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--tethr-frost-strong)] hover:text-foreground disabled:opacity-30"
            >
              <Paperclip className="h-4 w-4" />
            </button>
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
              onPaste={(e) => {
                // A pasted screenshot or file attaches; pasted text stays text.
                const files = Array.from(e.clipboardData.files);
                if (files.length && !e.clipboardData.getData("text/plain")) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              placeholder={placeholder}
              aria-label="Message"
              className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[14px] leading-5 outline-none placeholder:text-[var(--tethr-text-3)]"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ATTACH_ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {/* Lines up with the message text on the left and the send arrow on the right. */}
        <div className="mt-1.5 flex items-center justify-between gap-3 pl-[50px] pr-1.5">
          <span className="truncate text-[11.5px] tethr-text-3">
            {status ? <span className={cn((error || failed) && "text-[var(--tethr-bad)]")}>{status}</span> : hint}
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
