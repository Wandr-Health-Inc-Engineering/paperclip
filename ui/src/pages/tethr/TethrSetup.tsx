import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Compass } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot } from "@/components/tethr/primitives";
import { rememberSetupSeen } from "@/components/tethr/SetupNavItem";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { STEPS, stepDone, type SetupData, type StepKey } from "./setup/shared";
import { STEP_GUIDE } from "./setup/guide";
import { SetupWelcome } from "./setup/Welcome";
import { CompanyStep } from "./setup/CompanyStep";
import { FocusStep } from "./setup/FocusStep";
import { ConnectStep } from "./setup/ConnectStep";
import { InterviewStep } from "./setup/InterviewStep";
import { RhythmStep } from "./setup/RhythmStep";
import { FinishStep } from "./setup/FinishStep";

// Set up tethr, as a guided onboarding: a welcome (what tethr is, how setup
// goes, what to have ready), then one step at a time with a progress rail and,
// beside each form, why it matters, what tethr does with it, what you need and
// a tip (setup/guide.ts). The forms live in ./setup/.

const SETUP_REFRESH_MS = 8_000;
/** Steps you can pass over and come back to. */
const SKIPPABLE: StepKey[] = ["connect", "interview", "rhythm"];

export function TethrSetup() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const companyId = selectedCompanyId ?? "";
  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.setup(companyId),
    queryFn: () => tethrApi.setup(companyId),
    enabled: !!selectedCompanyId,
    refetchInterval: SETUP_REFRESH_MS,
  });
  const [view, setView] = useState<StepKey | "welcome" | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Set up tethr" }]);
    // Seen it: "Look around first" and the chat now stay in the chat.
    rememberSetupSeen();
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={Compass} message="Select a company first." />;
  if (isLoading || !data) return <PageSkeleton variant="detail" />;

  const done = stepDone(data);
  const firstOpen = STEPS.find((s) => !done[s.key])?.key ?? "finish";
  const untouched = !data.state.completedAt && STEPS.every((s) => !done[s.key]);
  const current = view ?? (untouched ? "welcome" : firstOpen);

  if (current === "welcome") return <SetupWelcome onBegin={() => setView(firstOpen)} />;
  return <SetupWizard companyId={companyId} data={data} done={done} step={current} go={setView} />;
}

function SetupWizard({
  companyId,
  data,
  done,
  step,
  go,
}: {
  companyId: string;
  data: SetupData;
  done: Record<StepKey, boolean>;
  step: StepKey;
  go: (to: StepKey | "welcome") => void;
}) {
  const index = STEPS.findIndex((s) => s.key === step);
  const meta = STEPS[index];
  const guide = STEP_GUIDE[step];
  const next = STEPS[index + 1]?.key;
  const prev = STEPS[index - 1]?.key;
  const doneCount = STEPS.filter((s) => done[s.key]).length;

  // A new step starts at the top of the page.
  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  return (
    <div className="tethr-onboard">
      <aside className="tethr-onboard-rail" aria-label="Setup steps">
        <button type="button" onClick={() => go("welcome")} className="tethr-eyebrow text-left transition-colors hover:text-foreground">
          set up tethr
        </button>
        <ol className="mt-5 space-y-1">
          {STEPS.map((s, i) => {
            const isCurrent = s.key === step;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => go(s.key)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                    isCurrent ? "bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim)]" : "hover:bg-[var(--tethr-frost)]",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[10.5px] transition-colors",
                      done[s.key] ? "bg-foreground text-background" : isCurrent ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)] tethr-text-3",
                    )}
                  >
                    {done[s.key] ? <Check className="h-3.5 w-3.5" /> : i + 1}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate text-[13px]", isCurrent ? "font-medium" : "text-muted-foreground group-hover:text-foreground")}>
                    {s.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="mt-6 px-2.5">
          <div className="tethr-onboard-meter" aria-hidden="true">
            <i style={{ width: `${(doneCount / STEPS.length) * 100}%` }} />
          </div>
          <p className="mt-2 font-mono text-[10.5px] tethr-text-3">
            {doneCount} of {STEPS.length} done
          </p>
        </div>
      </aside>

      <div className="tethr-onboard-main" key={step}>
        <div className="tethr-onboard-progress" aria-hidden="true">
          {STEPS.map((s) => (
            <i key={s.key} className={cn(done[s.key] && "is-done", s.key === step && "is-current")} />
          ))}
        </div>

        <header className="tethr-onboard-head">
          <p className="tethr-eyebrow">
            step {index + 1} of {STEPS.length} · about {guide.minutes} min
          </p>
          <h1 className="tethr-onboard-title">{meta.title}</h1>
          <p className="tethr-onboard-lede">{guide.lede}</p>
          {data.state.completedAt ? (
            <p className="mt-3 flex items-center gap-2 text-[12px] tethr-text-3">
              <StatusDot tone="ok" /> Set up {new Date(data.state.completedAt).toLocaleDateString()}. Change anything here at any time.
            </p>
          ) : null}
        </header>

        <div className="tethr-onboard-body">
          <section className="tethr-panel tethr-onboard-form" aria-label={meta.title}>
            {renderStep(step, { companyId, data, done, onDone: () => go(next ?? "finish"), goTo: go })}
          </section>
          <aside className="tethr-onboard-guide">
            <GuideBlock label="why it matters">
              <p>{guide.why}</p>
            </GuideBlock>
            <GuideBlock label="what tethr does with it">
              <ul className="space-y-2">
                {guide.does.map((line) => (
                  <li key={line} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-[0.62em] h-px w-2.5 shrink-0 bg-[var(--tethr-rim-strong)]" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </GuideBlock>
            {guide.need ? (
              <GuideBlock label="you'll need">
                <ul className="space-y-2">
                  {guide.need.map((line) => (
                    <li key={line} className="flex gap-2.5">
                      <StatusDot tone="idle" className="mt-[0.5em]" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </GuideBlock>
            ) : null}
            {guide.tip ? <p className="tethr-inset px-3.5 py-3 text-[12.5px] leading-relaxed">{guide.tip}</p> : null}
          </aside>
        </div>

        <nav className="tethr-onboard-foot" aria-label="Setup navigation">
          <button type="button" onClick={() => go(prev ?? "welcome")} className="tethr-btn tethr-btn-ghost h-9 px-3.5 text-[12.5px]">
            <ArrowLeft className="h-3.5 w-3.5" />
            {prev ? STEPS[index - 1].title : "Overview"}
          </button>
          {next && SKIPPABLE.includes(step) ? (
            <button type="button" onClick={() => go(next)} className="tethr-btn tethr-btn-ghost h-9 px-3.5 text-[12.5px]">
              Skip for now
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </nav>
      </div>
    </div>
  );
}

function GuideBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <MonoTag>{label}</MonoTag>
      <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

/** Each step's form; saving it moves on. */
function renderStep(
  key: StepKey,
  {
    companyId,
    data,
    done,
    onDone,
    goTo,
  }: { companyId: string; data: SetupData; done: Record<StepKey, boolean>; onDone: () => void; goTo: (step: StepKey) => void },
): ReactNode {
  switch (key) {
    case "company":
      return <CompanyStep companyId={companyId} data={data} onDone={onDone} />;
    case "focus":
      return <FocusStep companyId={companyId} data={data} onDone={onDone} />;
    case "connect":
      return <ConnectStep companyId={companyId} data={data} onDone={onDone} goTo={goTo} />;
    case "interview":
      return <InterviewStep companyId={companyId} data={data} onDone={onDone} />;
    case "rhythm":
      return <RhythmStep companyId={companyId} data={data} onDone={onDone} />;
    case "finish":
      return <FinishStep companyId={companyId} data={data} done={done} />;
  }
}
