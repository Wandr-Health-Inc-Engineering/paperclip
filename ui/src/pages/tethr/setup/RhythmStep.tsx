import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { MonoTag } from "@/components/tethr/primitives";
import { cn } from "@/lib/utils";
import { tethrApi, type TethrIdeasLevel, type TethrRhythmChoice, type TethrRhythmKey, type TethrSetupState } from "@/api/tethr";
import { ErrorLine, PRIMARY_BUTTON, Segmented, StepActions, Toggle, ToggleRow } from "./controls";
import { useRefreshSetup, type SetupData, type StepProps } from "./shared";

// Step 5: what tethr does on its own (the working rhythm) and how often it
// offers ideas.

const DAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

/** "M H * * D" → time + day parts (the only shapes this page writes). */
export function parseCron(cron: string): { time: string; day: string } {
  const [minute = "0", hour = "8", , , day = "1"] = cron.trim().split(/\s+/);
  const pad = (part: string) => String(Number(part) || 0).padStart(2, "0");
  return { time: `${pad(hour)}:${pad(minute)}`, day };
}

export function buildCron(time: string, day: string): string {
  const [hour = "8", minute = "0"] = time.split(":");
  return `${Number(minute) || 0} ${Number(hour) || 0} * * ${day}`;
}

type DayMode = "week" | "weekdays";
type IdeasChoice = TethrSetupState["ideas"];

const RHYTHM_ROWS: Array<{ key: TethrRhythmKey; what: string; dayMode: DayMode }> = [
  { key: "plan", what: "Checks the goals and last week's numbers, proposes this week's 3-5 moves (each tied to a goal) and saves the plan.", dayMode: "week" },
  { key: "scorecard", what: "Measures every goal the way it was agreed, records the numbers and calls out what's off track.", dayMode: "week" },
  { key: "brief", what: "A short morning note: what changed, what's waiting on you, today's focus.", dayMode: "weekdays" },
];

function isCheckOk(data: SetupData, key: string): boolean {
  return data.checks.find((c) => c.key === key)?.ok ?? false;
}

export function RhythmStep({ companyId, data, onDone }: StepProps) {
  const refresh = useRefreshSetup(companyId);
  const slackReady = isCheckOk(data, "slack_bot");
  const [rhythm, setRhythm] = useState<Record<TethrRhythmKey, TethrRhythmChoice>>(data.state.rhythm);
  const [ideas, setIdeas] = useState(data.state.ideas);
  const save = useMutation({
    mutationFn: () => tethrApi.setupRhythm(companyId, { timezone: data.state.timezone, rhythm: rhythmPayload(rhythm), ideas }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  const updateRhythm = (key: TethrRhythmKey, patch: Partial<TethrRhythmChoice>) => setRhythm((r) => ({ ...r, [key]: { ...r[key], ...patch } }));

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-muted-foreground">
        Turn on what you want tethr to do by itself. Each runs in an Operations chat you can read, and nothing outward happens without your OK. Times
        are in {data.state.timezone.replace(/_/g, " ")}.
      </p>
      <div className="tethr-inset divide-y divide-[var(--tethr-rim)]">
        {RHYTHM_ROWS.map(({ key, what, dayMode }) => (
          <RhythmRow
            key={key}
            label={data.rhythms[key].label}
            what={what}
            dayMode={dayMode}
            choice={rhythm[key]}
            slackReady={slackReady}
            onChange={(patch) => updateRhythm(key, patch)}
          />
        ))}
      </div>
      <p className="text-[11.5px] tethr-text-3">
        {slackReady
          ? "The Slack post says it's ready and links to it (the scorecard adds its numbers); the write-up itself stays in tethr, since it can mention customers."
          : "Slack posting needs the Slack bot token (Connections step)."}
      </p>
      <IdeasSettings data={data} ideas={ideas} onChange={(patch) => setIdeas((current) => ({ ...current, ...patch }))} />
      <ErrorLine error={save.error} />
      <StepActions>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className={PRIMARY_BUTTON}>
          Save
        </button>
      </StepActions>
    </div>
  );
}

/** Only the fields the server takes for each rhythm item. */
function rhythmPayload(rhythm: Record<TethrRhythmKey, TethrRhythmChoice>) {
  const keys = Object.keys(rhythm) as TethrRhythmKey[];
  return Object.fromEntries(keys.map((key) => [key, { enabled: rhythm[key].enabled, cron: rhythm[key].cron, slack: rhythm[key].slack }])) as Record<
    TethrRhythmKey,
    { enabled: boolean; cron: string; slack: boolean }
  >;
}

function RhythmRow({
  label,
  what,
  dayMode,
  choice,
  slackReady,
  onChange,
}: {
  label: string;
  what: string;
  dayMode: DayMode;
  choice: TethrRhythmChoice;
  slackReady: boolean;
  onChange: (patch: Partial<TethrRhythmChoice>) => void;
}) {
  const { time, day } = parseCron(choice.cron);
  return (
    <div className="space-y-2.5 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">{label}</p>
          <p className="text-[12px] text-muted-foreground">{what}</p>
        </div>
        <Toggle on={choice.enabled} onChange={(enabled) => onChange({ enabled })} label={`${label} on`} />
      </div>
      {choice.enabled ? (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <DayPicker dayMode={dayMode} day={day} onChange={(newDay) => onChange({ cron: buildCron(time, newDay) })} />
          <span className="tethr-text-3">at</span>
          <input
            type="time"
            value={time}
            onChange={(e) => onChange({ cron: buildCron(e.target.value || "08:00", day) })}
            className="h-8 rounded-md border border-input bg-transparent px-2"
            aria-label="Time"
          />
          <label className={cn("ml-auto flex items-center gap-2", !slackReady && "opacity-50")}>
            <input type="checkbox" checked={choice.slack && slackReady} disabled={!slackReady} onChange={(e) => onChange({ slack: e.target.checked })} />
            Heads-up in Slack #tethr
          </label>
        </div>
      ) : null}
    </div>
  );
}

function DayPicker({ dayMode, day, onChange }: { dayMode: DayMode; day: string; onChange: (day: string) => void }) {
  const className = "h-8 rounded-md border border-input bg-transparent px-2";
  if (dayMode === "week") {
    return (
      <select value={day} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Day">
        {DAYS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <select value={day === "*" ? "*" : "1-5"} onChange={(e) => onChange(e.target.value)} className={className} aria-label="Days">
      <option value="1-5">Weekdays</option>
      <option value="*">Every day</option>
    </select>
  );
}

function IdeasSettings({ data, ideas, onChange }: { data: SetupData; ideas: IdeasChoice; onChange: (patch: Partial<IdeasChoice>) => void }) {
  const listenReady = isCheckOk(data, "slack_listen");
  const levelBlurb = data.ideasLevels.find((l) => l.key === ideas.level)?.blurb;
  return (
    <div className="space-y-3 pt-2">
      <MonoTag>ideas</MonoTag>
      <p className="text-[12.5px] text-muted-foreground">
        tethr watches how you're doing (goals falling behind, quiet stretches, and Slack conversations it's invited into) and offers an idea when it
        has a real one: in Slack, in your main chat and on the bell. It speaks only in working hours, and learns your pace: ideas you use or answer
        earn more, ones you pass on earn fewer.
      </p>
      <div className="tethr-inset space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium">How often</p>
            <p className="text-[12px] text-muted-foreground">
              {levelBlurb}
              {ideas.adaptive ? `, adapting (${data.ideasPace.now} right now)` : ", fixed"}
            </p>
          </div>
          <Segmented<TethrIdeasLevel>
            value={ideas.level}
            onChange={(level) => onChange({ level })}
            options={data.ideasLevels.map((l) => ({ value: l.key, label: l.label }))}
          />
        </div>
        <ToggleRow title="Adapt to how I respond" on={ideas.adaptive} onChange={(adaptive) => onChange({ adaptive })}>
          Off keeps the level's pace no matter what.
        </ToggleRow>
        <ToggleRow title="Listen in Slack" on={ideas.slackListen} onChange={(slackListen) => onChange({ slackListen })}>
          {listenReady
            ? "tethr hears conversations in channels it's invited to (never your DMs with each other) and keeps nothing it hears; only its ideas are saved."
            : "Needs the Slack bot and app tokens (Connections step)."}
        </ToggleRow>
      </div>
    </div>
  );
}
