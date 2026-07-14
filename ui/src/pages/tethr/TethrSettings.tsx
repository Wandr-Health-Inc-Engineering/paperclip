import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cog, GitCommitHorizontal, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrOverseerRole,
  type TethrOverseerRoster,
  type TethrStatus,
} from "@/api/tethr";

// Tethr settings: provider status (everything behind an interface), the
// env-driven config surfaced read-only, plus the one runtime switch that
// actually flips behavior — live Claude vs the deterministic mock.

export function TethrSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Providers" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading } = useQuery({
    queryKey: tethrKeys.status(selectedCompanyId!),
    queryFn: () => tethrApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cog} message="Select a company first." />;
  }
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!data) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <MonoTag className="text-foreground">● tethr · settings</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">providers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything below sits behind an interface. Moving to the cloud is an env
          change per MIGRATION-NOTES.md, not a rewrite.
        </p>
      </div>

      <div className="space-y-3" data-tethr-stagger>
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
      </div>

      <OverseerRosterCard companyId={selectedCompanyId} />

      <div className="flex items-center justify-between border-2 border-foreground bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <GitCommitHorizontal className="h-4 w-4" />
          <MonoTag className="text-foreground">paperclip engine</MonoTag>
        </div>
        <span className="font-mono text-xs font-bold">
          {data.paperclipSha.slice(0, 12)}
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Secrets never appear here. Keys live in env files outside version control;
        see .env.example for every knob.
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
    <div className="border-2 border-foreground bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-extrabold tracking-tight">Agent intelligence</p>
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
          <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em]">
            {isLive ? "live" : "mock"}
          </span>
        </div>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
        {!canGoLive
          ? "set ANTHROPIC_API_KEY to enable live · resets to env default on restart"
          : "instance-wide · takes effect on the next request · resets to env default on restart"}
      </p>
      {mutation.isError ? (
        <p className="mt-2 border-l-2 border-foreground pl-2 text-xs text-muted-foreground">
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
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full border-2 border-foreground transition-colors",
        on ? "bg-foreground" : "bg-background",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full transition-transform",
          on ? "translate-x-[1.375rem] bg-background" : "translate-x-0.5 bg-foreground",
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
    <div className="border-2 border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-extrabold tracking-tight">{name}</p>
        <span
          className={cn(
            "border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]",
            live
              ? "border-foreground bg-foreground text-background"
              : "border-border text-muted-foreground",
          )}
        >
          {state}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{detail}</p>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
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
    <div className="border-2 border-foreground bg-card">
      <div className="flex items-center gap-2 border-b-2 border-foreground px-4 py-2.5">
        <Users className="h-4 w-4" />
        <MonoTag className="text-foreground">overseer roster · who gets buzzed</MonoTag>
      </div>
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Slack alerts route by an agent's role. Set the person + their Slack member ID
          (Slack profile → ⋯ → Copy member ID) for each. New agents auto-route by domain.
        </p>
        {ROSTER_ROLES.map(({ role, label, hint }) => (
          <div key={role} className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_10rem] sm:items-center">
            <div>
              <p className="text-sm font-bold">{label}</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.1em] text-muted-foreground">{hint}</p>
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
