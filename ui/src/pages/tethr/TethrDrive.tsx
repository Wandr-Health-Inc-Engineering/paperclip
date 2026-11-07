import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Info, Maximize2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { MonoTag } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { FileManager } from "./drive/FileManager";
import { DriveViewer } from "./drive/DriveViewer";
import { fsSource, internalSource } from "./drive/adapters";

// The Drive page. The Google Drive-synced "00 Tethr" folder is the main view —
// clean, capitalized, what the team sees. Two toggles reveal Tethr's internal
// working drive and any other Google Drive folders the user has added. All three
// use the same modifiable, drag-and-drop file manager.

export function TethrDrive() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showInternal, setShowInternal] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [viewer, setViewer] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Drive" }]);
  }, [setBreadcrumbs]);

  const { data: status } = useQuery({
    queryKey: tethrKeys.status(selectedCompanyId!),
    queryFn: () => tethrApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const mirror = useMemo(
    () => (selectedCompanyId ? fsSource(selectedCompanyId, "mirror", "00 Tethr") : null),
    [selectedCompanyId],
  );
  const internal = useMemo(
    () => (selectedCompanyId ? internalSource(selectedCompanyId) : null),
    [selectedCompanyId],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={HardDrive} message="Select a company to browse the drive." />;
  }

  const mirrorOn = status?.mirror?.enabled;

  return (
    <div className="space-y-5">
      <div>
        <MonoTag>tethr · drive</MonoTag>
        <h1 className="tethr-display mt-2 text-[34px] md:text-[40px]">the drive</h1>
        <p className="mt-2 max-w-[72ch] text-sm text-muted-foreground">
          <span className="font-medium text-foreground">00 Tethr</span> is your shared workspace —
          it syncs to Google Drive, so it's what your team sees. Drag to move, rename, and organize;
          nothing is ever hard-deleted (archive → 99 Archive).
        </p>
      </div>

      {/* Toggles */}
      <div className="tethr-panel flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-8">
        <ToggleRow
          icon={<HardDrive className="h-4 w-4" />}
          label="Internal working drive"
          hint="Tethr's drafts + version history"
          on={showInternal}
          onToggle={() => setShowInternal((v) => !v)}
        />
        <ToggleRow
          icon={<Cloud className="h-4 w-4" />}
          label="Other Google Drive folders"
          hint="Folders you add"
          on={showOther}
          onToggle={() => setShowOther((v) => !v)}
        />
      </div>

      {/* Main: 00 Tethr */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionHeader
            icon={<Cloud className="h-4 w-4" />}
            title="00 Tethr"
            note={mirrorOn ? `synced · ${status?.mirror?.dir ?? ""}` : "not connected"}
          />
          <div className="flex-1" />
          {mirrorOn && mirror ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setViewer(true)}>
              <Maximize2 className="h-3.5 w-3.5" />
              Open viewer
            </Button>
          ) : null}
        </div>
        {mirrorOn && mirror ? (
          <FileManager source={mirror} />
        ) : (
          <NotConnected />
        )}
      </section>

      {/* Toggle: internal working drive */}
      {showInternal && internal ? (
        <section className="space-y-2">
          <SectionHeader
            icon={<HardDrive className="h-4 w-4" />}
            title="Internal working drive"
            note="Tethr's database — drafts, versions, chat logs (not synced to Google Drive)"
          />
          <FileManager source={internal} />
        </section>
      ) : null}

      {/* Toggle: other Google Drive folders */}
      {showOther ? <MountsSection companyId={selectedCompanyId} /> : null}

      {viewer && mirror ? <DriveViewer source={mirror} onClose={() => setViewer(false)} /> : null}
    </div>
  );
}

function ToggleRow({
  icon,
  label,
  hint,
  on,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch on={on} onToggle={onToggle} label={label} />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <div>
          <div className="text-sm font-medium leading-tight">{label}</div>
          <div className="tethr-eyebrow text-[9.5px] tracking-[0.12em]">{hint}</div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title, note }: { icon: React.ReactNode; title: string; note?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-[15px] font-medium tracking-[-0.01em]">{title}</span>
      {note ? (
        <span className="hidden truncate font-mono text-[10.5px] text-[var(--tethr-text-3)] sm:inline">· {note}</span>
      ) : null}
    </div>
  );
}

function NotConnected() {
  return (
    <div className="tethr-empty tethr-reeds px-4 py-10 text-center">
      <p className="text-sm text-muted-foreground">
        Google Drive isn't connected. Set <code className="font-mono">TETHR_MIRROR_DIR</code> to your
        synced "00 Tethr" folder and make sure Google Drive for desktop is running.
      </p>
    </div>
  );
}

// ---- "Other Google Drive folders": the user's allowlist -------------------

function MountsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data } = useQuery({
    queryKey: tethrKeys.fsMounts(companyId),
    queryFn: () => tethrApi.fsMounts(companyId),
  });
  const refreshMounts = () => queryClient.invalidateQueries({ queryKey: tethrKeys.fsMounts(companyId) });

  const removeMut = useMutation({
    mutationFn: (id: string) => tethrApi.fsRemoveMount(companyId, id),
    onSuccess: refreshMounts,
  });

  const mounts = data?.mounts ?? [];
  const driveRoot = data?.driveRoot ?? null;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <SectionHeader icon={<Cloud className="h-4 w-4" />} title="Other Google Drive folders" />
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding(true)} disabled={!driveRoot}>
          <Plus className="h-3.5 w-3.5" />
          Add folder
        </Button>
      </div>

      {!driveRoot ? (
        <div className="tethr-empty px-4 py-6 text-center text-sm">
          Connect Google Drive (00 Tethr) first to add other folders.
        </div>
      ) : mounts.length === 0 ? (
        <div className="tethr-empty flex items-start gap-2 px-4 py-6 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            No other folders yet. Add any folder from your Google Drive (e.g. <code className="font-mono">05 Marketing</code>)
            to browse and organize it here. Only the folders you add are visible.
          </span>
        </div>
      ) : (
        <div className="space-y-4">
          {mounts.map((m) => (
            <div key={m.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{m.label}</span>
                <button
                  onClick={() => removeMut.mutate(m.id)}
                  title="Remove from view (folder stays in Google Drive)"
                  className="tethr-btn tethr-btn-ghost h-6 w-6"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <FileManager source={fsSource(companyId, `ext:${m.id}`, m.label)} />
            </div>
          ))}
        </div>
      )}

      {adding && driveRoot ? (
        <AddFolderDialog
          companyId={companyId}
          driveRoot={driveRoot}
          onClose={() => setAdding(false)}
          onAdded={() => {
            refreshMounts();
            setAdding(false);
          }}
        />
      ) : null}
    </section>
  );
}

function AddFolderDialog({
  companyId,
  driveRoot,
  onClose,
  onAdded,
}: {
  companyId: string;
  driveRoot: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const folder = name.trim().replace(/^\/+|\/+$/g, "");
    if (!folder || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await tethrApi.fsAddMount(companyId, `${driveRoot}/${folder}`, folder.split("/").pop());
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't add that folder.");
      setBusy(false);
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--tethr-overlay)] p-4 backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div className="tethr-glass-heavy w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-medium tracking-[-0.01em]">Add a Google Drive folder</h3>
          <button onClick={onClose} aria-label="Close" className="tethr-btn tethr-btn-ghost h-7 w-7">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          Name a folder inside your Google Drive to browse it here. It stays scoped to just that folder.
        </p>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. 05 Marketing"
        />
        <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
          under {shortenPath(driveRoot)}
        </p>
        {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "…" : "Add folder"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  const i = parts.findIndex((s) => s.startsWith("GoogleDrive-"));
  return i >= 0 ? `…/${parts.slice(i + 1).join("/")}` : p;
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        on
          ? "bg-primary"
          : "bg-[var(--tethr-frost-strong)] shadow-[inset_0_0_0_1px_var(--tethr-rim-strong)]",
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
