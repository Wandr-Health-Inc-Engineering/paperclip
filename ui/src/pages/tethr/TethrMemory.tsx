import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { ApiError } from "@/api/client";
import { tethrApi, tethrKeys } from "@/api/tethr";

// Memory (phase 18.5). What the chat actually remembers is ONE file,
// Memory.md, in the workspace inside 00 Tethr. Claude loads it at the start of
// every session and edits it when you say "remember…". Here you read it and
// edit it yourself. Saving is guarded: if tethr changed the file since you
// opened it, the save is refused and you choose whose version to keep.
//
// The old engine's auto-written log (tethr_memories) is folded underneath.

export function TethrMemory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to see what tethr remembers." />;
  }
  return (
    <div className="space-y-8">
      <MemoryFile companyId={selectedCompanyId} />
      <LegacyLog companyId={selectedCompanyId} />
    </div>
  );
}

// ---- Memory.md -----------------------------------------------------------------

function MemoryFile({ companyId: c }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.assistantMemory(c),
    queryFn: () => tethrApi.assistantMemory(c),
    // Pick up tethr's own edits while you're reading (not while you edit).
    refetchInterval: 15_000,
  });
  const [mode, setMode] = useState<"read" | "edit">("read");
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState<{ content: string; mtime: number } | null>(null);
  const [conflict, setConflict] = useState<{ content: string; mtime: number } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty = mode === "edit" && base !== null && draft !== base.content;

  const startEdit = () => {
    if (!data) return;
    setDraft(data.content);
    setBase({ content: data.content, mtime: data.mtime });
    setConflict(null);
    setMode("edit");
  };

  const save = useMutation({
    mutationFn: (args: { content: string; ifMtime: number }) =>
      tethrApi.saveAssistantMemory(c, args.content, args.ifMtime),
    onSuccess: ({ mtime }, args) => {
      queryClient.setQueryData(tethrKeys.assistantMemory(c), (old: typeof data) =>
        old ? { ...old, content: args.content, mtime } : old,
      );
      setBase(null);
      setConflict(null);
      setMode("read");
      setSavedAt(Date.now());
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { content?: string; mtime?: number } | null;
        if (typeof body?.content === "string" && typeof body.mtime === "number") {
          setConflict({ content: body.content, mtime: body.mtime });
        }
      }
    },
  });

  // Leaving with unsaved edits: warn like any editor would.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error || !data) {
    return (
      <p className="tethr-empty px-4 py-10 text-center text-sm">
        {error instanceof Error ? error.message : "Memory.md couldn't be read."}
      </p>
    );
  }

  const saveError = save.error && !(save.error instanceof ApiError && save.error.status === 409) ? save.error : null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium">What tethr remembers</h2>
          <p className="mt-0.5 truncate font-mono text-[11px] tethr-text-3" title={data.path}>
            {data.inDrive ? "00 Tethr/tethr/Memory.md" : data.path} · loaded into every chat ·{" "}
            {savedAt ? "saved just now" : `updated ${formatRelative(new Date(data.mtime).toISOString())}`}
          </p>
        </div>
        {mode === "read" ? (
          <button type="button" onClick={startEdit} className="tethr-btn tethr-btn-glass h-8 px-3.5 text-[12.5px]">
            Edit
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setMode("read");
                setBase(null);
                setConflict(null);
                save.reset();
              }}
              className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty || save.isPending || !!conflict}
              onClick={() => base && save.mutate({ content: draft, ifMtime: base.mtime })}
              className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[12.5px] disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </div>

      {conflict ? (
        <div className="tethr-glass flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
          <p className="min-w-0 flex-1">
            tethr changed Memory.md since you started editing, so your edit wasn't saved.
          </p>
          <button
            type="button"
            onClick={() => {
              setDraft(conflict.content);
              setBase(conflict);
              setConflict(null);
              save.reset();
            }}
            className="tethr-btn tethr-btn-ghost h-7 px-3 text-[12px]"
          >
            Load tethr's version
          </button>
          <button
            type="button"
            onClick={() => save.mutate({ content: draft, ifMtime: conflict.mtime })}
            className="tethr-btn tethr-btn-glass h-7 px-3 text-[12px]"
          >
            Keep mine
          </button>
        </div>
      ) : null}
      {saveError ? <p className="text-[12.5px] text-[var(--tethr-bad)]">{saveError.message}</p> : null}

      {mode === "edit" ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck
          aria-label="Memory.md"
          className="tethr-inset block min-h-[60vh] w-full resize-y px-4 py-3 font-mono text-[12.5px] leading-relaxed outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]"
        />
      ) : (
        <div className="tethr-panel px-5 py-5 md:px-8 md:py-7">
          <MarkdownBody className="text-[14px] leading-relaxed">{data.content}</MarkdownBody>
        </div>
      )}
      <p className="text-[12px] tethr-text-3">
        Tell tethr "remember …" or "forget …" in the chat and it edits this file. It never stores passwords or patient
        details here.
      </p>
    </section>
  );
}

// ---- the old engine's log --------------------------------------------------------

function LegacyLog({ companyId: c }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: memories } = useQuery({
    queryKey: tethrKeys.memories(c),
    queryFn: () => tethrApi.memories(c),
    enabled: open,
  });
  const { data: overview } = useQuery({
    queryKey: tethrKeys.overview(c),
    queryFn: () => tethrApi.overview(c),
    enabled: open,
  });
  const tagById = useMemo(() => new Map((overview?.agents ?? []).map((a) => [a.agent.id, a.profile.tag])), [overview]);
  const rows = useMemo(() => {
    const all = memories ?? [];
    const q = query.trim().toLowerCase();
    return q ? all.filter((m) => m.content.toLowerCase().includes(q)) : all;
  }, [memories, query]);

  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Older agent log
        <MonoTag className="ml-1">classic engine</MonoTag>
      </button>
      {open ? (
        <>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[12px] tethr-text-3">
              Notes the classic multi-agent engine wrote on its own. The chat doesn't read these.
            </p>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search…"
              className="h-8 w-48 font-mono text-xs"
            />
          </div>
          {rows.length ? (
            <div className="tethr-panel overflow-hidden">
              {rows.map((m, i) => (
                <div
                  key={m.id}
                  className={cn(
                    "grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5 max-md:grid-cols-1 max-md:gap-1",
                    i < rows.length - 1 && "tethr-rule border-b",
                  )}
                >
                  <span className="font-mono text-[10.5px] tethr-text-3">{m.kind}</span>
                  <span className="min-w-0 text-[13px] leading-relaxed">{m.content}</span>
                  <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">
                    {m.agentId ? (tagById.get(m.agentId) ?? "agent") : "company"} · {formatRelative(m.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="tethr-empty px-4 py-6 text-center text-sm">{memories ? "Nothing here." : "Loading…"}</p>
          )}
        </>
      ) : null}
    </section>
  );
}
