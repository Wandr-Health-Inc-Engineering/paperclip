import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Inbox, RotateCcw } from "lucide-react";
import { MonoTag, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrInboxItem } from "@/api/tethr";
import { cn } from "@/lib/utils";

// Phase 26.3: tethr's Inbox in the Drive. Files sent to tethr (the 00 Inbox
// folder, "File this" in the chat, a file sent alone in Slack) with Jev's
// suggestion of what it is, where it goes and who should know. A tap files it;
// nothing is ever deleted. Also the filing rules tethr proposes from your
// corrections, and what was filed recently (with Put it back for 7 days).

const UNDO_DAYS = 7;
const folderOf = (rel: string | null) => (rel ? rel.split("/").slice(0, -1).join(" / ") : "");

/** The actions on one Inbox item: shared by the Inbox view and the chat card. */
export function InboxItemActions({ item, companyId, folders, compact = false }: { item: TethrInboxItem; companyId: string; folders: string[]; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [other, setOther] = useState(false);
  const [choice, setChoice] = useState("");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: tethrKeys.inbox(companyId) });
    void queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "chats"] });
  };
  const run = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSettled: refresh });
  const error = run.error instanceof Error ? run.error.message : null;
  const s = item.suggestion;
  const btn = "tethr-btn h-8 px-3 text-[12.5px]";

  if (item.status === "filed") {
    const recent = item.filedAt && Date.now() - new Date(item.filedAt).getTime() < UNDO_DAYS * 86_400_000;
    return (
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <StatusDot tone="ok" />
        <span>
          Filed in {folderOf(item.filedTo)} by {item.filedBy ?? "a person"}
          {item.note ? ` · ${item.note}` : ""}
        </span>
        {recent ? (
          <button type="button" className={cn(btn, "tethr-btn-ghost")} disabled={run.isPending} onClick={() => run.mutate(() => tethrApi.putBackInboxItem(companyId, item.id))}>
            <RotateCcw className="h-3.5 w-3.5" /> Put it back
          </button>
        ) : null}
        {s && s.notify !== "Nobody" && !item.note ? (
          <button type="button" className={cn(btn, "tethr-btn-glass")} disabled={run.isPending} onClick={() => run.mutate(() => tethrApi.routeInboxItem(companyId, item.id, s.notify))}>
            {s.notify.startsWith("@") ? `Hand it to ${s.notify}` : `Tell ${s.notify}`}
          </button>
        ) : null}
        {error ? <span className="w-full text-[var(--tethr-bad)]">{error}</span> : null}
      </div>
    );
  }
  if (item.status === "left") return <p className="text-[12.5px] text-muted-foreground">Left where it is, in 00 Inbox.</p>;
  if (item.status === "failed") return <p className="text-[12.5px] text-[var(--tethr-bad)]">{item.note ?? "Something went wrong."}</p>;

  const picks = s ? [s.destination, ...s.alternatives].filter((d, i, all) => all.indexOf(d) === i) : [];
  return (
    <div className="space-y-2">
      {item.note ? <p className={cn("text-[12.5px]", item.status === "needs_person" ? "text-[var(--tethr-warn)]" : "text-muted-foreground")}>{item.note}</p> : null}
      {s ? (
        <p className="text-[12.5px] text-muted-foreground">
          Looks like {/^[aeiou]/i.test(s.type) ? "an" : "a"} {s.type} · needs someone {s.urgency === "whenever" ? "whenever" : s.urgency}
          {s.notify !== "Nobody" ? ` · ${s.notify.startsWith("@") ? "for" : "tell"} ${s.notify}` : ""} · Jev is {Math.round(s.confidence * 100)}% sure
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {picks.map((d, i) => (
          <button
            key={d}
            type="button"
            disabled={run.isPending}
            onClick={() => run.mutate(() => tethrApi.fileInboxItem(companyId, item.id, d))}
            className={cn(btn, i === 0 ? "tethr-btn-primary" : "tethr-btn-glass", "max-w-full")}
          >
            <span className="truncate">{i === 0 ? `File in ${d}` : d}</span>
          </button>
        ))}
        {!other ? (
          <button type="button" className={cn(btn, "tethr-btn-ghost")} onClick={() => setOther(true)}>
            {picks.length ? "Somewhere else" : "Choose a folder"}
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} className="tethr-inset h-8 max-w-[240px] rounded-[10px] px-2 text-[12.5px]" aria-label="Folder">
              <option value="">Choose a folder…</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button type="button" className={cn(btn, "tethr-btn-glass")} disabled={!choice || run.isPending} onClick={() => run.mutate(() => tethrApi.fileInboxItem(companyId, item.id, choice))}>
              File
            </button>
          </span>
        )}
        {!compact ? (
          <button type="button" className={cn(btn, "tethr-btn-ghost")} disabled={run.isPending} onClick={() => run.mutate(() => tethrApi.leaveInboxItem(companyId, item.id))}>
            Leave it
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[12px] text-[var(--tethr-bad)]">{error}</p> : null}
    </div>
  );
}

export function InboxView({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: tethrKeys.inbox(companyId), queryFn: () => tethrApi.inbox(companyId), refetchInterval: 20_000 });
  const scan = useMutation({ mutationFn: () => tethrApi.scanInbox(companyId), onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.inbox(companyId) }) });
  const rule = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) => tethrApi.decideFilingRule(companyId, id, accept),
    onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.inbox(companyId) }),
  });
  if (!data) return null;
  const proposed = data.rules.filter((r) => r.status === "proposed");
  const active = data.rules.filter((r) => r.status === "active");
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[64ch] text-[13px] text-muted-foreground">
          Drop a file in <span className="font-mono text-[12px]">00 Tethr/00 Inbox</span>, use File this on a chat upload, or send it to tethr alone in Slack.
          tethr reads it on this computer, Jev suggests where it goes and who should know, and you tap. Nothing is deleted; people are told a file's name
          and folder, never what's in it.
        </p>
        <button type="button" className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]" disabled={!data.connected || scan.isPending} onClick={() => scan.mutate()}>
          Look now
        </button>
      </div>
      {!data.connected ? <div className="tethr-empty px-4 py-3 text-[13px]">The shared Drive folder (00 Tethr) isn't connected, so the Inbox is off.</div> : null}

      {proposed.length ? (
        <section className="tethr-glass space-y-2 rounded-[16px] p-4">
          <MonoTag>filing rules tethr suggests</MonoTag>
          {proposed.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <span className="min-w-0 flex-1">{r.text}</span>
              <button type="button" className="tethr-btn tethr-btn-primary h-8 px-3 text-[12.5px]" disabled={rule.isPending} onClick={() => rule.mutate({ id: r.id, accept: true })}>
                Use this rule
              </button>
              <button type="button" className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px]" disabled={rule.isPending} onClick={() => rule.mutate({ id: r.id, accept: false })}>
                No
              </button>
            </div>
          ))}
          <p className="text-[12px] text-muted-foreground">From your corrections. A rule goes to Jev with every filing decision.</p>
        </section>
      ) : null}

      <section className="tethr-panel overflow-hidden">
        <header className="flex items-center justify-between border-b tethr-rule px-4 py-3">
          <h2 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <Inbox className="h-4 w-4" /> Waiting to be filed
          </h2>
          <span className="font-mono text-[11px] tethr-text-3">{data.open.length}</span>
        </header>
        {data.open.length ? (
          <div className="divide-y divide-[var(--tethr-rim)]">
            {data.open.map((item) => (
              <div key={item.id} className="space-y-2 px-4 py-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{item.name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">
                    {item.source} · {formatRelative(item.createdAt)}
                  </span>
                </div>
                <InboxItemActions item={item} companyId={companyId} folders={data.folders} />
              </div>
            ))}
          </div>
        ) : (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">Nothing waiting.</p>
        )}
      </section>

      {data.filed.length ? (
        <section className="tethr-panel overflow-hidden">
          <header className="border-b tethr-rule px-4 py-3">
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Recently</h2>
          </header>
          <div className="divide-y divide-[var(--tethr-rim)]">
            {data.filed.map((item) => (
              <div key={item.id} className="space-y-1.5 px-4 py-3">
                <p className="truncate text-[13.5px]">{item.name}</p>
                <InboxItemActions item={item} companyId={companyId} folders={data.folders} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {active.length ? (
        <section className="space-y-1.5 px-1">
          <MonoTag>filing rules in use</MonoTag>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
            {active.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
