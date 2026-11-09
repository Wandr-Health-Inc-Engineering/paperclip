import { useEffect, useMemo, useState } from "react";
import { Link } from "../../lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ChevronDown, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import { PageSkeleton } from "@/components/PageSkeleton";
import { BudgetBar, MonoTag, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrMemoryEntry,
  type TethrMemoryOp,
  type TethrMemoryState,
  type TethrMemoryTarget,
  type TethrRecallHit,
} from "@/api/tethr";

// Memory (phase 25). What tethr remembers between conversations: short entries
// in two stores, "Company notes" and "People", held in Hermes (tethr's profile)
// or, without Hermes, in tethr's built-in store. The chat reads them every turn
// and saves to them with its memory tool; here you see who saved what, edit,
// remove and add. With Hermes, every past conversation is searchable (what the
// chat's recall finds) and the skills tethr learned are listed.
//
// The old engine's auto-written log (tethr_memories) is folded underneath.

const TARGETS: Array<{ id: TethrMemoryTarget; label: string; hint: string }> = [
  { id: "company", label: "Company notes", hint: "Decisions, how things work, products, partners, who handles what." },
  { id: "people", label: "People", hint: "Each person's preferences and style." },
];

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
    <div className="mx-auto max-w-4xl space-y-8">
      <MemoryStores companyId={selectedCompanyId} />
      <LegacyLog companyId={selectedCompanyId} />
    </div>
  );
}

function MemoryStores({ companyId: c }: { companyId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.memory(c),
    queryFn: () => tethrApi.memory(c),
    // Pick up what the chat saves while you're reading.
    refetchInterval: 15_000,
  });

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error || !data) {
    return <p className="tethr-empty px-4 py-10 text-center text-sm">{error instanceof Error ? error.message : "Memory couldn't be read."}</p>;
  }
  const hermes = data.backend === "hermes";
  return (
    <>
      <header className="space-y-1">
        <h2 className="text-[15px] font-medium">What tethr remembers</h2>
        <p className="flex items-start gap-2 text-[12.5px] tethr-text-3">
          <StatusDot tone={hermes ? "ok" : "idle"} className="mt-[5px] shrink-0" />
          {hermes ? (
            <span>
              In Hermes (profile <span className="font-mono">{data.hermes.profile}</span>) · {data.hermes.indexed.toLocaleString()} past conversation
              {data.hermes.indexed === 1 ? "" : "s"} searchable
            </span>
          ) : (
            <span>
              In tethr's built-in store.{" "}
              {data.hermes.installed ? (
                <Link to="/tethr-settings" className="underline underline-offset-2 hover:text-foreground">
                  Use Hermes
                </Link>
              ) : (
                "Install Hermes"
              )}{" "}
              to search past conversations and keep skills.
            </span>
          )}
        </p>
        <p className="text-[12px] tethr-text-3">
          Loaded into every chat. Tell tethr "remember …" or "forget …" in the chat, or change it here. It never saves passwords or anyone's
          health information.
        </p>
      </header>

      {data.notMoved.length ? <NotMoved companyId={c} notes={data.notMoved} /> : null}

      {TARGETS.map((t) => (
        <StoreSection key={t.id} companyId={c} target={t.id} label={t.label} hint={t.hint} store={data.stores[t.id]} />
      ))}

      {hermes ? <PastConversations companyId={c} state={data} /> : null}
      {hermes ? <Skills companyId={c} skills={data.skills} /> : null}
    </>
  );
}

/** Notes that couldn't be moved when memory changed stores (or from the old
 * Memory.md), with the reason. Nothing is dropped silently: each one stays here
 * until it's been reworded and added, or dismissed. */
function NotMoved({ companyId: c, notes }: { companyId: string; notes: TethrMemoryState["notMoved"] }) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (index: number | "all") => tethrApi.dismissNotMoved(c, index),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: tethrKeys.memory(c) }),
  });
  return (
    <section className="space-y-2.5">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-[13.5px] font-medium">
            <StatusDot tone="warn" />
            Not moved ({notes.length})
          </h3>
          <p className="text-[12px] tethr-text-3">
            These notes couldn't be saved where memory lives now. Reword one and add it below, or dismiss it. The original file is backed up either way.
          </p>
        </div>
        <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate("all")} className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-2.5 text-[12px]">
          Dismiss all
        </button>
      </div>
      <div className="tethr-panel overflow-hidden">
        {notes.map((n, i) => (
          <div key={`${n.at}-${i}`} className={cn("flex items-start gap-3 px-4 py-3", i < notes.length - 1 && "tethr-rule border-b")}>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{n.text}</p>
              <p className="text-[12px] tethr-text-3">
                {n.target === "people" ? "People" : "Company notes"} · {n.reason}
              </p>
            </div>
            <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(i)} className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-2.5 text-[12px]">
              Dismiss
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function useMemoryChange(c: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { target: TethrMemoryTarget; operations: TethrMemoryOp[] }) => tethrApi.changeMemory(c, args.target, args.operations),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(tethrKeys.memory(c), (old: TethrMemoryState | undefined) => (old ? { ...old, ...snapshot } : old));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: tethrKeys.memory(c) }),
  });
}

function StoreSection({
  companyId: c,
  target,
  label,
  hint,
  store,
}: {
  companyId: string;
  target: TethrMemoryTarget;
  label: string;
  hint: string;
  store: TethrMemoryState["stores"][TethrMemoryTarget];
}) {
  const change = useMemoryChange(c);
  const [adding, setAdding] = useState("");
  const pct = store.limit ? Math.round((store.used / store.limit) * 100) : 0;

  const add = () => {
    const content = adding.trim();
    if (!content) return;
    change.mutate({ target, operations: [{ action: "add", content }] }, { onSuccess: () => setAdding("") });
  };

  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-[13.5px] font-medium">{label}</h3>
          <p className="text-[12px] tethr-text-3">{hint}</p>
        </div>
        <div className="w-44 space-y-1">
          <p className="text-right font-mono text-[10.5px] tethr-text-3">
            {pct}% · {store.used.toLocaleString()}/{store.limit.toLocaleString()}
          </p>
          <BudgetBar spentCents={store.used} capCents={store.limit} warnPercent={85} />
        </div>
      </div>
      <div className="tethr-panel overflow-hidden">
        {store.entries.length ? (
          store.entries.map((entry, i) => (
            <EntryRow key={entry.text} companyId={c} target={target} entry={entry} last={i === store.entries.length - 1} change={change} />
          ))
        ) : (
          <p className="px-4 py-5 text-[13px] tethr-text-3">Nothing saved yet.</p>
        )}
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder={target === "people" ? "e.g. Alec handles partnerships and prefers Slack" : "e.g. Partner payouts go out on the 15th"}
          aria-label={`Add to ${label}`}
          className="h-9 min-w-0 flex-1 text-[13px]"
        />
        <button type="submit" disabled={!adding.trim() || change.isPending} className="tethr-btn tethr-btn-glass h-9 px-4 text-[12.5px] disabled:opacity-50">
          Add
        </button>
      </form>
      {change.error ? <p className="text-[12.5px] text-[var(--tethr-bad)]">{change.error.message}</p> : null}
    </section>
  );
}

function savedLine(entry: TethrMemoryEntry, companyId: string): React.ReactNode {
  if (!entry.savedBy) return null;
  const chat = entry.threadId ? (entry.threadId === companyId ? "/chat" : `/chat?chat=${entry.threadId}`) : null;
  return (
    <span className="font-mono text-[10.5px] tethr-text-3">
      {entry.savedBy}
      {entry.savedAt ? ` · ${formatRelative(entry.savedAt)}` : ""}
      {chat ? (
        <>
          {" · "}
          <Link to={chat} className="underline-offset-2 hover:text-foreground hover:underline">
            chat
          </Link>
        </>
      ) : null}
    </span>
  );
}

function EntryRow({
  companyId: c,
  target,
  entry,
  last,
  change,
}: {
  companyId: string;
  target: TethrMemoryTarget;
  entry: TethrMemoryEntry;
  last: boolean;
  change: ReturnType<typeof useMemoryChange>;
}) {
  const [mode, setMode] = useState<"read" | "edit" | "remove">("read");
  const [draft, setDraft] = useState(entry.text);
  const busy = change.isPending;

  return (
    <div className={cn("group px-4 py-3", !last && "tethr-rule border-b")}>
      {mode === "edit" ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(8, Math.max(2, draft.split("\n").length))}
            aria-label="Edit entry"
            className="tethr-inset block w-full resize-y px-3 py-2 text-[13px] leading-relaxed outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode("read")} className="tethr-btn tethr-btn-ghost h-7 px-3 text-[12px]">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !draft.trim() || draft.trim() === entry.text}
              onClick={() =>
                change.mutate(
                  { target, operations: [{ action: "patch", old_text: entry.text, content: draft.trim() }] },
                  { onSuccess: () => setMode("read") },
                )
              }
              className="tethr-btn tethr-btn-primary h-7 px-3 text-[12px] disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{entry.text}</p>
            {savedLine(entry, c)}
          </div>
          {mode === "remove" ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[12px] tethr-text-3">Remove?</span>
              <button type="button" onClick={() => setMode("read")} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[12px]">
                Keep
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => change.mutate({ target, operations: [{ action: "remove", old_text: entry.text }] }, { onSettled: () => setMode("read") })}
                className="tethr-btn tethr-btn-danger h-7 px-2.5 text-[12px]"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
              <button
                type="button"
                onClick={() => {
                  setDraft(entry.text);
                  setMode("edit");
                }}
                className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[12px]"
              >
                Edit
              </button>
              <button type="button" onClick={() => setMode("remove")} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[12px]">
                Remove
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- past conversations (Hermes) ------------------------------------------------

function hitDate(h: TethrRecallHit): string {
  return h.startedAt ? new Date(h.startedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

function hitChat(h: TethrRecallHit): string {
  return (h.title ?? "chat").split(" · ").slice(0, -2).join(" · ") || "chat";
}

function PastConversations({ companyId: c, state }: { companyId: string; state: TethrMemoryState }) {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: tethrKeys.memorySearch(c, asked),
    queryFn: () => tethrApi.searchMemory(c, asked),
    enabled: asked.length > 0,
  });
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[13.5px] font-medium">Past conversations</h3>
        <p className="text-[12px] tethr-text-3">
          Every finished chat turn goes into Hermes, so tethr can look it up later (what its recall finds).{" "}
          {state.hermes.lastImportAt ? `Last added ${formatRelative(state.hermes.lastImportAt)}.` : ""}
          {state.hermes.lastImportError ? ` The last import had a problem: ${state.hermes.lastImportError}` : ""}
        </p>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          // The same words again: search again (new conversations may have been added).
          if (q.trim() === asked) void refetch();
          else setAsked(q.trim());
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 tethr-text-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search past conversations" aria-label="Search past conversations" className="h-9 pl-8 text-[13px]" />
        </div>
        <button type="submit" disabled={!q.trim()} className="tethr-btn tethr-btn-glass h-9 px-4 text-[12.5px] disabled:opacity-50">
          Search
        </button>
      </form>
      {error ? <p className="text-[12.5px] text-[var(--tethr-bad)]">{error.message}</p> : null}
      {asked && data ? (
        data.hits.length ? (
          <div className="tethr-panel overflow-hidden">
            {data.hits.map((h, i) => (
              <div key={h.sessionId} className={cn("space-y-1 px-4 py-3", i < data.hits.length - 1 && "tethr-rule border-b")}>
                <p className="font-mono text-[10.5px] tethr-text-3">
                  {hitDate(h)} · {hitChat(h)}
                </p>
                <p className="text-[13px] leading-relaxed">
                  <span className="tethr-text-3">Asked: </span>
                  {h.user}
                </p>
                <p className="line-clamp-4 text-[13px] leading-relaxed">
                  <span className="tethr-text-3">tethr: </span>
                  {h.assistant}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="tethr-empty px-4 py-5 text-center text-[13px]">{isFetching ? "Searching…" : `Nothing matches "${asked}".`}</p>
        )
      ) : null}
    </section>
  );
}

// ---- skills (Hermes) --------------------------------------------------------------

function Skills({ companyId: c, skills }: { companyId: string; skills: TethrMemoryState["skills"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: skill } = useQuery({
    queryKey: tethrKeys.memorySkill(c, open ?? ""),
    queryFn: () => tethrApi.memorySkill(c, open!),
    enabled: open !== null,
  });
  const remove = useMutation({
    mutationFn: (name: string) => tethrApi.deleteMemorySkill(c, name),
    onSuccess: () => {
      setRemoving(null);
      setOpen(null);
      void queryClient.invalidateQueries({ queryKey: tethrKeys.memory(c) });
    },
  });
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[13.5px] font-medium">Skills</h3>
        <p className="text-[12px] tethr-text-3">Procedures that worked, saved by tethr so it does them the same way next time. Ask it in the chat to save one.</p>
      </div>
      <div className="tethr-panel overflow-hidden">
        {skills.length ? (
          skills.map((s, i) => (
            <div key={s.name} className={cn("px-4 py-3", i < skills.length - 1 && "tethr-rule border-b")}>
              <div className="flex items-start gap-3">
                <button type="button" onClick={() => setOpen(open === s.name ? null : s.name)} aria-expanded={open === s.name} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {open === s.name ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    <span className="font-mono">{s.name}</span>
                  </span>
                  <span className="mt-0.5 block pl-5 text-[12.5px] tethr-text-3">{s.description}</span>
                </button>
                {removing === s.name ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button type="button" onClick={() => setRemoving(null)} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[12px]">
                      Keep
                    </button>
                    <button type="button" disabled={remove.isPending} onClick={() => remove.mutate(s.name)} className="tethr-btn tethr-btn-danger h-7 px-2.5 text-[12px]">
                      Remove
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setRemoving(s.name)} className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-2.5 text-[12px]">
                    Remove
                  </button>
                )}
              </div>
              {open === s.name ? (
                <div className="tethr-inset mt-3 px-4 py-3">
                  {skill ? <MarkdownBody className="tethr-doc-md">{skill.content}</MarkdownBody> : <p className="text-[12.5px] tethr-text-3">Loading…</p>}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <p className="px-4 py-5 text-[13px] tethr-text-3">No skills yet.</p>
        )}
      </div>
      {remove.error ? <p className="text-[12.5px] text-[var(--tethr-bad)]">{remove.error.message}</p> : null}
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
            <p className="min-w-0 flex-1 text-[12px] tethr-text-3">Notes the classic multi-agent engine wrote on its own. The chat doesn't read these.</p>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search…" className="h-8 w-48 font-mono text-xs" />
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
