import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, CornerUpLeft, ListChecks } from "lucide-react";
import { formatRelative } from "@/components/tethr/primitives";
import { refreshAfterDecision, tethrApi, tethrKeys, type TethrChecklist } from "@/api/tethr";
import { checklistProgress, checklistQuestionText } from "@/lib/tethr-cards";
import { cn } from "@/lib/utils";
import { CommentBox } from "./decision-cards";

// A checklist tethr or an agent hands the person for something only they can do
// outside tethr (Mark, 2026-11-10: "develop a way to help me get it set up like a
// checklist… this isn't helpful"): the steps in order, the exact values to paste,
// ticked off as they go. Ticking the last one tells the chat, so tethr can check
// it took. Same card look as the approvals; its text is shown as plain text.

const CARD = "tethr-glass flex max-w-2xl flex-col gap-3 p-4";
const GHOST = "tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]";

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(null), 1_800);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  };
  return (
    <div className="tethr-inset relative mt-1.5">
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words px-3 py-2 pr-20 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere]">{text}</pre>
      <button
        type="button"
        onClick={copy}
        className="tethr-btn tethr-btn-glass tethr-touch-sized absolute right-1.5 top-1.5 h-7 px-2.5 text-[11.5px]"
        aria-label="Copy this text"
      >
        {copied === "yes" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied === "yes" ? "Copied" : copied === "no" ? "Select it" : "Copy"}
      </button>
    </div>
  );
}

/** A finished or put-away checklist: one line, and its steps on a tap. */
function ClosedChecklist({ checklist }: { checklist: TethrChecklist }) {
  const [open, setOpen] = useState(false);
  const done = checklist.status === "done";
  return (
    <div className="flex min-w-0 max-w-2xl flex-col gap-1.5 text-[12.5px]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 items-center gap-2 text-left">
        {done ? <Check className="h-3.5 w-3.5 shrink-0 tethr-text-3" /> : <ListChecks className="h-3.5 w-3.5 shrink-0 tethr-text-3" />}
        <span className="shrink-0 font-medium">{done ? "Done" : "Put away"}</span>
        <span className="min-w-0 truncate text-muted-foreground">{checklist.title}</span>
        {checklist.doneAt ? <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">{formatRelative(checklist.doneAt)}</span> : null}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 tethr-text-3 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <ol className="ml-5 list-decimal space-y-1 text-[12.5px] text-muted-foreground">
          {checklist.steps.map((s) => (
            <li key={s.id} className={cn(s.done && "line-through decoration-[var(--tethr-rim)]")}>
              {s.do}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** A step-by-step job for the person, ticked off as they go. `from` names where it came from, shown away from its chat. */
export function ChecklistCard({ checklist, companyId, from }: { checklist: TethrChecklist; companyId: string; from?: string }) {
  const queryClient = useQueryClient();
  // Ticks show at once; the server's copy wins when it comes back.
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  useEffect(() => setTicks({}), [checklist]);
  const steps = checklist.steps.map((s) => ({ ...s, done: ticks[s.id] ?? s.done }));
  const progress = checklistProgress(steps);
  const who = checklist.agentTag ?? "tethr";
  const [asking, setAsking] = useState(false);
  const [confirmPutAway, setConfirmPutAway] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, checklist.threadId) });
    refreshAfterDecision(queryClient, companyId);
  };
  const tick = useMutation({
    mutationFn: ({ stepId, done }: { stepId: string; done: boolean }) => tethrApi.tickChecklistStep(companyId, checklist.id, stepId, done),
    onMutate: ({ stepId, done }) => setTicks((t) => ({ ...t, [stepId]: done })),
    onError: (_e, { stepId }) =>
      setTicks((t) => {
        const next = { ...t };
        delete next[stepId];
        return next;
      }),
    onSettled: refresh,
  });
  const putAway = useMutation({ mutationFn: () => tethrApi.dismissChecklist(companyId, checklist.id), onSettled: refresh });
  const ask = useMutation({
    mutationFn: (message: string) => tethrApi.sendChatMessage(companyId, checklist.threadId, checklistQuestionText(checklist.title, progress.next >= 0 ? progress.next : null, message)),
    onSuccess: () => {
      setAsking(false);
      queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, checklist.threadId) });
    },
  });

  if (checklist.status !== "open") return <ClosedChecklist checklist={checklist} />;
  const allTicked = progress.done === progress.total;
  return (
    <div className={CARD}>
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <ListChecks className="h-3 w-3" />
        {/* Away from its chat (Needs you) the group already says "For you to do": say where it's from instead. */}
        {[from ? null : "For you to do", checklist.agentTag ? `from ${who}` : null, from].filter(Boolean).join(" · ")}
      </span>
      <div className="space-y-1">
        <p className="text-[14.5px] font-medium leading-snug [overflow-wrap:anywhere]">{checklist.title}</p>
        {checklist.why ? <p className="text-[13px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{checklist.why}</p> : null}
      </div>
      <div className="flex items-center gap-3" aria-label={`${progress.done} of ${progress.total} steps done`}>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--tethr-rim)]">
          <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
        <span className="shrink-0 font-mono text-[11px] tethr-text-3">
          {progress.done} of {progress.total}
        </span>
      </div>
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const isNext = i === progress.next;
          return (
            <li key={step.id} className={cn("flex gap-3 border-t border-[var(--tethr-rim)] py-2.5 first:border-t-0 first:pt-0.5")}>
              <button
                type="button"
                role="checkbox"
                aria-checked={step.done}
                aria-label={`Step ${i + 1}: ${step.do}`}
                disabled={tick.isPending && tick.variables?.stepId === step.id}
                onClick={() => tick.mutate({ stepId: step.id, done: !step.done })}
                className={cn(
                  "tethr-touch-sized mt-px grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full transition-colors pointer-coarse:h-7 pointer-coarse:w-7",
                  step.done
                    ? "bg-foreground text-background"
                    : isNext
                      ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]"
                      : "shadow-[inset_0_0_0_1px_var(--tethr-rim-strong,var(--tethr-rim))]",
                )}
              >
                {step.done ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <span className="font-mono text-[10px] tethr-text-3">{i + 1}</span>}
              </button>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[13.5px] leading-snug [overflow-wrap:anywhere]", step.done && "text-muted-foreground line-through decoration-[var(--tethr-rim)]")}>
                  {step.do}
                  {isNext && progress.done > 0 ? <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.08em] tethr-text-3">next</span> : null}
                </p>
                {step.detail && !step.done ? <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{step.detail}</p> : null}
                {step.copy && !step.done ? <CopyBlock text={step.copy} /> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {allTicked ? <p className="text-[12.5px] text-muted-foreground">All done. {who} is checking it took.</p> : null}
      {tick.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{tick.error instanceof Error ? tick.error.message : "That didn't save."}</p> : null}
      {confirmPutAway ? (
        <div className="tethr-fix-panel flex flex-wrap items-center gap-2 border-t border-[var(--tethr-rim)] pt-3">
          <span className="mr-auto text-[12.5px] text-muted-foreground">Put this away unfinished? It leaves Needs you, and {who} won't bring it up again.</span>
          <button type="button" onClick={() => setConfirmPutAway(false)} className={GHOST}>
            Keep it
          </button>
          <button type="button" disabled={putAway.isPending} onClick={() => putAway.mutate()} className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[12.5px]">
            Put it away
          </button>
        </div>
      ) : null}
      {asking ? (
        <CommentBox
          placeholder={progress.next >= 0 ? `Ask about step ${progress.next + 1}, or anything on this…` : "Ask about this checklist…"}
          label={`Ask ${who} about this checklist`}
          note="The checklist stays here; tick steps as you go."
          pending={ask.isPending}
          error={ask.isError ? (ask.error instanceof Error ? ask.error.message : "That didn't send.") : null}
          onSend={(message) => ask.mutate(message)}
          onCancel={() => setAsking(false)}
        />
      ) : null}
      {!asking && !confirmPutAway && !allTicked ? (
        <div className="-ml-1 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setAsking(true)} className={GHOST}>
            <CornerUpLeft className="h-3.5 w-3.5" />
            Ask {who}
          </button>
          <button type="button" onClick={() => setConfirmPutAway(true)} className={cn(GHOST, "tethr-text-3")}>
            Not now
          </button>
        </div>
      ) : null}
    </div>
  );
}
