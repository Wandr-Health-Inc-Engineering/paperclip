import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Microscope } from "lucide-react";
import { Orbit } from "@/components/tethr/Orbit";
import { StatusDot, formatRelative } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrChatRun, type TethrStudy } from "@/api/tethr";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  ACTIVE_STUDY,
  areaLabel,
  leadSentence,
  outcomeWords,
  SKILL_STATUS_WORDS,
  STUDY_STEPS,
  studyLine,
  studyStep,
  studyTitle,
  VERDICT_WORDS,
} from "@/lib/tethr-study";
import { ApprovalCard } from "./decision-cards";

// The learner's study, as one card (2026-11-10). In Sage's chat it shows the
// study live: Looking → Researching → Comparing → Done, then what it saved.
// In tethr's main chat it appears once, only when a skill changed: "Sage
// learned …", with Undo. "What it found" opens the questions, the findings with
// their sources and verdicts, and each skill's change. No files.

export const STUDY_CARD_SOURCE = "tethr-study-card";

export function StudyCard({ run, companyId, inMainChat }: { run: TethrChatRun; companyId: string; inMainChat: boolean }) {
  const queryClient = useQueryClient();
  const study = run.study ?? null;
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "chats"] });
    void queryClient.invalidateQueries({ queryKey: tethrKeys.learning(companyId) });
  };
  const stop = useMutation({ mutationFn: (id: string) => tethrApi.stopStudy(companyId, id), onSettled: refresh });
  if (!study) {
    return (
      <div className="tethr-glass rounded-[16px] px-4 py-3.5 text-[13px] text-muted-foreground">
        <Header when={run.createdAt} label="Sage" />
        <p className="mt-2">{run.requestText}</p>
      </div>
    );
  }
  const active = ACTIVE_STUDY.has(study.status);
  const gated = run.outputs.filter((o) => o.status === "gated" || o.status === "changes_requested");
  return (
    <div className="space-y-3">
      <div className="tethr-glass space-y-3 rounded-[16px] px-4 py-3.5">
        <Header
          when={run.createdAt}
          label={inMainChat ? (study.kind === "review" ? "Sage reviewed" : "Sage learned") : study.trigger === "asked" ? `Asked by ${study.by}` : "Sage picked this on its own"}
          depth={study.kind === "review" ? undefined : study.depth}
        />
        <p className="text-[14px] font-medium leading-snug">{studyTitle(study)}</p>
        {!inMainChat && study.kind !== "review" ? <Steps study={study} /> : null}
        <p className={cn("text-[13px] leading-relaxed", study.status === "failed" ? "text-[var(--tethr-bad)]" : "text-muted-foreground")}>
          {active ? (
            <span className="inline-flex items-center gap-2">
              <Orbit className="shrink-0" />
              {studyLine(study)}
            </span>
          ) : study.summary ? (
            // tethr's main chat leads with one sentence; the rest is under "What it found".
            inMainChat ? leadSentence(study.summary) : study.summary
          ) : (
            studyLine(study)
          )}
        </p>
        {study.status === "done" && study.skills.length ? <SkillList study={study} companyId={companyId} onChange={refresh} /> : null}
        {study.status === "done" && !study.skills.length ? <p className="text-[12.5px] tethr-text-3">{outcomeWords(study)}</p> : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {study.findings.length || study.questions.length ? (
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12.5px] tethr-text-3 transition-colors hover:text-foreground">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {study.findings.length ? "What it found" : "What it's looking into"}
            </button>
          ) : null}
          {inMainChat ? (
            <Link to="/learning" className="text-[12.5px] tethr-text-3 underline-offset-2 hover:text-foreground hover:underline">
              Everything Sage learned
            </Link>
          ) : null}
          {active ? (
            <button type="button" disabled={stop.isPending} onClick={() => stop.mutate(study.id)} className="ml-auto text-[12.5px] tethr-text-3 transition-colors hover:text-foreground disabled:opacity-50">
              {stop.isPending ? "Stopping…" : "Stop"}
            </button>
          ) : null}
        </div>
        {open ? <Details study={study} withSummary={inMainChat} /> : null}
      </div>
      {gated.map((o) => (
        <ApprovalCard key={o.id} output={o} companyId={companyId} threadId={run.threadId ?? ""} from="Sage" />
      ))}
    </div>
  );
}

function Header({ when, label, depth }: { when: string; label: string; depth?: TethrStudy["depth"] }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] tethr-text-3">
      <Microscope className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {depth ? <span className="shrink-0 font-mono text-[10.5px] uppercase tracking-[0.12em]">{depth}</span> : null}
      <span className="ml-auto shrink-0 font-mono text-[10.5px]">{formatRelative(when)}</span>
    </div>
  );
}

/** Looking → Researching → Comparing → Done. */
function Steps({ study }: { study: TethrStudy }) {
  const at = studyStep(study.status);
  const ended = !ACTIVE_STUDY.has(study.status);
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Study steps">
      {STUDY_STEPS.map((step, i) => {
        const done = ended ? study.status === "done" || i < at : i < at;
        const current = !ended && i === at;
        return (
          <li key={step.status} className={cn("flex items-center gap-1.5 text-[11.5px]", current ? "text-foreground" : done ? "text-muted-foreground" : "tethr-text-3")} aria-current={current ? "step" : undefined}>
            <StatusDot tone={current ? "live" : done ? "ok" : "idle"} />
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}

function SkillList({ study, companyId, onChange }: { study: TethrStudy; companyId: string; onChange: () => void }) {
  const undo = useMutation({ mutationFn: (name: string) => tethrApi.undoStudySkill(companyId, study.id, name), onSettled: onChange });
  return (
    <ul className="space-y-2">
      {study.skills.map((k) => (
        <li key={k.name} className="tethr-inset flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]">
              <span className="font-mono text-[12px]">{k.name}</span>
              <span className="tethr-text-3"> · {areaLabel(k.area)} · {k.change === "new" ? "new" : "updated"}</span>
            </p>
            <p className="truncate text-[12px] text-muted-foreground">{k.whatChanged || k.description}</p>
          </div>
          {k.status === "applied" ? (
            <button
              type="button"
              disabled={undo.isPending}
              onClick={() => undo.mutate(k.name)}
              className="tethr-btn tethr-btn-ghost tethr-touch-sized h-7 px-3 text-[12px] pointer-coarse:h-9"
            >
              {undo.isPending && undo.variables === k.name ? "Undoing…" : "Undo"}
            </button>
          ) : (
            <span className="text-[12px] tethr-text-3">{SKILL_STATUS_WORDS[k.status]}</span>
          )}
          {undo.isError && undo.variables === k.name ? <p className="w-full text-[12px] text-[var(--tethr-bad)]">{(undo.error as Error).message}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function Details({ study, withSummary }: { study: TethrStudy; withSummary: boolean }) {
  const verdictOf = (i: number) => study.verdicts.find((v) => v.finding === i + 1);
  return (
    <div className="space-y-3 border-t border-[var(--tethr-rim)] pt-3 text-[12.5px] leading-relaxed">
      {withSummary && study.summary ? <p>{study.summary}</p> : null}
      {study.why ? (
        <p>
          <span className="tethr-text-3">Why this: </span>
          {study.why}
        </p>
      ) : null}
      {study.questions.length ? (
        <div>
          <p className="tethr-text-3">The questions</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5">
            {study.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </div>
      ) : null}
      {study.findings.length ? (
        <div>
          <p className="tethr-text-3">What it found</p>
          <ol className="mt-1 space-y-2.5">
            {study.findings.map((f, i) => {
              const v = verdictOf(i);
              return (
                <li key={`${i}-${f.claim}`} className="space-y-0.5">
                  <p className="font-medium">
                    {i + 1}. {f.claim}
                  </p>
                  <p className="text-muted-foreground">{f.detail}</p>
                  <p className="tethr-text-3">
                    {f.strength} {f.evidence.replace("_", " ")}
                    {v ? ` · ${VERDICT_WORDS[v.verdict]}${v.note ? `: ${v.note}` : ""}` : ""}
                  </p>
                  <p className="flex flex-wrap gap-x-3">
                    {f.sources.map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="max-w-full truncate tethr-text-3 underline-offset-2 hover:text-foreground hover:underline">
                        {s.title}
                      </a>
                    ))}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
