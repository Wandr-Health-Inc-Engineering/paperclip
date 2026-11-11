import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { tethrApi, tethrKeys, type TethrLesson, type TethrStudy } from "@/api/tethr";
import { areaLabel, outcomeWords, SKILL_STATUS_WORDS, studyLine, studyTitle } from "@/lib/tethr-study";
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

/** What Sage studied, newest first: each one's outcome, and its skills with Undo. */
function StudiesSection({ studies, companyId }: { studies: TethrStudy[]; companyId: string }) {
  const queryClient = useQueryClient();
  const undo = useMutation({
    mutationFn: (v: { id: string; name: string }) => tethrApi.undoStudySkill(companyId, v.id, v.name),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) });
      void queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "chats"] });
    },
  });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="tethr-panel overflow-hidden">
      <header className="flex items-center gap-2 border-b tethr-rule px-4 py-3">
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">What Sage learned</h2>
        <span className="ml-auto font-mono text-[11px] tethr-text-3">{studies.length}</span>
      </header>
      {!studies.length ? (
        <p className="px-4 py-4 text-[13px] text-muted-foreground">Nothing yet. Switch Sage on, or teach it something above.</p>
      ) : (
        <div className="divide-y divide-[var(--tethr-rim)]">
          {studies.map((s) => (
            <div key={s.id} className="space-y-2 px-4 py-3">
              <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id} className="flex w-full items-start gap-2 text-left">
                <ChevronRight className={cn("mt-1 h-3.5 w-3.5 shrink-0 transition-transform", open === s.id && "rotate-90")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px]">{studyTitle(s)}</span>
                  <span className="block text-[12px] text-muted-foreground">{s.status === "done" ? outcomeWords(s) : studyLine(s)}</span>
                </span>
                <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">
                  {s.trigger === "asked" ? "asked" : "on its own"} · {formatRelative(s.startedAt)}
                </span>
              </button>
              {open === s.id ? (
                <div className="space-y-2 pl-5 text-[12.5px]">
                  {s.summary ? <p className="text-muted-foreground">{s.summary}</p> : null}
                  {s.skills.map((k) => (
                    <div key={k.name} className="tethr-inset flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-[12px]">{k.name}</span>
                        <span className="tethr-text-3"> · {areaLabel(k.area)} · {k.whatChanged || k.description}</span>
                      </span>
                      {k.status === "applied" ? (
                        <button type="button" disabled={undo.isPending} onClick={() => undo.mutate({ id: s.id, name: k.name })} className="tethr-btn tethr-btn-ghost h-7 px-3 text-[12px]">
                          Undo
                        </button>
                      ) : (
                        <span className="text-[12px] tethr-text-3">{SKILL_STATUS_WORDS[k.status]}</span>
                      )}
                    </div>
                  ))}
                  {s.findings.map((f, i) => (
                    <p key={`${i}-${f.claim}`} className="text-muted-foreground">
                      {i + 1}. {f.claim} <span className="tethr-text-3">({f.strength}; {f.sources.map((x) => x.title).join(", ")})</span>
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {undo.isError ? <p className="px-4 pb-3 text-[12px] text-[var(--tethr-bad)]">{(undo.error as Error).message}</p> : null}
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
  const teach = useMutation({ mutationFn: () => tethrApi.startStudy(c, topic), onSuccess: () => setTopic(""), onSettled: refresh });
  const review = useMutation({ mutationFn: () => tethrApi.reviewSkills(c), onSettled: refresh });
  if (isLoading || !data) return <PageSkeleton />;

  const by = (statuses: string[]) => data.lessons.filter((l) => statuses.includes(l.status));
  const waiting = by(["proposed", "candidate"]).sort((a, b) => (a.status === "proposed" ? -1 : 0) - (b.status === "proposed" ? -1 : 0) || (b.composite ?? 0) - (a.composite ?? 0));
  const applied = by(["applied"]);
  const agent = data.learner.agent;
  return (
    <div className="space-y-5">
      <p className="max-w-[70ch] text-[13px] text-muted-foreground">
        What tethr learned. Sage studies what would help and saves it as skills tethr and its agents use; below that, the lessons tethr and the team
        proposed, which the Friday scorecard checks.
      </p>

      <section className="tethr-panel space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={data.learner.enabled && !agent?.paused ? "ok" : "idle"} />
            {data.learner.enabled ? `Sage is on: ${data.learner.schedule.words}` : "Sage is off"}
            {agent ? <span className="font-mono text-[12px] tethr-text-3">{agent.tag}</span> : null}
          </p>
          <div className="flex items-center gap-2">
            {agent ? (
              <Link to={`/chat?chat=${agent.threadId}`} className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]">
                Its chat
              </Link>
            ) : null}
            <Link to="/tethr-settings" className="tethr-btn tethr-btn-ghost h-8 px-3 text-[12.5px]">
              Pace and switch
            </Link>
          </div>
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (topic.trim().length >= 5) teach.mutate();
          }}
        >
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="Teach Sage something, e.g. how small telehealth companies get listed by travel insurers"
            aria-label="Something for Sage to learn"
            className="tethr-inset h-9 min-w-0 flex-1 rounded-[10px] px-3 text-[13px]"
          />
          <button type="submit" disabled={topic.trim().length < 5 || teach.isPending || !data.learner.enabled} className="tethr-btn tethr-btn-primary h-9 px-3.5 text-[12.5px]">
            {teach.isPending ? "Starting…" : "Learn it"}
          </button>
        </form>
        {teach.isError ? <p className="text-[12px] text-[var(--tethr-bad)]">{(teach.error as Error).message}</p> : null}
        {teach.isSuccess ? <p className="text-[12px] text-muted-foreground">Started. It shows below and in Sage's chat; a deep study can take most of an hour.</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t tethr-rule pt-3">
          <button
            type="button"
            disabled={review.isPending || !data.learner.enabled}
            onClick={() => review.mutate()}
            className="tethr-btn tethr-btn-glass h-8 px-3 text-[12.5px]"
          >
            {review.isPending ? "Starting…" : "Review the skills"}
          </button>
          <span className="min-w-0 flex-1 text-[12px] text-muted-foreground">
            Sage checks that each skill holds as the company grows, from a small test to many times the budget, and rewrites the narrow ones.
          </span>
          {review.isError ? <p className="w-full text-[12px] text-[var(--tethr-bad)]">{(review.error as Error).message}</p> : null}
          {review.isSuccess ? <p className="w-full text-[12px] text-muted-foreground">Started. It shows below and in Sage's chat.</p> : null}
        </div>
      </section>

      <StudiesSection studies={data.studies} companyId={c} />

      <Group title="Waiting for you" hint="Cards in the chat first, then the rest by score." lessons={waiting} companyId={c} />
      <Group title="Applied" hint="Each one is reviewed on its date: tethr reads the number and suggests keeping or retiring it." lessons={applied} companyId={c} />
      <Group title="Kept" lessons={by(["kept"])} companyId={c} collapsed />
      <Group title="Retired" lessons={by(["retired"])} companyId={c} collapsed />
      <Group title="Not for us" lessons={by(["rejected"])} companyId={c} collapsed />
      {!data.lessons.length ? <div className="tethr-empty px-6 py-8 text-center text-[13px]">No lessons yet. They come from the learner, and from tethr when you correct it in the chat.</div> : null}

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
