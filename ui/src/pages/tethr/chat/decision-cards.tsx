import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, ChevronDown, CornerUpLeft, Lock, MessageCircleQuestion, Pause, Plug, Send } from "lucide-react";
import { StatusDot, formatRelative } from "@/components/tethr/primitives";
import { refreshAfterDecision, tethrApi, tethrKeys, type TethrChatOutput, type TethrQuestion } from "@/api/tethr";
import { cardDetails, cardHeading, decidedLine, previewText } from "@/lib/tethr-cards";
import { cn } from "@/lib/utils";
import { DoneCheck } from "@/components/tethr/DoneCheck";
import { Link } from "../../../lib/router";
import { fixForConnection } from "../setup/fixes";
import { FixPanel } from "../setup/FixPanel";
import { enterSends } from "@/lib/tethr-composer";

// The cards that wait on a person, in one look (Mark, 2026-11-10: "the agent
// approval card is beautiful so stick with that design"): an approval (a new
// agent, an outward action), and a question tethr or an agent asks with
// buttons, and a connection an agent can't run without, with the fix in place.
// Used in the chat and on the Needs you page. What a card says it wants comes
// from lib/tethr-cards.ts, so it reads the same everywhere.

const CARD = "tethr-glass flex max-w-2xl flex-col gap-2.5 p-4";
const PRIMARY = "tethr-btn tethr-btn-primary h-8 px-4 text-[12.5px]";
const GHOST = "tethr-btn tethr-btn-ghost h-8 px-3.5 text-[12.5px]";
const GLASS = "tethr-btn tethr-btn-glass h-8 px-3.5 text-[12.5px]";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// ---- done: a card that has just been answered ---------------------------------

/** How long the check shows before the lists refresh and the card leaves (or folds to its record). */
const DONE_HOLD_MS = 1500;

/** The answered card: a check that draws itself and what happened, in a line. */
function DoneCard({ label }: { label: string }) {
  return (
    <div className={cn(CARD, "tethr-done-card")} role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <DoneCheck className="h-7 w-7 shrink-0 text-foreground" />
        <p className="min-w-0 text-[13.5px] font-medium leading-snug [overflow-wrap:anywhere]">{label}</p>
      </div>
    </div>
  );
}

/**
 * Show the check, then refresh. The refresh waits so the check is seen, and it
 * isn't cancelled if the card goes away first (every list that shows the card
 * still has to catch up).
 */
function useDone(refresh: () => void): [string | null, (label: string) => void] {
  const [done, setDone] = useState<string | null>(null);
  const finish = (label: string) => {
    setDone(label);
    window.setTimeout(refresh, DONE_HOLD_MS);
  };
  return [done, finish];
}

// ---- approvals -------------------------------------------------------------------

/** A gated item, decided where you see it. `threadId` is the chat to talk to about it (none: no Comment). */
export function ApprovalCard({ output, companyId, threadId, from }: { output: TethrChatOutput; companyId: string; threadId: string; /** Who asked, where the card is shown away from its chat. */ from?: string }) {
  const queryClient = useQueryClient();
  const [replying, setReplying] = useState(false);
  const [open, setOpen] = useState(false);
  const refresh = () => {
    if (threadId) queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, threadId) });
    refreshAfterDecision(queryClient, companyId);
  };
  const [done, finish] = useDone(refresh);
  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => tethrApi.decide(companyId, output.id, decision),
    onSuccess: (_r, decision) => finish(`${decision === "approve" ? (isAction ? "Approved, running now" : "Approved") : "Rejected"}: ${output.title}`),
    onError: refresh,
  });
  const snippet = useMemo(() => previewText(output.body), [output.body]);
  const details = useMemo(() => cardDetails(output.body), [output.body]);
  // An agent that would start out waiting on a connection says so on the card itself.
  const missing = details?.rows.find(([label, value]) => label === "Needs" && /not connected/.test(value))?.[1] ?? null;
  const isAction = output.kind === "external_action";
  const actionBody = isAction ? output.body.split("\n").slice(2).join("\n").trim() : "";
  if (done && (output.status === "gated" || output.status === "changes_requested")) return <DoneCard label={done} />;
  return (
    <div className={CARD}>
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <Lock className="h-3 w-3" />
        {cardHeading(output)}
        {from ? ` · ${from}` : ""}
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
      ) : open ? (
        <CardDetailsView body={output.body} details={details} />
      ) : snippet ? (
        <p className="line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{snippet}</p>
      ) : null}
      {missing && !open ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed">
          <StatusDot tone="warn" className="mt-[0.45em]" />
          <span>Needs: {missing}</span>
        </p>
      ) : null}
      {!isAction && output.body.trim() ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="-my-1 inline-flex w-fit items-center gap-1 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Hide details" : "Details"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
        </button>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" disabled={decide.isPending} onClick={() => decide.mutate("approve")} className={PRIMARY}>
          {decide.isPending && decide.variables === "approve" ? "Approving…" : isAction ? "Approve & run" : "Approve"}
        </button>
        <button type="button" disabled={decide.isPending} onClick={() => decide.mutate("reject")} className={GHOST}>
          {decide.isPending && decide.variables === "reject" ? "Rejecting…" : "Reject"}
        </button>
        {threadId ? (
          <button type="button" onClick={() => setReplying((v) => !v)} aria-expanded={replying} className={GHOST}>
            <CornerUpLeft className="h-3.5 w-3.5" />
            Comment
          </button>
        ) : null}
        <Link to={`/queue/${output.id}`} className="-my-2 ml-auto inline-flex items-center gap-1 py-2 text-[12px] text-muted-foreground hover:text-foreground">
          Open
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {decide.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{errorText(decide.error, "That didn't go through.")}</p> : null}
      {replying ? (
        <CardReply title={output.title} companyId={companyId} threadId={threadId} onSent={() => setReplying(false)} onCancel={() => setReplying(false)} />
      ) : null}
    </div>
  );
}

/** Everything on the card, in place: an agent's spec as labelled rows, anything else as its whole text.
 * Plain text throughout, never Markdown: it shows exactly what was written. */
function CardDetailsView({ body, details }: { body: string; details: ReturnType<typeof cardDetails> }) {
  if (!details) {
    return <pre className="tethr-inset max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words px-3.5 py-3 font-sans text-[13px] leading-relaxed">{body.trim()}</pre>;
  }
  return (
    <div className="tethr-inset max-h-[32rem] space-y-3.5 overflow-y-auto px-3.5 py-3 text-[13px] leading-relaxed">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
        {details.rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="tethr-text-3">{label}</dt>
            <dd className="[overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {details.blocks.map((block, i) => (
        <div key={`${block.heading}-${i}`} className="space-y-1 border-t border-[var(--tethr-rim)] pt-3">
          {block.heading ? <p className="tethr-text-3">{block.heading}</p> : null}
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{block.text}</p>
        </div>
      ))}
    </div>
  );
}

/** A team card after its decision: one quiet line saying what happened. */
export function DecidedLine({ output }: { output: TethrChatOutput }) {
  const decided = decidedLine(output);
  if (!decided) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
      <StatusDot tone={decided.tone} />
      <span className="shrink-0 font-medium">{decided.label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{output.title}</span>
    </div>
  );
}

const REPLY_TITLE_MAX = 120;

/** Talk to tethr about a pending card: a question, or what to do instead. The
 * card stays open for you to approve or reject after its answer. */
function CardReply({ title, companyId, threadId, onSent, onCancel }: { title: string; companyId: string; threadId: string; onSent: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient();
  const about = title.length > REPLY_TITLE_MAX ? `${title.slice(0, REPLY_TITLE_MAX)}…` : title;
  const send = useMutation({
    mutationFn: (message: string) => tethrApi.sendChatMessage(companyId, threadId, `About your request "${about}": ${message}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, threadId) });
      queryClient.invalidateQueries({ queryKey: tethrKeys.chats(companyId) });
      onSent();
    },
  });
  return (
    <CommentBox
      placeholder="Ask why, or say what to do instead…"
      label="Comment to tethr about this request"
      note="This stays open until you approve or reject it."
      pending={send.isPending}
      error={send.isError ? errorText(send.error, "That didn't send.") : null}
      onSend={(message) => send.mutate(message)}
      onCancel={onCancel}
    />
  );
}

/** The free-text box under a card. */
export function CommentBox({
  placeholder,
  label,
  note,
  pending,
  error,
  onSend,
  onCancel,
}: {
  placeholder: string;
  label: string;
  note: string;
  pending: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const message = text.trim();
    if (message && !pending) onSend(message);
  };
  return (
    <form
      className="tethr-fix-panel flex flex-col gap-2 border-t border-[var(--tethr-rim)] pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (enterSends(e)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder={placeholder}
        aria-label={label}
        className="tethr-inset min-h-[60px] w-full resize-none px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-[11.5px] tethr-text-3">{note}</span>
        <button type="button" onClick={onCancel} className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12px]">
          Cancel
        </button>
        <button type="submit" disabled={!text.trim() || pending} className="tethr-btn tethr-btn-primary h-8 px-3.5 text-[12px]">
          <Send className="h-3.5 w-3.5" />
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
      {error ? <p className="text-[12px] text-[var(--tethr-bad)]">{error}</p> : null}
    </form>
  );
}

// ---- questions -------------------------------------------------------------------

/** How an answered question reads, in a few words. */
export function answeredWords(q: TethrQuestion): string {
  const a = q.answer;
  if (!a) return "";
  if (q.connection) {
    if (a.choice === "without") return "You said to carry on without it";
    if (a.choice === "grant_auto") return "You gave it access, on its own";
    if (a.choice === "grant") return "You gave it access, asking each time";
    // tethr closes the card itself when it can see the connection is there.
    return a.by === "tethr" ? "Connected" : "You connected it";
  }
  if (a.via === "chat") return "You answered in the chat";
  if (!q.options && a.choice === "approve") return "You approved";
  if (!q.options && a.choice === "reject") return "You rejected";
  if (a.choice) return `You chose "${a.choice}"`;
  return "You commented";
}

/**
 * A question tethr or an agent asks with buttons, instead of in prose: Approve
 * / Reject / Comment, or a button per choice. Answering sends the answer into
 * the chat it was asked in as your own message. It approves nothing by itself.
 * Its text is shown as plain text.
 */
export function QuestionCard({ question, companyId, from }: { question: TethrQuestion; companyId: string; /** Where it was asked, when shown away from its chat. */ from?: string }) {
  const queryClient = useQueryClient();
  const [commenting, setCommenting] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, question.threadId) });
    refreshAfterDecision(queryClient, companyId);
  };
  const [done, finish] = useDone(refresh);
  const who = question.agentTag ?? "tethr";
  const answer = useMutation({
    mutationFn: (body: { choice?: string; comment?: string }) => tethrApi.answerQuestion(companyId, question.id, body),
    onSuccess: (_r, body) => {
      setCommenting(false);
      finish(
        body.choice === "approve" && !question.options
          ? `Approved. ${who} carries on.`
          : body.choice === "reject" && !question.options
            ? `Rejected. ${who} knows.`
            : body.choice
              ? `Sent "${body.choice}" to ${who}.`
              : `Your answer went to ${who}.`,
      );
    },
    onError: refresh,
  });

  if (done && question.status === "open") return <DoneCard label={done} />;
  if (question.status === "open" && question.connection) return <ConnectionCard question={question} connection={question.connection.key} companyId={companyId} from={from} />;
  if (question.status !== "open") {
    return (
      <div className="flex min-w-0 max-w-2xl flex-col gap-1 text-[12.5px]">
        <span className="flex min-w-0 items-center gap-2">
          <Check className="h-3.5 w-3.5 shrink-0 tethr-text-3" />
          <span className="shrink-0 font-medium">{answeredWords(question)}</span>
          <span className="min-w-0 truncate text-muted-foreground">{question.question}</span>
          {question.answer ? <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">{formatRelative(question.answer.at)}</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className={CARD}>
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <MessageCircleQuestion className="h-3 w-3" />
        {who} asks{from ? ` · ${from}` : ""}
      </span>
      <p className="text-[14.5px] font-medium leading-snug [overflow-wrap:anywhere]">{question.question}</p>
      {question.detail ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{question.detail}</p> : null}
      {question.options ? (
        <div className="mt-1 flex flex-col gap-1.5">
          {question.options.map((option, i) => (
            <button
              key={option.label}
              type="button"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ choice: option.label })}
              className={cn("tethr-btn h-auto min-h-9 justify-start px-4 py-2 text-left text-[12.5px]", i === 0 ? "tethr-btn-primary" : "tethr-btn-glass")}
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{option.label}</span>
                {option.description ? <span className="text-[11.5px] font-normal opacity-75">{option.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {question.options ? null : (
          <>
            <button type="button" disabled={answer.isPending} onClick={() => answer.mutate({ choice: "approve" })} className={PRIMARY}>
              Approve
            </button>
            <button type="button" disabled={answer.isPending} onClick={() => answer.mutate({ choice: "reject" })} className={GHOST}>
              Reject
            </button>
          </>
        )}
        <button type="button" onClick={() => setCommenting((v) => !v)} aria-expanded={commenting} className={question.options ? GLASS : GHOST}>
          <CornerUpLeft className="h-3.5 w-3.5" />
          Comment
        </button>
      </div>
      {answer.isError && !commenting ? <p className="text-[12px] text-[var(--tethr-bad)]">{errorText(answer.error, "That didn't go through.")}</p> : null}
      {commenting ? (
        <CommentBox
          placeholder="Answer in your own words…"
          label={`Answer ${who} in your own words`}
          note={`Your comment is your answer; ${who} carries on from it.`}
          pending={answer.isPending}
          error={answer.isError ? errorText(answer.error, "That didn't send.") : null}
          onSend={(comment) => answer.mutate({ comment })}
          onCancel={() => setCommenting(false)}
        />
      ) : null}
    </div>
  );
}

// ---- connections -----------------------------------------------------------------

/**
 * A connection tethr or an agent can't do its job without. The fix opens right
 * here (a key to paste, a mode to pick, or where to connect it). An agent that
 * asked isn't running, and isn't spending, until this is answered: connected,
 * or told to carry on without it.
 */
function ConnectionCard({ question, connection, companyId, from }: { question: TethrQuestion; connection: string; companyId: string; from?: string }) {
  const queryClient = useQueryClient();
  const [fixing, setFixing] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: tethrKeys.chatRuns(companyId, question.threadId) });
    refreshAfterDecision(queryClient, companyId);
  };
  const [done, finish] = useDone(refresh);
  const agent = question.agentTag ?? "tethr";
  const answer = useMutation({
    mutationFn: (choice: "connected" | "without" | "grant" | "grant_auto") => tethrApi.answerQuestion(companyId, question.id, { choice }),
    onSuccess: (_r, choice) =>
      finish(
        choice === "grant_auto"
          ? `${agent} has ${connection} now, and changes run on their own.`
          : choice === "grant"
            ? `${agent} has ${connection} now; each change asks first.`
            : choice === "without"
              ? `${agent} carries on without ${connection}.`
              : `Marked connected. ${agent} picks up again.`,
      ),
    onError: refresh,
  });
  // A key or a mode saved from the fix: tethr re-checks, and closes this itself if that was all it needed.
  const recheck = useMutation({ mutationFn: () => tethrApi.recheckConnections(companyId), onSettled: refresh });
  const pause = useMutation({
    mutationFn: () => tethrApi.setTeamAgentPaused(companyId, question.agentTag!, true),
    onSuccess: () => finish(`Paused ${agent}.`),
    onError: refresh,
  });
  const busy = answer.isPending || pause.isPending;
  const error = answer.error ?? pause.error;
  const pressed = (choice: string, label: string, busyLabel: string) => (answer.isPending && answer.variables === choice ? busyLabel : label);
  if (done) return <DoneCard label={done} />;
  // The connection works for the company; this agent just isn't given it.
  if (question.access && question.agentTag) {
    return (
      <div className={CARD}>
        <span className="tethr-eyebrow inline-flex items-center gap-1.5">
          <Plug className="h-3 w-3" />
          {question.agentTag} needs access{from ? ` · ${from}` : ""}
        </span>
        <p className="text-[14.5px] font-medium leading-snug">
          Give {question.agentTag} {connection}?
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {connection} is connected and working; {question.agentTag} just isn't allowed to use it yet. Nothing else needs setting up.
        </p>
        {question.detail ? <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed tethr-text-3 [overflow-wrap:anywhere]">{question.detail}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={() => answer.mutate("grant_auto")} className={PRIMARY}>
            {pressed("grant_auto", "Give access, on its own", "Giving access…")}
          </button>
          <button type="button" disabled={busy} onClick={() => answer.mutate("grant")} className={GLASS}>
            {pressed("grant", "Give access, ask each time", "Giving access…")}
          </button>
          <button type="button" disabled={busy} onClick={() => answer.mutate("without")} className={GHOST}>
            Carry on without it
          </button>
        </div>
        <p className="text-[11.5px] leading-snug tethr-text-3">
          "On its own": changes run without asking; spending, outside people and deletes still ask until you change them in {question.agentTag}'s settings.
        </p>
        {error ? <p className="text-[12px] text-[var(--tethr-bad)]">{errorText(error, "That didn't go through.")}</p> : null}
      </div>
    );
  }
  return (
    <div className={CARD}>
      <span className="tethr-eyebrow inline-flex items-center gap-1.5">
        <Plug className="h-3 w-3" />
        {question.agentTag ? `${question.agentTag} is waiting on a connection` : "tethr needs a connection"}
        {from ? ` · ${from}` : ""}
      </span>
      <p className="text-[14.5px] font-medium leading-snug">{question.agentTag ? question.question : `Connect ${connection}`}</p>
      {question.detail ? <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{question.detail}</p> : null}
      {fixing ? <FixPanel fix={fixForConnection(connection)} companyId={companyId} onFixed={() => recheck.mutate()} /> : null}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setFixing((v) => !v)} aria-expanded={fixing} className={fixing ? GHOST : PRIMARY}>
          {fixing ? "Hide the fix" : `Connect ${connection}`}
        </button>
        <button type="button" disabled={busy} onClick={() => answer.mutate("connected")} className={GLASS}>
          I've connected it
        </button>
        <button type="button" disabled={busy} onClick={() => answer.mutate("without")} className={GHOST}>
          Carry on without it
        </button>
        {question.agentTag ? (
          <button type="button" disabled={busy} onClick={() => pause.mutate()} className={GHOST}>
            <Pause className="h-3.5 w-3.5" />
            Pause {question.agentTag}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[12px] text-[var(--tethr-bad)]">{errorText(error, "That didn't go through.")}</p> : null}
    </div>
  );
}
