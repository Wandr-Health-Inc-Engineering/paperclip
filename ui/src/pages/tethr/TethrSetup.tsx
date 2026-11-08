import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Compass, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot } from "@/components/tethr/primitives";
import { formatMetric } from "@/components/tethr/Scorecard";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link, useNavigate } from "../../lib/router";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrRhythmChoice,
  type TethrRhythmKey,
  type TethrSetup as SetupData,
} from "@/api/tethr";

// Set up tethr (phase 20): the onboarding. Settings happen here (basics,
// connections, the working rhythm); the goals themselves come from an
// interview with tethr in a side chat, where it pulls real baselines from
// Stripe, PostHog and Google Ads and saves goals with numbers.

type StepKey = "basics" | "connect" | "interview" | "rhythm" | "finish";
const STEPS: Array<{ key: StepKey; title: string; blurb: string }> = [
  { key: "basics", title: "The basics", blurb: "Your mission and the goals tethr works toward." },
  { key: "connect", title: "Connections", blurb: "What tethr can read to measure the goals." },
  { key: "interview", title: "Goals interview", blurb: "tethr pulls real numbers and sets targets with you." },
  { key: "rhythm", title: "Working rhythm", blurb: "What tethr does on its own, and when." },
  { key: "finish", title: "Finish", blurb: "Check it over and start." },
];

const SUGGESTED_AREAS = ["New customers", "Revenue", "Partnerships & distribution"];
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "UTC",
];

export function TethrSetup() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const c = selectedCompanyId ?? "";
  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.setup(c),
    queryFn: () => tethrApi.setup(c),
    enabled: !!selectedCompanyId,
    refetchInterval: 8_000,
  });
  const [open, setOpen] = useState<StepKey | "none" | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Set up tethr" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) return <EmptyState icon={Compass} message="Select a company first." />;
  if (isLoading || !data) return <PageSkeleton variant="detail" />;

  const done = stepDone(data);
  const firstOpen = STEPS.find((s) => !done[s.key])?.key ?? "finish";
  const current = open ?? firstOpen;

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-10">
      <div className="space-y-1 px-1">
        <h1 className="tethr-display text-[26px]">Set up tethr</h1>
        <p className="text-[13px] text-muted-foreground">
          Give tethr real goals with numbers, connect what it needs to measure them, and pick what it does on its own. About 20 minutes; the goals
          part is a conversation with tethr.
        </p>
        {data.state.completedAt ? (
          <p className="flex items-center gap-1.5 text-[12px] tethr-text-3">
            <StatusDot tone="ok" /> Set up {new Date(data.state.completedAt).toLocaleDateString()}. Change anything below at any time.
          </p>
        ) : null}
      </div>

      <ol className="space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.key} className="tethr-panel overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(current === s.key ? "none" : s.key)}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
              aria-expanded={current === s.key}
            >
              <span
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[11px]",
                  done[s.key] ? "bg-foreground text-background" : "shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
                )}
              >
                {done[s.key] ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium">{s.title}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{s.blurb}</span>
              </span>
              <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", current === s.key && "rotate-90")} />
            </button>
            {current === s.key ? (
              <div className="border-t border-[var(--tethr-rim)] px-4 py-4">
                {s.key === "basics" ? <BasicsStep companyId={c} data={data} onDone={() => setOpen("connect")} /> : null}
                {s.key === "connect" ? <ConnectStep companyId={c} data={data} onDone={() => setOpen("interview")} /> : null}
                {s.key === "interview" ? <InterviewStep companyId={c} data={data} onDone={() => setOpen("rhythm")} /> : null}
                {s.key === "rhythm" ? <RhythmStep companyId={c} data={data} onDone={() => setOpen("finish")} /> : null}
                {s.key === "finish" ? <FinishStep companyId={c} data={data} done={done} /> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function stepDone(data: SetupData): Record<StepKey, boolean> {
  return {
    basics: !!data.state.steps.basics && !!data.goals.company,
    connect: !!data.state.steps.connect,
    interview: !!data.state.steps.interview || interviewComplete(data),
    rhythm: !!data.state.steps.rhythm,
    finish: !!data.state.completedAt,
  };
}

/** Every chosen area has a metric with a baseline and a target. */
function interviewComplete(data: SetupData): boolean {
  const active = data.goals.goals.filter((g) => g.status !== "cancelled");
  return active.length > 0 && active.every((g) => g.metrics.some((m) => m.baseline !== null && m.target !== null));
}

function useInvalidate(companyId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: tethrKeys.setup(companyId) });
    void qc.invalidateQueries({ queryKey: tethrKeys.goals(companyId) });
  };
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-[12px] text-[var(--tethr-bad)]">{error instanceof Error ? error.message : "Something went wrong."}</p>;
}

// ---- 1. basics ------------------------------------------------------------------

function BasicsStep({ companyId, data, onDone }: { companyId: string; data: SetupData; onDone: () => void }) {
  const invalidate = useInvalidate(companyId);
  const { data: integrations } = useQuery({ queryKey: tethrKeys.integrations(companyId), queryFn: () => tethrApi.integrations(companyId) });
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [mission, setMission] = useState(data.goals.company?.title ?? "");
  const [detail, setDetail] = useState(data.goals.company?.description ?? "");
  const [areas, setAreas] = useState<string[]>(data.state.areas);
  const [custom, setCustom] = useState("");
  const [timezone, setTimezone] = useState(data.state.steps.basics ? data.state.timezone : browserZone || data.state.timezone);
  const [domains, setDomains] = useState<string | null>(null);
  const domainText = domains ?? (integrations?.internalAddresses ?? []).join(", ");
  const zones = useMemo(() => [...new Set([timezone, browserZone, ...TIMEZONES].filter(Boolean))], [timezone, browserZone]);

  const save = useMutation({
    mutationFn: () =>
      tethrApi.setupBasics(companyId, {
        mission: mission.trim(),
        missionDetail: detail.trim() || undefined,
        areas,
        timezone,
        internalAddresses: domainText.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });

  const toggle = (a: string) => setAreas((list) => (list.includes(a) ? list.filter((x) => x !== a) : [...list, a]));

  return (
    <div className="space-y-4">
      <Field label="Mission" help="One line: what Wandr exists to do. tethr keeps it in mind in every chat.">
        <Input value={mission} onChange={(e) => setMission(e.target.value)} placeholder="e.g. Make travel medicine easy for every US traveler" className="h-9 text-[13.5px]" />
      </Field>
      <Field label="More context (optional)" help="Where you are now and what this year is about.">
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[13.5px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </Field>
      <Field label="Goals" help="The areas tethr works on first. Numbers come in the goals interview.">
        <div className="flex flex-wrap gap-1.5">
          {[...new Set([...SUGGESTED_AREAS, ...areas])].map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              aria-pressed={areas.includes(a)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] transition-colors",
                areas.includes(a) ? "bg-foreground text-background" : "bg-[var(--tethr-frost)] shadow-[inset_0_0_0_1px_var(--tethr-rim)] hover:bg-[var(--tethr-frost-strong)]",
              )}
            >
              {areas.includes(a) ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              {a}
            </button>
          ))}
          <span className="inline-flex items-center gap-1">
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim()) {
                  setAreas((l) => [...new Set([...l, custom.trim()])]);
                  setCustom("");
                }
              }}
              placeholder="Add another"
              className="h-8 w-36 text-[12.5px]"
            />
          </span>
        </div>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" help="For the schedule.">
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[13px]"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inside Wandr" help="Email domains that count as the company.">
          <Input value={domainText} onChange={(e) => setDomains(e.target.value)} className="h-9 font-mono text-[12.5px]" />
        </Field>
      </div>
      <ErrorLine error={save.error} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!mission.trim() || !areas.length || save.isPending}
          className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]"
        >
          Save and continue
        </button>
      </div>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[12.5px] font-medium">{label}</span>
      {children}
      {help ? <span className="block text-[11.5px] tethr-text-3">{help}</span> : null}
    </label>
  );
}

// ---- 2. connections ---------------------------------------------------------------

function ConnectStep({ companyId, data, onDone }: { companyId: string; data: SetupData; onDone: () => void }) {
  const invalidate = useInvalidate(companyId);
  const mark = useMutation({
    mutationFn: () => tethrApi.setupStep(companyId, "connect"),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const missing = data.checks.filter((c) => !c.ok && !c.optional);
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        tethr measures the goals with these. Connectors come from your Claude account; keys live on the Environment page. Anything outward still asks
        you first.
      </p>
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {data.checks.map((check) => (
          <div key={check.key} className="flex items-center gap-3 px-3 py-2.5">
            <StatusDot tone={check.ok ? "ok" : check.optional ? "idle" : "warn"} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px]">{check.label}</span>
              <span className="block truncate text-[11.5px] tethr-text-3">
                {check.ok ? check.detail : check.optional ? check.detail : `Needed: ${check.detail}`}
              </span>
            </span>
            {!check.ok ? (
              <Link to={check.href} className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-3 text-[12px]">
                Fix
              </Link>
            ) : null}
          </div>
        ))}
      </div>
      <ErrorLine error={mark.error} />
      <div className="flex items-center justify-end gap-3">
        {missing.length ? <span className="text-[12px] tethr-text-3">{missing.length} not connected yet; you can continue and fix them later.</span> : null}
        <button type="button" onClick={() => mark.mutate()} disabled={mark.isPending} className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]">
          Continue
        </button>
      </div>
    </div>
  );
}

// ---- 3. goals interview -------------------------------------------------------------

function InterviewStep({ companyId, data, onDone }: { companyId: string; data: SetupData; onDone: () => void }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(companyId);
  const start = useMutation({
    mutationFn: () => tethrApi.startInterview(companyId),
    onSuccess: (r) => {
      invalidate();
      navigate(`/chat?chat=${r.threadId}`);
    },
  });
  const mark = useMutation({
    mutationFn: () => tethrApi.setupStep(companyId, "interview"),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const goals = data.goals.goals.filter((g) => g.status !== "cancelled");
  const complete = interviewComplete(data);

  return (
    <div className="space-y-4">
      <p className="text-[12.5px] text-muted-foreground">
        tethr talks it through with you in a side chat, one goal at a time. It pulls a baseline from your tools (aggregate numbers only), proposes a
        target and a date, and saves each goal once you agree. It also fills in its memory with your products, customers and channels. Goals appear
        here as they're saved.
      </p>
      {!data.goals.company ? <p className="text-[12.5px] text-[var(--tethr-bad)]">Save the basics first.</p> : null}
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {goals.length ? (
          goals.map((g) => (
            <div key={g.id} className="space-y-1 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <StatusDot tone={g.metrics.some((m) => m.baseline !== null && m.target !== null) ? "ok" : "idle"} />
                <span className="text-[13px] font-medium">{g.title}</span>
              </div>
              {g.metrics.length ? (
                g.metrics.map((m) => (
                  <p key={m.id} className="pl-4 text-[12px] text-muted-foreground">
                    {m.name}: {formatMetric(m.baseline, m.unit)} now → {formatMetric(m.target, m.unit)}
                    {m.targetDate ? ` by ${new Date(m.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}
                  </p>
                ))
              ) : (
                <p className="pl-4 text-[12px] tethr-text-3">waiting for the interview</p>
              )}
            </div>
          ))
        ) : (
          <p className="px-3 py-3 text-[12.5px] tethr-text-3">No goals yet.</p>
        )}
      </div>
      <ErrorLine error={start.error ?? mark.error} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {data.state.interviewThreadId ? (
          <Link to={`/chat?chat=${data.state.interviewThreadId}`} className="tethr-btn tethr-btn-glass h-9 px-4 text-[12.5px]">
            Continue the interview
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={!data.goals.company || start.isPending}
            className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]"
          >
            Start the interview
          </button>
        )}
        {complete || data.state.steps.interview ? (
          <button type="button" onClick={() => mark.mutate()} disabled={mark.isPending} className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]">
            Goals look right, continue
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---- 4. rhythm ----------------------------------------------------------------------

const DAYS = [
  { v: "1", label: "Monday" },
  { v: "2", label: "Tuesday" },
  { v: "3", label: "Wednesday" },
  { v: "4", label: "Thursday" },
  { v: "5", label: "Friday" },
  { v: "6", label: "Saturday" },
  { v: "0", label: "Sunday" },
];

/** "M H * * D" → time + day parts (the only shapes this page writes). */
export function parseCron(cron: string): { time: string; day: string } {
  const [m = "0", h = "8", , , d = "1"] = cron.trim().split(/\s+/);
  const pad = (s: string) => String(Number(s) || 0).padStart(2, "0");
  return { time: `${pad(h)}:${pad(m)}`, day: d };
}

export function buildCron(time: string, day: string): string {
  const [h = "8", m = "0"] = time.split(":");
  return `${Number(m) || 0} ${Number(h) || 0} * * ${day}`;
}

function RhythmStep({ companyId, data, onDone }: { companyId: string; data: SetupData; onDone: () => void }) {
  const invalidate = useInvalidate(companyId);
  const slackReady = data.checks.find((c) => c.key === "slack_bot")?.ok ?? false;
  const [rhythm, setRhythm] = useState<Record<TethrRhythmKey, TethrRhythmChoice>>(data.state.rhythm);
  const save = useMutation({
    mutationFn: () =>
      tethrApi.setupRhythm(companyId, {
        timezone: data.state.timezone,
        rhythm: Object.fromEntries(
          (Object.keys(rhythm) as TethrRhythmKey[]).map((k) => [k, { enabled: rhythm[k].enabled, cron: rhythm[k].cron, slack: rhythm[k].slack }]),
        ) as Record<TethrRhythmKey, { enabled: boolean; cron: string; slack: boolean }>,
      }),
    onSuccess: () => {
      invalidate();
      onDone();
    },
  });
  const set = (k: TethrRhythmKey, patch: Partial<TethrRhythmChoice>) => setRhythm((r) => ({ ...r, [k]: { ...r[k], ...patch } }));
  const rows: Array<{ key: TethrRhythmKey; what: string; dayMode: "week" | "weekdays" }> = [
    { key: "plan", what: "Checks the goals and last week's numbers, proposes this week's 3-5 moves (each tied to a goal) and saves the plan.", dayMode: "week" },
    { key: "scorecard", what: "Measures every goal the way it was agreed, records the numbers and calls out what's off track.", dayMode: "week" },
    { key: "brief", what: "A short morning note: what changed, what's waiting on you, today's focus.", dayMode: "weekdays" },
  ];

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        Turn on what you want tethr to do by itself. Each runs in an Operations chat you can read, and nothing outward happens without your OK. Times
        are in {data.state.timezone.replace(/_/g, " ")}.
      </p>
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {rows.map(({ key, what, dayMode }) => {
          const choice = rhythm[key];
          const { time, day } = parseCron(choice.cron);
          return (
            <div key={key} className="space-y-2.5 px-3 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{data.rhythms[key].label}</p>
                  <p className="text-[12px] text-muted-foreground">{what}</p>
                </div>
                <Toggle on={choice.enabled} onChange={(v) => set(key, { enabled: v })} label={`${data.rhythms[key].label} on`} />
              </div>
              {choice.enabled ? (
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  {dayMode === "week" ? (
                    <select
                      value={day}
                      onChange={(e) => set(key, { cron: buildCron(time, e.target.value) })}
                      className="h-8 rounded-md border border-input bg-transparent px-2"
                      aria-label="Day"
                    >
                      {DAYS.map((d) => (
                        <option key={d.v} value={d.v}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      value={day === "*" ? "*" : "1-5"}
                      onChange={(e) => set(key, { cron: buildCron(time, e.target.value) })}
                      className="h-8 rounded-md border border-input bg-transparent px-2"
                      aria-label="Days"
                    >
                      <option value="1-5">Weekdays</option>
                      <option value="*">Every day</option>
                    </select>
                  )}
                  <span className="tethr-text-3">at</span>
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => set(key, { cron: buildCron(e.target.value || "08:00", day) })}
                    className="h-8 rounded-md border border-input bg-transparent px-2"
                    aria-label="Time"
                  />
                  <label className={cn("ml-auto flex items-center gap-2", !slackReady && "opacity-50")}>
                    <input
                      type="checkbox"
                      checked={choice.slack && slackReady}
                      disabled={!slackReady}
                      onChange={(e) => set(key, { slack: e.target.checked })}
                    />
                    Heads-up in Slack #tethr
                  </label>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="text-[11.5px] tethr-text-3">
        {slackReady
          ? "The Slack post says it's ready and links to it (the scorecard adds its numbers); the write-up itself stays in tethr, since it can mention customers."
          : "Slack posting needs the Slack bot token (Connections step)."}
      </p>
      <ErrorLine error={save.error} />
      <div className="flex justify-end">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]">
          Save rhythm
        </button>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-6 w-10 shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
      )}
    >
      <span className={cn("absolute top-1 h-4 w-4 rounded-full bg-background transition-[left]", on ? "left-5" : "left-1")} />
    </button>
  );
}

// ---- 5. finish ----------------------------------------------------------------------

function FinishStep({ companyId, data, done }: { companyId: string; data: SetupData; done: Record<StepKey, boolean> }) {
  const navigate = useNavigate();
  const invalidate = useInvalidate(companyId);
  const measure = useMutation({ mutationFn: () => tethrApi.runRhythm(companyId, "scorecard") });
  const finish = useMutation({
    mutationFn: () => tethrApi.completeSetup(companyId),
    onSuccess: () => {
      invalidate();
      navigate("/growth");
    },
  });
  const goals = data.goals.goals.filter((g) => g.status !== "cancelled");
  const metrics = goals.flatMap((g) => g.metrics);
  const on = (Object.keys(data.state.rhythm) as TethrRhythmKey[]).filter((k) => data.state.rhythm[k].enabled);
  const missing = data.checks.filter((c) => !c.ok && !c.optional);

  return (
    <div className="space-y-4">
      <dl className="tethr-inset grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-3.5 py-3 text-[12.5px]">
        <dt className="tethr-text-3">Mission</dt>
        <dd>{data.goals.company?.title ?? "not set"}</dd>
        <dt className="tethr-text-3">Goals</dt>
        <dd>
          {goals.length ? goals.map((g) => g.title).join(" · ") : "none yet"} ({metrics.length} {metrics.length === 1 ? "metric" : "metrics"})
        </dd>
        <dt className="tethr-text-3">Connections</dt>
        <dd>{missing.length ? `${missing.length} still to connect: ${missing.map((m) => m.label.split(" (")[0]).join(", ")}` : "all set"}</dd>
        <dt className="tethr-text-3">Rhythm</dt>
        <dd>{on.length ? on.map((k) => data.rhythms[k].label).join(" · ") : "nothing on its own yet"}</dd>
      </dl>
      {!done.basics || !done.interview ? (
        <p className="flex items-center gap-1.5 text-[12px]">
          <StatusDot tone="warn" /> {!done.basics ? "Save the basics" : "Finish the goals interview"} so tethr has numbers to work toward.
        </p>
      ) : null}
      <ErrorLine error={measure.error ?? finish.error} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        {measure.isSuccess ? (
          <Link to={`/chat?chat=${measure.data.threadId}`} className="text-[12px] tethr-text-3 hover:text-foreground">
            Measuring in the Operations chat →
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => measure.mutate()}
            disabled={!metrics.length || measure.isPending}
            className="tethr-btn tethr-btn-glass h-9 px-4 text-[12.5px]"
          >
            Run the first scorecard now
          </button>
        )}
        <button type="button" onClick={() => finish.mutate()} disabled={finish.isPending} className="tethr-btn tethr-btn-primary h-9 px-4 text-[12.5px]">
          {data.state.completedAt ? "Done" : "Finish setup"}
        </button>
      </div>
    </div>
  );
}

