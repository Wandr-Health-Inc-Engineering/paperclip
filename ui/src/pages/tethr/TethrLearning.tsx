import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { tethrApi, tethrKeys, type TethrLesson } from "@/api/tethr";
import { cn } from "@/lib/utils";

// The Learning page (phase 26.5-26.6): everything tethr learned, in one
// record. What's waiting for you, what's applied (and where), what the review
// said, what was kept or retired; the learner's queue; which sources have
// earned trust; and how often each kind of Jev decision was right.

const AS_TEXT: Record<string, string> = { memory: "a note", skill: "a skill", rule: "a rule", experiment: "an experiment" };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

function LessonRow({ lesson, companyId }: { lesson: TethrLesson; companyId: string }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<string | null>(null);
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn(), onSettled: () => queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) }) });
  const due = lesson.status === "applied" && lesson.reviewAt && new Date(lesson.reviewAt).getTime() <= Date.now();
  const btn = "tethr-btn h-8 px-3 text-[12.5px]";
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] tethr-text-3">{lesson.areaName ?? lesson.area}</span>
        <span className="font-mono text-[10.5px] tethr-text-3">
          from {lesson.proposedBy} · {formatRelative(lesson.createdAt)}
          {lesson.composite !== null ? ` · score ${lesson.composite}` : ""}
        </span>
      </div>
      <p className="text-[13.5px] leading-snug">{lesson.lesson}</p>
      {lesson.howToApply ? <p className="text-[12.5px] text-muted-foreground">How: {lesson.howToApply}</p> : null}
      {lesson.sources.length ? (
        <p className="text-[12px] text-muted-foreground">
          {lesson.sources.map((s, i) => (
            <span key={s.url}>
              {i ? ", " : ""}
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
                {s.title}
              </a>
            </span>
          ))}
        </p>
      ) : null}
      {lesson.status === "applied" ? (
        <p className="text-[12px] tethr-text-3">
          Applied as {AS_TEXT[lesson.applied?.as ?? ""] ?? lesson.applied?.as} on {day(lesson.applied?.at ?? null)} · review {day(lesson.reviewAt)}
        </p>
      ) : null}
      {lesson.verdict ? (
        <p className="text-[12.5px]">
          tethr suggests {lesson.verdict === "kept" ? "keeping" : "retiring"} it{lesson.outcome ? `: ${lesson.outcome}` : "."}
        </p>
      ) : null}
      {(lesson.status === "rejected" || lesson.status === "retired" || lesson.status === "kept") && lesson.outcome ? (
        <p className="text-[12px] text-muted-foreground">{lesson.outcome}</p>
      ) : null}
      {lesson.status === "candidate" || lesson.status === "proposed" ? (
        reason !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why not? (optional)" aria-label="Why it's not for us" className="tethr-inset h-8 min-w-0 flex-1 rounded-[10px] px-2.5 text-[13px]" />
            <button type="button" className={cn(btn, "tethr-btn-glass")} disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.rejectLesson(companyId, lesson.id, reason || undefined))}>
              Not for us
            </button>
            <button type="button" className={cn(btn, "tethr-btn-ghost")} onClick={() => setReason(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cn(btn, "tethr-btn-primary")} disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.applyLesson(companyId, lesson.id))}>
              Apply
            </button>
            <button type="button" className={cn(btn, "tethr-btn-ghost")} onClick={() => setReason("")}>
              Not for us
            </button>
            {lesson.status === "candidate" ? (
              <button type="button" className={cn(btn, "tethr-btn-ghost")} disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.offerLesson(companyId, lesson.id))}>
                Put it in the chat
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {lesson.status === "applied" && (lesson.verdict || due) ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cn(btn, lesson.verdict === "kept" ? "tethr-btn-primary" : "tethr-btn-glass")} disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.settleLesson(companyId, lesson.id, true))}>
            Keep it
          </button>
          <button type="button" className={cn(btn, lesson.verdict === "retired" ? "tethr-btn-primary" : "tethr-btn-glass")} disabled={act.isPending} onClick={() => act.mutate(() => tethrApi.settleLesson(companyId, lesson.id, false))}>
            Retire it
          </button>
        </div>
      ) : null}
      {act.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(act.error as Error).message}</p> : null}
    </div>
  );
}

function Group({ title, hint, lessons, companyId, collapsed = false }: { title: string; hint?: string; lessons: TethrLesson[]; companyId: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(!collapsed);
  if (!lessons.length) return null;
  return (
    <section className="tethr-panel overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 border-b tethr-rule px-4 py-3 text-left">
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        <span className="ml-auto font-mono text-[11px] tethr-text-3">{lessons.length}</span>
      </button>
      {open ? (
        <>
          {hint ? <p className="border-b tethr-rule px-4 py-2 text-[12px] text-muted-foreground">{hint}</p> : null}
          <div className="divide-y divide-[var(--tethr-rim)]">
            {lessons.map((l) => (
              <LessonRow key={l.id} lesson={l} companyId={companyId} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function TethrLearning() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [topic, setTopic] = useState("");
  useEffect(() => {
    setBreadcrumbs([{ label: "Learning" }]);
  }, [setBreadcrumbs]);
  const c = selectedCompanyId!;
  const { data, isLoading } = useQuery({ queryKey: tethrKeys.learning(c), queryFn: () => tethrApi.learning(c), enabled: !!selectedCompanyId, refetchInterval: 30_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: tethrKeys.learning(c) });
  const queue = useMutation({ mutationFn: () => tethrApi.queueStudy(c, topic), onSuccess: () => setTopic(""), onSettled: refresh });
  const drop = useMutation({ mutationFn: (i: number) => tethrApi.dropStudy(c, i), onSettled: refresh });
  if (isLoading || !data) return <PageSkeleton />;

  const by = (statuses: string[]) => data.lessons.filter((l) => statuses.includes(l.status));
  const waiting = by(["proposed", "candidate"]).sort((a, b) => (a.status === "proposed" ? -1 : 0) - (b.status === "proposed" ? -1 : 0) || (b.composite ?? 0) - (a.composite ?? 0));
  const applied = by(["applied"]);
  return (
    <div className="space-y-5">
      <p className="max-w-[70ch] text-[13px] text-muted-foreground">
        What tethr learned, from you, from results and from the world, in one record. Only you apply a lesson: it becomes a note, a skill, a rule or an
        experiment, and the Friday scorecard checks whether it held.
      </p>

      <section className="tethr-panel flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={data.learner.enabled ? "ok" : "idle"} />
            The learner is {data.learner.enabled ? "on" : "off"}
            {data.learner.agent ? <span className="font-mono text-[12px] tethr-text-3">{data.learner.agent.tag}</span> : null}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            It studies distribution, sales and customer experience from public sources, one area a week, in a sealed folder.{" "}
            <Link to="/tethr-settings" className="underline-offset-2 hover:underline">
              Switch it in Integrations
            </Link>
            .
          </p>
        </div>
        {data.learner.agent ? (
          <Link to={`/chat?chat=${data.learner.agent.threadId}`} className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]">
            Its chat
          </Link>
        ) : null}
      </section>

      <Group title="Waiting for you" hint="Cards in the chat first, then the rest by score." lessons={waiting} companyId={c} />
      <Group title="Applied" hint="Each one is reviewed on its date: tethr reads the number and suggests keeping or retiring it." lessons={applied} companyId={c} />
      <Group title="Kept" lessons={by(["kept"])} companyId={c} collapsed />
      <Group title="Retired" lessons={by(["retired"])} companyId={c} collapsed />
      <Group title="Not for us" lessons={by(["rejected"])} companyId={c} collapsed />
      {!data.lessons.length ? <div className="tethr-empty px-6 py-8 text-center text-[13px]">No lessons yet. They come from the learner, and from tethr when you correct it in the chat.</div> : null}

      <section className="tethr-panel space-y-2 p-4">
        <MonoTag>study next</MonoTag>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (topic.trim().length >= 5) queue.mutate();
          }}
        >
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. how telehealth companies run referral programs" aria-label="A topic to study" className="tethr-inset h-9 min-w-0 flex-1 rounded-[10px] px-3 text-[13px]" />
          <button type="submit" disabled={topic.trim().length < 5 || queue.isPending} className="tethr-btn tethr-btn-glass h-9 px-3.5 text-[12.5px]">
            Queue it
          </button>
        </form>
        {queue.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(queue.error as Error).message}</p> : null}
        {data.learner.queue.length ? (
          <ul className="space-y-1 text-[13px]">
            {data.learner.queue.map((q, i) => (
              <li key={`${q.at}-${i}`} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{q.topic}</span>
                <span className="font-mono text-[10.5px] tethr-text-3">{q.by}</span>
                <button type="button" onClick={() => drop.mutate(i)} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[11.5px]">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">Nothing queued: the learner picks the area that matters most this week.</p>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="tethr-panel overflow-hidden">
          <header className="border-b tethr-rule px-4 py-3">
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">How often Jev was right</h2>
          </header>
          <div className="divide-y divide-[var(--tethr-rim)]">
            {data.decisions.map((k) => (
              <div key={k.key} className="px-4 py-2.5">
                <p className="flex items-center gap-2 text-[13px]">
                  <span className="min-w-0 flex-1">{k.label}</span>
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] tethr-text-3">{k.mode === "auto" ? "automatic" : k.mode}</span>
                </p>
                <p className="text-[12px] text-muted-foreground">{k.backtest}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="tethr-panel overflow-hidden">
          <header className="border-b tethr-rule px-4 py-3">
            <h2 className="text-[15px] font-medium tracking-[-0.01em]">Sources</h2>
          </header>
          {data.sources.length ? (
            <div className="divide-y divide-[var(--tethr-rim)]">
              {data.sources.map((s) => (
                <p key={s.domain} className="flex items-center gap-2 px-4 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{s.domain}</span>
                  <span className="font-mono text-[11px] tethr-text-3">
                    {s.approved} applied · {s.kept} kept · {s.rejected} turned down · {s.retired} retired
                  </span>
                </p>
              ))}
            </div>
          ) : (
            <p className="px-4 py-4 text-[12.5px] text-muted-foreground">Sources earn a track record as their lessons are applied or turned down.</p>
          )}
          {data.filingRules.length ? (
            <div className="border-t tethr-rule px-4 py-3">
              <MonoTag>filing rules</MonoTag>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-muted-foreground">
                {data.filingRules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
