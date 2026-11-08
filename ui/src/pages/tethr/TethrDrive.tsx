import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { Finder, type FinderLocation } from "./drive/Finder";
import { FolderDialog } from "./drive/FolderDialog";
import { fsSource, internalSource } from "./drive/adapters";

// The Drive page: one Finder window. The Google Drive-synced "00 Tethr" folder
// is the default location (what the team sees); Tethr's internal working drive
// and any Google Drive folders the user adds sit beside it in the sidebar. The
// toolbar's Expand button takes the same window full screen for reading.

export function TethrDrive() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [fullscreen, setFullscreen] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Drive" }]);
  }, [setBreadcrumbs]);

  const { data: status } = useQuery({
    queryKey: tethrKeys.status(selectedCompanyId!),
    queryFn: () => tethrApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: mountData } = useQuery({
    queryKey: tethrKeys.fsMounts(selectedCompanyId!),
    queryFn: () => tethrApi.fsMounts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const refreshMounts = () => queryClient.invalidateQueries({ queryKey: tethrKeys.fsMounts(selectedCompanyId!) });
  const { mutate: removeMount } = useMutation({
    mutationFn: (id: string) => tethrApi.fsRemoveMount(selectedCompanyId!, id),
    onSuccess: refreshMounts,
  });

  const mirrorOn = !!status?.mirror?.enabled;
  const mounts = mountData?.mounts;
  const driveRoot = mountData?.driveRoot ?? null;

  const locations = useMemo<FinderLocation[]>(() => {
    if (!selectedCompanyId) return [];
    const out: FinderLocation[] = [];
    if (mirrorOn) {
      out.push({
        id: "mirror",
        label: "00 Tethr",
        group: "Shared",
        icon: "cloud",
        source: fsSource(selectedCompanyId, "mirror", "00 Tethr"),
        note: "syncs to Google Drive",
      });
    }
    out.push({
      id: "internal",
      label: "Working drive",
      group: "Tethr",
      icon: "drive",
      source: internalSource(selectedCompanyId),
      note: "Tethr's database, not synced",
    });
    for (const m of mounts ?? []) {
      out.push({
        id: `ext:${m.id}`,
        label: m.label,
        group: "Google Drive",
        icon: "folder",
        source: fsSource(selectedCompanyId, `ext:${m.id}`, m.label),
        note: "Google Drive folder",
        onRemove: () => removeMount(m.id),
      });
    }
    return out;
  }, [selectedCompanyId, mirrorOn, mounts, removeMount]);

  if (!selectedCompanyId) {
    return <EmptyState icon={HardDrive} message="Select a company to browse the drive." />;
  }

  return (
    // One screen tall; the Finder window takes whatever the note above it leaves.
    <div className="flex h-[calc(100dvh-10rem)] min-h-[480px] flex-col gap-4 md:h-[calc(100dvh-6rem)]">
      {status && !mirrorOn ? (
        <div className="tethr-empty px-4 py-3 text-[13px] text-muted-foreground">
          Google Drive isn't connected, so only the working drive is shown. Set{" "}
          <code className="font-mono">TETHR_MIRROR_DIR</code> to your synced "00 Tethr" folder and make sure Google Drive
          for desktop is running.
        </div>
      ) : null}

      <Finder
        locations={locations}
        onAddLocation={driveRoot ? () => setAdding(true) : undefined}
        addLocationGroup="Google Drive"
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
      />

      {adding && driveRoot ? (
        <FolderDialog
          title="Add a Google Drive folder"
          confirmLabel="Add folder"
          placeholder="e.g. 05 Marketing"
          hint={`Name a folder inside your Google Drive (${shortenPath(driveRoot)}) to browse it here. Only the folders you add are visible.`}
          onClose={() => setAdding(false)}
          onSubmit={async (name) => {
            const folder = name.replace(/^\/+|\/+$/g, "");
            await tethrApi.fsAddMount(selectedCompanyId, `${driveRoot}/${folder}`, folder.split("/").pop());
            refreshMounts();
            setAdding(false);
          }}
        />
      ) : null}
    </div>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  const i = parts.findIndex((s) => s.startsWith("GoogleDrive-"));
  return i >= 0 ? `…/${parts.slice(i + 1).join("/")}` : p;
}
