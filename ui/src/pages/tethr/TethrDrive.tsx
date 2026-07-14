import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Info, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { MonoTag } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { FileManager } from "./drive/FileManager";
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
        <MonoTag className="text-foreground">● tethr · drive</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the drive</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">00 Tethr</span> is your shared workspace —
          it syncs to Google Drive, so it's what your team sees. Drag to move, rename, and organize;
          nothing is ever hard-deleted (archive → 99 Archive).
        </p>
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-2 border-2 border-foreground bg-card px-4 py-3 sm:flex-row sm:items-center sm:gap-6">
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
        <SectionHeader
          icon={<Cloud className="h-4 w-4" />}
          title="00 Tethr"
          note={mirrorOn ? `synced · ${status?.mirror?.dir ?? ""}` : "not connected"}
        />
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
      <div className="flex items-center gap-1.5">
        {icon}
        <div>
          <div className="text-sm font-semibold leading-tight">{label}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{hint}</div>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ icon, title, note }: { icon: React.ReactNode; title: string; note?: string }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em]">{title}</span>
      {note ? (
        <span className="hidden truncate font-mono text-[10px] text-muted-foreground sm:inline">· {note}</span>
      ) : null}
    </div>
  );
}

function NotConnected() {
  return (
    <div className="border-2 border-dashed border-foreground/30 px-4 py-8 text-center">
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
        <div className="border-2 border-dashed border-foreground/30 px-4 py-6 text-center text-sm text-muted-foreground">
          Connect Google Drive (00 Tethr) first to add other folders.
        </div>
      ) : mounts.length === 0 ? (
        <div className="flex items-start gap-2 border-2 border-dashed border-foreground/30 px-4 py-6 text-sm text-muted-foreground">
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
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">{m.label}</span>
                <button
                  onClick={() => removeMut.mutate(m.id)}
                  title="Remove from view (folder stays in Google Drive)"
                  className="border border-transparent p-0.5 text-muted-foreground hover:border-foreground hover:text-foreground"
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md border-2 border-foreground bg-card p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-xs font-bold uppercase tracking-[0.14em]">Add a Google Drive folder</h3>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
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
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-foreground transition-colors",
        on ? "bg-foreground" : "bg-background",
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
