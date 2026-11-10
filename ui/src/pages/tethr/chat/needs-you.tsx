import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Hand, X } from "lucide-react";
import { tethrApi, tethrKeys, type TethrNeedsYou } from "@/api/tethr";
import { ApprovalCard, QuestionCard } from "./decision-cards";

// "Needs you": everything that waits on a person, in one list (Mark,
// 2026-11-10: "I don't feel the UI is really intuitive on knowing what is
// required of me"). The chat shows a pill with the count, which opens the list
// with the buttons right there; the Needs you page shows the same list.

const REFRESH_MS = 15_000;

export function useNeedsYou(companyId: string) {
  return useQuery({
    queryKey: tethrKeys.needsYou(companyId),
    queryFn: () => tethrApi.needsYou(companyId),
    enabled: !!companyId,
    refetchInterval: REFRESH_MS,
  });
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="space-y-2.5">
      <p className="tethr-eyebrow">
        {title} · {count}
      </p>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/** The cards themselves, grouped by what they want. `approvals` can be left to a caller that lists them its own way. */
export function NeedsYouList({ companyId, data, approvals = true }: { companyId: string; data: TethrNeedsYou; approvals?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <Group title="Connections to fix" count={data.connections.length}>
        {data.connections.map((q) => (
          <QuestionCard key={q.id} question={q} companyId={companyId} from={q.from} />
        ))}
      </Group>
      <Group title="Questions for you" count={data.questions.length}>
        {data.questions.map((q) => (
          <QuestionCard key={q.id} question={q} companyId={companyId} from={q.from} />
        ))}
      </Group>
      {approvals ? (
        <Group title="Approvals" count={data.approvals.length}>
          {data.approvals.map((o) => (
            <ApprovalCard key={o.id} output={o} companyId={companyId} threadId={o.threadId ?? ""} from={o.from ?? undefined} />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

export const NOTHING_NEEDS_YOU = "Nothing needs you. Approvals, questions from tethr and its agents, and missing connections show up here.";

/** The chat's pill: how many things wait on you. Opens them as a sheet, buttons and all. Hidden at zero. */
export function NeedsYouPill({ companyId }: { companyId: string }) {
  const { data } = useNeedsYou(companyId);
  const [open, setOpen] = useState(false);
  const count = data?.count ?? 0;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  // The last card was just decided: nothing left to show.
  useEffect(() => {
    if (open && data && !data.count) setOpen(false);
  }, [open, data]);

  if (!count && !open) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="tethr-glass tethr-touch-sized inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[12.5px] font-medium transition-colors hover:text-foreground"
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--tethr-warn)] opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--tethr-warn)]" />
        </span>
        {count} {count === 1 ? "needs" : "need"} you
      </button>
      {open && data
        ? // On the page body: the chat's own frame is fixed, and a sheet inside it would be laid out in that box.
          createPortal(
            <div className="tethr-scrim fixed inset-0 z-[70] flex justify-end" onClick={() => setOpen(false)}>
              <aside
                role="dialog"
                aria-label="Needs you"
                className="tethr-glass-heavy flex h-full w-full max-w-[36rem] flex-col rounded-none sm:rounded-l-[18px]"
                onClick={(e) => e.stopPropagation()}
              >
                <header className="flex items-center gap-2.5 border-b border-[var(--tethr-rim)] px-5 py-4">
                  <Hand className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-[15px] font-medium tracking-[-0.01em]">Needs you</h2>
                  <span className="font-mono text-[11px] tethr-text-3">{data.count}</span>
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="tethr-btn tethr-btn-ghost tethr-touch-sized ml-auto h-8 w-8">
                    <X className="h-4 w-4" />
                  </button>
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:px-5">
                  <NeedsYouList companyId={companyId} data={data} />
                </div>
              </aside>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
