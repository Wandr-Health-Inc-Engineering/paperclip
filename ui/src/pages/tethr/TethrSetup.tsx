import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Compass } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusDot } from "@/components/tethr/primitives";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { STEPS, stepDone, type SetupData, type StepKey } from "./setup/shared";
import { CompanyStep } from "./setup/CompanyStep";
import { FocusStep } from "./setup/FocusStep";
import { ConnectStep } from "./setup/ConnectStep";
import { InterviewStep } from "./setup/InterviewStep";
import { RhythmStep } from "./setup/RhythmStep";
import { FinishStep } from "./setup/FinishStep";

// Set up tethr: the company and you first (tethr's mission is built in), then
// what to work on and how hard to push, connections, a goals interview with
// tethr in a side chat (real baselines from Stripe, PostHog and Google Ads),
// and what tethr does on its own: the working rhythm, and how often it offers
// ideas. Each step lives in ./setup/.

const SETUP_REFRESH_MS = 8_000;

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
  const [openStep, setOpenStep] = useState<StepKey | "none" | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Set up tethr" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={Compass} message="Select a company first." />;
  if (isLoading || !data) return <PageSkeleton variant="detail" />;

  const done = stepDone(data);
  const current = openStep ?? STEPS.find((s) => !done[s.key])?.key ?? "finish";

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-10">
      <SetupIntro completedAt={data.state.completedAt} />
      <ol className="space-y-3">
        {STEPS.map((step, index) => (
          <StepPanel
            key={step.key}
            number={index + 1}
            title={step.title}
            blurb={step.blurb}
            isDone={done[step.key]}
            isOpen={current === step.key}
            onToggle={() => setOpenStep(current === step.key ? "none" : step.key)}
          >
            {renderStep(step.key, { companyId, data, done, open: setOpenStep })}
          </StepPanel>
        ))}
      </ol>
    </div>
  );
}

/** Each step's body; saving a step opens the next one. */
function renderStep(
  key: StepKey,
  { companyId, data, done, open }: { companyId: string; data: SetupData; done: Record<StepKey, boolean>; open: (key: StepKey) => void },
): ReactNode {
  switch (key) {
    case "company":
      return <CompanyStep companyId={companyId} data={data} onDone={() => open("focus")} />;
    case "focus":
      return <FocusStep companyId={companyId} data={data} onDone={() => open("connect")} />;
    case "connect":
      return <ConnectStep companyId={companyId} data={data} onDone={() => open("interview")} />;
    case "interview":
      return <InterviewStep companyId={companyId} data={data} onDone={() => open("rhythm")} />;
    case "rhythm":
      return <RhythmStep companyId={companyId} data={data} onDone={() => open("finish")} />;
    case "finish":
      return <FinishStep companyId={companyId} data={data} done={done} />;
  }
}

function SetupIntro({ completedAt }: { completedAt: string | null }) {
  return (
    <div className="space-y-1 px-1">
      <h1 className="tethr-display text-[26px]">Set up tethr</h1>
      <p className="text-[13px] text-muted-foreground">
        Tell tethr who you are, give it real goals with numbers, connect what it needs to measure them, and pick what it does on its own. About 20
        minutes; the goals part is a conversation with tethr.
      </p>
      {completedAt ? (
        <p className="flex items-center gap-1.5 text-[12px] tethr-text-3">
          <StatusDot tone="ok" /> Set up {new Date(completedAt).toLocaleDateString()}. Change anything below at any time.
        </p>
      ) : null}
    </div>
  );
}

function StepPanel({
  number,
  title,
  blurb,
  isDone,
  isOpen,
  onToggle,
  children,
}: {
  number: number;
  title: string;
  blurb: string;
  isDone: boolean;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li className="tethr-panel overflow-hidden">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3.5 text-left" aria-expanded={isOpen}>
        <span
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[11px]",
            isDone ? "bg-foreground text-background" : "shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
          )}
        >
          {isDone ? <Check className="h-3.5 w-3.5" /> : number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-medium">{title}</span>
          <span className="block truncate text-[12px] text-muted-foreground">{blurb}</span>
        </span>
        <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")} />
      </button>
      {isOpen ? <div className="border-t border-[var(--tethr-rim)] px-4 py-4">{children}</div> : null}
    </li>
  );
}
