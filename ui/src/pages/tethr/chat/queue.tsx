import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Pencil, X } from "lucide-react";
import { tethrApi, tethrKeys, type TethrChatRun } from "@/api/tethr";
import { enterSends } from "@/lib/tethr-composer";

// Messages sent while tethr is still working on the one before (Mark,
// 2026-11-10: "it should be held in a queue state where I can still edit it,
// not show two progress bars"). They wait here, above the composer, and go in
// order when tethr finishes; until one starts you can change its words or take
// it back. The transcript shows only what tethr has started on.

/** A person's messages still waiting behind a turn that's running in the same chat. */
export function waitingBehind(runs: TethrChatRun[], terminal: Set<string>): TethrChatRun[] {
  const firstActive = runs.findIndex((r) => !terminal.has(r.status));
  if (firstActive < 0) return [];
  return runs.slice(firstActive + 1).filter((r) => r.status === "queued" && r.invocationSource === "chat" && r.sourceKey === null);
}

export function QueuedTray({
  runs,
  sending,
  companyId,
  threadId,
}: {
  runs: TethrChatRun[];
  /** A message on its way to the server (it has no id yet, so it can't be edited). */
  sending: string | null;
  companyId: string;
  threadId: string;
}) {
  if (!runs.length && sending === null) return null;
  const count = runs.length + (sending === null ? 0 : 1);
  return (
    <div className="shrink-0 px-3 pt-1 md:px-6">
      <div className="tethr-panel mx-auto w-full max-w-3xl rounded-[16px] px-3 py-2.5" aria-label="Queued messages">
        <p className="tethr-eyebrow pb-1.5">
          {count} queued · {count === 1 ? "sends" : "send in order"} when tethr finishes
        </p>
        <ul className="divide-y divide-[var(--tethr-rim)]">
          {runs.map((run) => (
            <QueuedRow key={run.id} run={run} companyId={companyId} threadId={threadId} />
          ))}
          {sending !== null ? (
            <li className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
              <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{sending || "Attached files"}</span>
              <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">adding…</span>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

function QueuedRow({ run, companyId, threadId }: { run: TethrChatRun; companyId: string; threadId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, threadId) });
  const save = useMutation({
    mutationFn: (text: string) => tethrApi.editQueuedTurn(companyId, run.id, text),
    onSuccess: () => setDraft(null),
    // Refused once it has started: the transcript now shows it.
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: () => tethrApi.removeQueuedTurn(companyId, run.id), onSettled: refresh });
  const error = save.error ?? remove.error;
  const files = run.attachments?.length ?? 0;
  const iconButton =
    "tethr-touch-sized grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--tethr-frost-strong)] hover:text-foreground disabled:opacity-40 pointer-coarse:h-9 pointer-coarse:w-9";

  if (draft !== null) {
    return (
      <li className="py-2">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) save.mutate(draft.trim());
          }}
        >
          <textarea
            autoFocus
            rows={Math.min(6, Math.max(2, draft.split("\n").length))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (enterSends(e)) {
                e.preventDefault();
                if (draft.trim()) save.mutate(draft.trim());
              }
            }}
            aria-label="Edit the queued message"
            className="tethr-inset w-full resize-none px-3 py-2 text-[13.5px] leading-5 outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            {error ? <span className="mr-auto text-[12px] text-[var(--tethr-bad)]">{error instanceof Error ? error.message : "That didn't save."}</span> : null}
            <button type="button" onClick={() => setDraft(null)} className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]">
              Cancel
            </button>
            <button type="submit" disabled={!draft.trim() || save.isPending} className="tethr-btn tethr-btn-primary h-8 px-4 text-[12.5px]">
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li className="py-2">
      <div className="flex items-start gap-1.5">
        <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap pt-1 text-[13.5px] leading-5 [overflow-wrap:anywhere]">
          {run.requestText}
          {files ? (
            <span className="ml-2 inline-flex items-center gap-1 align-middle font-mono text-[10.5px] tethr-text-3">
              <Paperclip className="h-3 w-3" />
              {files}
            </span>
          ) : null}
        </span>
        <button type="button" onClick={() => setDraft(run.requestText)} aria-label="Edit this queued message" title="Edit" className={iconButton}>
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} aria-label="Remove this queued message" title="Remove" className={iconButton}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error ? <p className="pt-1 text-[12px] text-[var(--tethr-bad)]">{error instanceof Error ? error.message : "That didn't work."}</p> : null}
    </li>
  );
}
