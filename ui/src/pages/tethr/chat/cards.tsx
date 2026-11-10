import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Inbox } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusDot, formatRelative } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrChatRun } from "@/api/tethr";
import { Link } from "@/lib/router";
import { InboxItemActions } from "../drive/InboxView";

// Phase 26.3-26.6: cards tethr puts in the main chat on its own. An Inbox file
// with Jev's suggestion (file it, somewhere else, tell someone); a lesson to
// apply or turn down; and Jev's "needs you now / can wait" on an agent's report,
// which you can correct (that's how its confidence bar learns).

const refreshChat = (queryClient: ReturnType<typeof useQueryClient>, companyId: string, threadId: string | null) =>
  queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, threadId ?? "") });

export function InboxCard({ run, companyId }: { run: TethrChatRun; companyId: string }) {
  const item = run.inbox ?? null;
  const { data } = useQuery({ queryKey: tethrKeys.inbox(companyId), queryFn: () => tethrApi.inbox(companyId), enabled: !!item });
  return (
    <div className="tethr-glass space-y-2.5 rounded-[16px] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11.5px] tethr-text-3">
        <Inbox className="h-3.5 w-3.5" />
        <span className="min-w-0 truncate">A file came into tethr's Inbox{item ? ` from ${item.source === "drive" ? "the Drive" : item.source === "slack" ? "Slack" : "the chat"}` : ""}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">{formatRelative(run.createdAt)}</span>
      </div>
      <p className="truncate text-[14px] font-medium">{item?.name ?? run.requestText.replace(/^Inbox · /, "")}</p>
      {item ? (
        <InboxItemActions item={item} companyId={companyId} folders={data?.folders ?? []} compact />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">{run.resultText}</p>
      )}
      <Link to="/drive?view=inbox" className="inline-block text-[12px] tethr-text-3 underline-offset-2 hover:underline">
        Open the Inbox
      </Link>
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  applied: "Applied",
  kept: "Kept",
  retired: "Retired",
  rejected: "Not for us",
};

export function LessonCard({ run, companyId }: { run: TethrChatRun; companyId: string }) {
  const queryClient = useQueryClient();
  const lesson = run.lesson ?? null;
  const [reason, setReason] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSettled: () => {
      void refreshChat(queryClient, companyId, run.threadId);
      void queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) });
    },
  });
  const done = lesson ? STATUS_TEXT[lesson.status] : null;
  const origin = run.requestText.replace(/^Lesson · /, "");
  return (
    <div className="tethr-glass space-y-2.5 rounded-[16px] px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11.5px] tethr-text-3">
        <BookOpen className="h-3.5 w-3.5" />
        <span className="min-w-0 truncate">Lesson · {origin}</span>
        {lesson?.composite !== null && lesson?.composite !== undefined ? <span className="font-mono text-[10.5px]">score {lesson.composite}</span> : null}
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">{formatRelative(run.createdAt)}</span>
      </div>
      <MarkdownBody className="tethr-chat-md">{run.resultText ?? ""}</MarkdownBody>
      {lesson ? (
        done ? (
          <p className="flex items-center gap-1.5 text-[12.5px] tethr-text-3">
            <StatusDot tone={lesson.status === "rejected" || lesson.status === "retired" ? "idle" : "ok"} />
            {done}
            {lesson.applied ? ` as ${lesson.applied.as}${lesson.reviewAt ? `; reviewed ${new Date(lesson.reviewAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}` : ""}
          </p>
        ) : reason !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why not? (optional, e.g. we don't cold call)"
              className="tethr-inset h-8 min-w-0 flex-1 rounded-[10px] px-2.5 text-[13px]"
              aria-label="Why it's not for us"
            />
            <button type="button" disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.rejectLesson(companyId, lesson.id, reason || undefined))} className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]">
              Not for us
            </button>
            <button type="button" onClick={() => setReason(null)} className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px]">
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.applyLesson(companyId, lesson.id))} className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[12.5px]">
              Apply
            </button>
            <button type="button" disabled={act.isPending} onClick={() => setReason("")} className="tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]">
              Not for us
            </button>
            <span className="text-[11.5px] tethr-text-3">
              Applied, it becomes {lesson.applyAs === "procedure" ? "a skill" : lesson.applyAs === "experiment" ? "an experiment with a review date" : lesson.applyAs === "rule" ? "a rule" : "a note"}. Reply below to discuss it.
            </span>
          </div>
        )
      ) : null}
      {act.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(act.error as Error).message}</p> : null}
    </div>
  );
}

/** Jev's call on an agent's report, and the person's answer to it. */
export function UrgencyRow({ run, companyId }: { run: TethrChatRun; companyId: string }) {
  const queryClient = useQueryClient();
  const u = run.urgency;
  const answer = useMutation({
    mutationFn: (a: string) => tethrApi.answerDecision(companyId, u!.id, a),
    onSettled: () => refreshChat(queryClient, companyId, run.threadId),
  });
  if (!u) return null;
  const answered = u.outcome !== "pending" && u.outcome !== "automatic";
  const final = u.outcome === "corrected" || u.outcome === "undone" ? (u.correctedTo ?? u.pick) : u.pick;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] tethr-text-3">
      <span>
        Jev: {u.pick}
        {u.outcome === "automatic" ? " (the Slack message was held for the daily review)" : ""}
      </span>
      {answered ? (
        <span>· you said {final}</span>
      ) : (
        u.options.map((o) => (
          <button key={o} type="button" disabled={answer.isPending} onClick={() => answer.mutate(o)} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[11.5px]">
            {o === u.pick ? "Right" : `It ${o}`}
          </button>
        ))
      )}
    </div>
  );
}

/** "File this": a copy of a chat upload goes to tethr's Inbox. */
export function FileThisButton({ path, companyId }: { path: string; companyId: string }) {
  const queryClient = useQueryClient();
  const take = useMutation({
    mutationFn: () => tethrApi.fileThis(companyId, path),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.inbox(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "chats"] });
    },
  });
  return (
    <button
      type="button"
      disabled={take.isPending || take.isSuccess}
      onClick={() => take.mutate()}
      title={take.isError ? (take.error as Error).message : "Send a copy to tethr's Inbox to file"}
      className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[11.5px]"
    >
      {take.isSuccess ? "In the Inbox" : take.isError ? "Couldn't file it" : "File this"}
    </button>
  );
}
