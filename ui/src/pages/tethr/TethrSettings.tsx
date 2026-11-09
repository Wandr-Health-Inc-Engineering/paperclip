import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Cog, GitCommitHorizontal, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrConnectorMode,
  type TethrIntegrationConnector,
  type TethrIntegrations,
  type TethrIntegrationsPatch,
  type TethrOverseerRole,
  type TethrOverseerRoster,
  type TethrStatus,
} from "@/api/tethr";

// Integrations (phase 18, formerly "Providers"): what Tethr's chat may do with
// each of Mark's connectors (Off / Read / Ask = approval required / Auto), the
// rules around it (who counts as inside Wandr, the shell, the default for new
// connectors), the chat's model and engine, and the usage throttle. The old
// provider/infrastructure cards sit folded at the bottom.

const MODES: TethrConnectorMode[] = ["off", "read", "ask", "auto"];
const MODE_LABEL: Record<TethrConnectorMode, string> = { off: "Off", read: "Read", ask: "Ask", auto: "Auto" };
const MODE_HELP: Record<TethrConnectorMode, string> = {
  off: "Tethr can't use it.",
  read: "Tethr can look, but can't change anything.",
  ask: "Changes wait for your OK in the chat.",
  auto: "Changes just happen. Money, outsiders and anything medical still ask.",
};
const MODE_TONE: Record<TethrConnectorMode, "paused" | "idle" | "warn" | "ok"> = {
  off: "paused",
  read: "idle",
  ask: "warn",
  auto: "ok",
};
const MODELS = [
  { id: "sonnet", label: "Sonnet", hint: "balanced (default)" },
  { id: "opus", label: "Opus", hint: "smartest, slower" },
  { id: "haiku", label: "Haiku", hint: "fastest, lightest" },
];

export function TethrSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [classicOpen, setClassicOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Integrations" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.status(selectedCompanyId!),
    queryFn: () => tethrApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: integrations } = useQuery({
    queryKey: tethrKeys.integrations(selectedCompanyId!),
    queryFn: () => tethrApi.integrations(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const update = useMutation({
    mutationFn: (patch: TethrIntegrationsPatch) => tethrApi.updateIntegrations(selectedCompanyId!, patch),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.integrations(selectedCompanyId!) });
      void queryClient.invalidateQueries({ queryKey: tethrKeys.setup(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cog} message="Select a company first." />;
  }
  if (isLoading || !integrations) return <PageSkeleton variant="detail" />;
  if (!data) return null;

  const setConnector = (label: string, mode: TethrConnectorMode, scope?: string) => {
    queryClient.setQueryData<TethrIntegrations>(tethrKeys.integrations(selectedCompanyId), (prev) =>
      prev
        ? { ...prev, connectors: prev.connectors.map((c) => (c.label === label ? { ...c, mode, explicit: true, ...(scope !== undefined ? { scope } : {}) } : c)) }
        : prev,
    );
    update.mutate({ connectors: { [label]: { mode, ...(scope !== undefined ? { scope } : {}) } } });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ThrottleCard companyId={selectedCompanyId} />

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <MonoTag>connectors</MonoTag>
          <span className="text-[11.5px] tethr-text-3">From your Claude account on this Mac</span>
        </div>
        <div className="tethr-panel divide-y divide-[var(--tethr-rim)] overflow-hidden">
          {integrations.connectors.map((c) => (
            <ConnectorRow
              key={c.label}
              connector={c}
              onMode={(mode) => setConnector(c.label, mode)}
              onScope={(scope) => setConnector(c.label, c.mode, scope)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <div className="px-1">
          <MonoTag>rules</MonoTag>
        </div>
        <div className="tethr-panel divide-y divide-[var(--tethr-rim)] overflow-hidden">
          <SettingRow title="Connectors not listed above" help={MODE_HELP[integrations.defaultMode]}>
            <ModeControl value={integrations.defaultMode} onChange={(m) => update.mutate({ defaultMode: m })} />
          </SettingRow>
          <SettingRow
            title="Inside Wandr"
            help="Email addresses or domains that count as inside the company. Sending to anyone else always asks."
          >
            <AddressesField
              value={integrations.internalAddresses}
              onSave={(list) => update.mutate({ internalAddresses: list })}
            />
          </SettingRow>
          <SettingRow title="Shell commands on this Mac" help="Off by default. Ask lets Tethr run a command after you approve it.">
            <PillChoice
              value={integrations.shell}
              options={[
                { value: "off", label: "Off" },
                { value: "ask", label: "Ask" },
              ]}
              onChange={(v) => update.mutate({ shell: v as "off" | "ask" })}
            />
          </SettingRow>
        </div>
      </section>

      <section className="space-y-2">
        <div className="px-1">
          <MonoTag>chat</MonoTag>
        </div>
        <div className="tethr-panel divide-y divide-[var(--tethr-rim)] overflow-hidden">
          <SettingRow title="Model" help={MODELS.find((m) => m.id === integrations.assistant.model)?.hint ?? integrations.assistant.model}>
            <PillChoice
              value={integrations.assistant.model}
              options={MODELS.map((m) => ({ value: m.id, label: m.label }))}
              onChange={(v) => update.mutate({ assistant: { model: v } })}
            />
          </SettingRow>
          <SettingRow
            title="Engine"
            help={
              integrations.assistant.engine === "session"
                ? "One Claude session per chat, with your connectors (new)."
                : "The older multi-agent routing engine (rollback)."
            }
          >
            <PillChoice
              value={integrations.assistant.engine}
              options={[
                { value: "session", label: "Claude session" },
                { value: "routing", label: "Classic" },
              ]}
              onChange={(v) => update.mutate({ assistant: { engine: v as "session" | "routing" } })}
            />
          </SettingRow>
          <SettingRow title="Workspace" help={integrations.workspace.inDrive ? "Inside 00 Tethr, so its files and memory sync to Google Drive." : "Not in Google Drive (00 Tethr isn't connected)."}>
            <span className="max-w-[260px] truncate font-mono text-[11px] tethr-text-3" title={integrations.workspace.dir}>
              {integrations.workspace.dir.split("/").slice(-2).join("/")}
            </span>
          </SettingRow>
        </div>
      </section>

      <OverseerRosterCard companyId={selectedCompanyId} />

      <section className="space-y-3">
        <button
          type="button"
          onClick={() => setClassicOpen((v) => !v)}
          className="flex items-center gap-1.5 px-1 text-[12px] tethr-text-3 transition-colors hover:text-foreground"
        >
          {classicOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Classic engine and infrastructure
        </button>
        {classicOpen ? (
          <div className="space-y-3">
            <LlmModeCard companyId={selectedCompanyId} llm={data.llm} />
            <ProviderCard
              name="Drive storage"
              state={data.storage.provider === "local_disk" ? "local" : "cloud"}
              detail={
                data.storage.provider === "local_disk"
                  ? `Local disk · ${data.storage.localDir ?? ""}`
                  : "S3-compatible object storage"
              }
              swap="StorageProvider → S3 / GCS (env: PAPERCLIP_STORAGE_PROVIDER)"
            />
            <ProviderCard
              name="Database"
              state={data.database.external ? "external postgres" : "embedded postgres"}
              detail={
                data.database.external
                  ? "External Postgres via DATABASE_URL"
                  : "Embedded Postgres (dev). Cloud swap is a DATABASE_URL change."
              }
              swap="Drizzle + versioned migrations"
            />
            <ProviderCard
              name="Notifications"
              state="in-app live"
              detail={data.notifications.channels.join(" · ")}
              swap="Notifier interface → Slack / SMS / email implementations"
            />
            <ProviderCard
              name="Shared workspace"
              state={data.mirror.enabled ? "mirroring" : "off"}
              detail={
                data.mirror.enabled
                  ? `Published deliverables project into ${data.mirror.dir} (Google Drive desktop sync uploads them)`
                  : "TETHR_MIRROR_DIR not set — approved deliverables stay in the in-app Drive only."
              }
              swap="v2 (cloud): Google Drive API via service account"
            />
            <ProviderCard
              name="Spec bundle"
              state={data.bundle.path ? "linked" : "vendored"}
              detail={
                data.bundle.path
                  ? `Reading agent specs from ${data.bundle.path}`
                  : "TETHR_BUNDLE_PATH not set — seeds from the vendored org spec."
              }
              swap="TETHR_BUNDLE_PATH (read-only)"
            />
            <div className="tethr-panel flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-2">
                <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
                <MonoTag>paperclip engine</MonoTag>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{data.paperclipSha.slice(0, 12)}</span>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Secrets never appear here. Keys live in env files outside version control; see .env.example for every knob.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ConnectorRow({
  connector,
  onMode,
  onScope,
}: {
  connector: TethrIntegrationConnector;
  onMode: (mode: TethrConnectorMode) => void;
  onScope: (scope: string) => void;
}) {
  const [scope, setScope] = useState(connector.scope);
  useEffect(() => setScope(connector.scope), [connector.scope]);
  const showScope = connector.mode !== "off" && (connector.scopeHint || connector.scope);
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot tone={MODE_TONE[connector.mode]} />
            <span className="text-[14px] font-medium">{connector.label}</span>
            {!connector.explicit ? <span className="tethr-eyebrow text-[10px]">default</span> : null}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{connector.blurb}</p>
          <p className="mt-0.5 text-[11.5px] tethr-text-3">
            {connector.moneyOnly && connector.mode !== "off" ? "Money always needs you." : MODE_HELP[connector.mode]}
          </p>
        </div>
        <ModeControl value={connector.mode} onChange={onMode} noAuto={connector.moneyOnly} />
      </div>
      {showScope ? (
        <Input
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          onBlur={() => scope !== connector.scope && onScope(scope)}
          placeholder={connector.scopeHint ?? "Limit what Tethr reads here"}
          aria-label={`${connector.label} scope`}
          className="h-8 text-[12.5px]"
        />
      ) : null}
    </div>
  );
}

function ModeControl({
  value,
  onChange,
  noAuto,
}: {
  value: TethrConnectorMode;
  onChange: (m: TethrConnectorMode) => void;
  noAuto?: boolean;
}) {
  return (
    <PillChoice
      value={value}
      options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], disabled: noAuto && m === "auto" }))}
      onChange={(v) => onChange(v as TethrConnectorMode)}
    />
  );
}

function PillChoice({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 self-start rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)] sm:self-auto">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.disabled ? "Money always needs you" : undefined}
          onClick={() => value !== o.value && onChange(o.value)}
          className={cn(
            "h-7 rounded-full px-3 text-[12px] transition-colors disabled:pointer-events-none disabled:opacity-30",
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function SettingRow({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">{title}</p>
        {help ? <p className="mt-0.5 text-[12px] text-muted-foreground">{help}</p> : null}
      </div>
      {children}
    </div>
  );
}

function AddressesField({ value, onSave }: { value: string[]; onSave: (list: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value]);
  const save = () => {
    const list = text
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.join(",") !== value.join(",")) onSave(list);
  };
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && save()}
      placeholder="travelwithwandr.com"
      aria-label="Inside Wandr"
      className="h-8 w-full text-[12.5px] sm:w-64"
    />
  );
}

// The usage throttle: one switch that pauses EVERY agent — heartbeats and
// requests both stop doing LLM work until resumed. The kill switch for
// subscription usage. Paused gets the active-panel treatment + a warn dot so
// it can't be missed (calm, not alarming).
function ThrottleCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: tethrKeys.throttle(companyId),
    queryFn: () => tethrApi.throttle(companyId),
  });
  const mutation = useMutation({
    mutationFn: (paused: boolean) => tethrApi.setThrottle(companyId, paused),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.throttle(companyId) });
    },
  });
  const paused = data?.paused === true;

  return (
    <div className={cn("tethr-panel p-4", paused && "tethr-panel-active")}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={paused ? "warn" : "ok"} />
            {paused ? "Agents paused" : "Agents active"}
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {paused
              ? "Every agent is paused — no heartbeats, no requests, no LLM usage. Resume when you're ready."
              : "Pause every agent instantly (usage throttle) when you're near your Claude limits. Heartbeats + requests both stop."}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <Switch
            on={!paused}
            disabled={mutation.isPending}
            onToggle={() => mutation.mutate(!paused)}
            label={paused ? "Paused" : "Active"}
          />
          <span className="tethr-eyebrow text-[10px]">
            {paused ? "paused" : "active"}
          </span>
        </div>
      </div>
      <p className="tethr-eyebrow mt-3 text-[10px]">
        also toggle from Slack — say “pause agents” / “resume agents”
      </p>
    </div>
  );
}

// The one card that's a real switch, not a status badge: flip the whole
// instance between live Claude and the free deterministic mock at runtime.
function LlmModeCard({
  companyId,
  llm,
}: {
  companyId: string;
  llm: TethrStatus["llm"];
}) {
  const queryClient = useQueryClient();
  const isLive = llm.mode === "live";

  const mutation = useMutation({
    mutationFn: (mode: "live" | "mock") => tethrApi.setLlmMode(companyId, mode),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.status(companyId) });
    },
  });

  const canGoLive = llm.liveKeyPresent;
  const disabled = mutation.isPending || (!isLive && !canGoLive);

  return (
    <div className="tethr-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
            <StatusDot tone={isLive ? "live" : "idle"} />
            Agent intelligence
          </p>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isLive
              ? `Live Claude · ${llm.model}. Every agent reply is a real API call — it spends.`
              : "Deterministic mock — free, offline, no spend. Answers are canned, for testing."}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <Switch
            on={isLive}
            disabled={disabled}
            onToggle={() => mutation.mutate(isLive ? "mock" : "live")}
            label={isLive ? "Live Claude" : "Mock"}
          />
          <span className="tethr-eyebrow text-[10px]">
            {isLive ? "live" : "mock"}
          </span>
        </div>
      </div>
      <p className="tethr-eyebrow mt-3 text-[10px]">
        {!canGoLive
          ? "set ANTHROPIC_API_KEY to enable live · resets to env default on restart"
          : "instance-wide · takes effect on the next request · resets to env default on restart"}
      </p>
      {mutation.isError ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <StatusDot tone="bad" />
          {mutation.error instanceof Error ? mutation.error.message : "Could not switch."}
        </p>
      ) : null}
    </div>
  );
}

function Switch({
  on,
  disabled,
  onToggle,
  label,
}: {
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      // Opts out of index.css's 44px touch-target min-height, which would stretch the pill into a circle on phones.
      data-slot="toggle"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        on
          ? "bg-primary"
          : "bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "inline-block h-[18px] w-[18px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-200",
          on ? "translate-x-[1.4rem] bg-primary-foreground" : "translate-x-[3px] bg-[var(--tethr-text-3)]",
        )}
      />
    </button>
  );
}

function ProviderCard({
  name,
  state,
  detail,
  swap,
}: {
  name: string;
  state: string;
  detail: string;
  swap: string;
}) {
  const live = state === "live" || state === "linked" || state === "external postgres";
  return (
    <div className="tethr-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-medium tracking-[-0.01em]">{name}</p>
        <span className={cn("tethr-pill px-2 py-0.5 text-[10px] leading-4", live && "text-foreground")}>
          <StatusDot tone={live ? "ok" : "idle"} />
          {state}
        </span>
      </div>
      <p className="mt-1.5 break-words text-sm text-muted-foreground">{detail}</p>
      <p className="tethr-eyebrow mt-2 text-[10px]">
        cloud swap: {swap}
      </p>
    </div>
  );
}

const ROSTER_ROLES: { role: TethrOverseerRole; label: string; hint: string }[] = [
  { role: "tech", label: "Tech", hint: "Engineering, debugging, reliability" },
  { role: "exec", label: "Exec", hint: "CEO / strategic decisions" },
  { role: "growth", label: "Growth & Ops", hint: "Marketing, operations, content" },
];

// Who gets buzzed on Slack for each kind of work. Each agent routes to one of
// these three roles; a new tech agent alerts the Tech person automatically.
function OverseerRosterCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["tethr", companyId, "overseers"],
    queryFn: () => tethrApi.overseers(companyId),
  });
  const [draft, setDraft] = useState<Partial<TethrOverseerRoster>>({});
  const save = useMutation({
    mutationFn: (roster: Partial<TethrOverseerRoster>) => tethrApi.setOverseers(companyId, roster),
    onSuccess: () => {
      setDraft({});
      queryClient.invalidateQueries({ queryKey: ["tethr", companyId, "overseers"] });
    },
  });
  const roster = data?.roster;
  const val = (role: TethrOverseerRole, field: "name" | "slackId") =>
    draft[role]?.[field] ?? roster?.[role]?.[field] ?? "";
  const set = (role: TethrOverseerRole, field: "name" | "slackId", v: string) =>
    setDraft((d) => ({
      ...d,
      [role]: {
        name: field === "name" ? v : (d[role]?.name ?? roster?.[role]?.name ?? ""),
        slackId: field === "slackId" ? v : (d[role]?.slackId ?? roster?.[role]?.slackId ?? ""),
      },
    }));

  return (
    <div className="tethr-panel">
      <div className="flex items-center gap-2 border-b tethr-rule px-4 py-3">
        <Users className="h-4 w-4 text-muted-foreground" />
        <MonoTag>overseer roster · who gets buzzed</MonoTag>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Slack alerts route by an agent's role. Set the person + their Slack member ID
          (Slack profile → ⋯ → Copy member ID) for each. New agents auto-route by domain.
        </p>
        {ROSTER_ROLES.map(({ role, label, hint }) => (
          <div
            key={role}
            className="grid gap-2 border-t tethr-rule pt-3 first-of-type:border-t-0 first-of-type:pt-0 sm:grid-cols-[7rem_minmax(0,1fr)_10rem] sm:items-center"
          >
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="tethr-eyebrow text-[10px] tracking-[0.12em]">{hint}</p>
            </div>
            <Input value={val(role, "name")} onChange={(e) => set(role, "name", e.target.value)} placeholder="Name" />
            <Input
              value={val(role, "slackId")}
              onChange={(e) => set(role, "slackId", e.target.value)}
              placeholder="Slack ID (U…)"
              className="font-mono text-xs"
            />
          </div>
        ))}
        <div className="flex justify-end">
          <Button size="sm" disabled={save.isPending || Object.keys(draft).length === 0} onClick={() => save.mutate(draft)}>
            {save.isPending ? "Saving…" : "Save roster"}
          </Button>
        </div>
      </div>
    </div>
  );
}
