import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cog, GitCommitHorizontal } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";

// Tethr settings: provider status (everything behind an interface), the
// env-driven config surfaced read-only, and the vendored Paperclip SHA.

export function TethrSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Tethr Settings" }]);
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
        <ProviderCard
          name="Agent intelligence"
          state={data.llm.provider === "claude" ? "live" : "mock"}
          detail={
            data.llm.provider === "claude"
              ? `Claude API · ${data.llm.model}`
              : `Deterministic mock (${data.llm.model}). Set ANTHROPIC_API_KEY for live calls — no code change.`
          }
          swap="LLMProvider → ClaudeProvider"
        />
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
