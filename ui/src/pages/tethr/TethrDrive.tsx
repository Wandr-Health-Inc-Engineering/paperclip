import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  HardDrive,
  History,
  Lock,
  PanelLeft,
  Pencil,
  Tag,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MarkdownBody } from "@/components/MarkdownBody";
import { MonoTag, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrDriveNode } from "@/api/tethr";

// The Drive, as a file manager. Agents write into their own folders (they never
// move or reorganize); this page is the manual surface for a person — browse the
// folder tree, move, rename, make folders, archive. Later this same view points
// at the real Google Drive (the Tethr folder + folders you share with it).

interface Crumb {
  id: string | null;
  name: string;
}

type DriveDialog =
  | { type: "newFolder" }
  | { type: "rename"; node: TethrDriveNode }
  | { type: "move"; node: TethrDriveNode }
  | null;

export function TethrDrive() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: "drive" }]);
  const [selectedFile, setSelectedFile] = useState<TethrDriveNode | null>(null);
  const [showTree, setShowTree] = useState(true);
  const [dialog, setDialog] = useState<DriveDialog>(null);
  const currentFolder = crumbs[crumbs.length - 1];

  useEffect(() => {
    setBreadcrumbs([{ label: "Drive" }]);
  }, [setBreadcrumbs]);

  const { data: children, isLoading } = useQuery({
    queryKey: tethrKeys.drive(selectedCompanyId!, currentFolder.id),
    queryFn: () => tethrApi.drive(selectedCompanyId!, currentFolder.id),
    enabled: !!selectedCompanyId,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["tethr", selectedCompanyId, "drive"] });

  const archiveNode = useMutation({
    mutationFn: (node: TethrDriveNode) =>
      tethrApi.archiveDriveNode(selectedCompanyId!, node.id),
    onSuccess: (_r, node) => {
      if (selectedFile?.id === node.id) setSelectedFile(null);
      void refresh();
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={HardDrive} message="Select a company to browse the drive." />;
  }

  const open = (node: TethrDriveNode) => {
    if (node.kind === "folder") {
      setCrumbs((prev) => [...prev, { id: node.id, name: node.name }]);
      setSelectedFile(null);
    } else {
      setSelectedFile(node);
    }
  };

  const navigateTrail = (trail: Crumb[]) => {
    setCrumbs([{ id: null, name: "drive" }, ...trail]);
    setSelectedFile(null);
  };

  return (
    <div className="space-y-5">
      <div>
        <MonoTag className="text-foreground">● tethr · drive</MonoTag>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the drive</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every file is versioned. Agents write into their own folders; you move,
          rename, and organize by hand — nothing is ever hard-deleted (delete →
          Archive).
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setShowTree((v) => !v)}
          title={showTree ? "Hide folder tree" : "Show folder tree"}
        >
          <PanelLeft className="h-3.5 w-3.5" />
          {showTree ? "Hide tree" : "Show tree"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setDialog({ type: "newFolder" })}
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </Button>
        {/* Path bar */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 border-2 border-foreground bg-card px-3 py-1.5">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.id ?? "root"}-${index}`} className="flex items-center gap-1">
              {index > 0 ? (
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              ) : null}
              <button
                onClick={() => {
                  setCrumbs((prev) => prev.slice(0, index + 1));
                  setSelectedFile(null);
                }}
                className={cn(
                  "px-1 font-mono text-[11px] font-bold uppercase tracking-[0.12em]",
                  index === crumbs.length - 1
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="flex gap-5">
        {showTree ? (
          <aside className="hidden w-56 shrink-0 border-2 border-foreground bg-card p-2 md:block">
            <p className="px-1 pb-2 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              folder tree
            </p>
            <FolderTree
              companyId={selectedCompanyId}
              currentId={currentFolder.id}
              onNavigate={navigateTrail}
            />
          </aside>
        ) : null}

        <div className="min-w-0 flex-1 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {/* Listing */}
          <div className={cn(selectedFile && "hidden lg:block")}>
            {isLoading ? (
              <PageSkeleton variant="list" />
            ) : children?.length ? (
              <div className="space-y-1.5" data-tethr-stagger>
                {children.map((node) => (
                  <div
                    key={node.id}
                    className={cn(
                      "group flex items-center gap-2 border bg-card px-3 py-2.5 transition-colors",
                      selectedFile?.id === node.id
                        ? "border-foreground"
                        : "border-border hover:border-foreground/60",
                    )}
                  >
                    <button
                      onClick={() => open(node)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {node.kind === "folder" ? (
                        <Folder className="h-4 w-4 shrink-0" />
                      ) : (
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {node.name}
                      </span>
                      {node.tags.length > 0 ? (
                        <span className="hidden gap-1 sm:flex">
                          {node.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="border border-border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {node.kind === "file" && node.byteSize != null
                          ? formatBytes(node.byteSize)
                          : ""}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                      <RowAction
                        title="Move"
                        onClick={() => setDialog({ type: "move", node })}
                      >
                        <FolderInput className="h-3.5 w-3.5" />
                      </RowAction>
                      <RowAction
                        title="Rename"
                        onClick={() => setDialog({ type: "rename", node })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </RowAction>
                      <RowAction
                        title="Archive"
                        onClick={() => archiveNode.mutate(node)}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </RowAction>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border border-dashed border-foreground/30 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">Empty folder.</p>
              </div>
            )}
          </div>

          {/* File panel */}
          <div className={cn(!selectedFile && "hidden lg:block")}>
            {selectedFile ? (
              <FilePanel
                companyId={selectedCompanyId}
                node={selectedFile}
                onClose={() => setSelectedFile(null)}
              />
            ) : (
              <div className="flex h-full min-h-64 items-center justify-center border border-dashed border-foreground/30">
                <p className="px-6 text-center text-sm text-muted-foreground">
                  Select a file to preview it, browse versions, and check permissions.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {dialog?.type === "newFolder" ? (
        <NewFolderDialog
          companyId={selectedCompanyId}
          parentId={currentFolder.id}
          parentName={currentFolder.name}
          onClose={() => setDialog(null)}
          onDone={() => {
            void refresh();
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.type === "rename" ? (
        <RenameDialog
          companyId={selectedCompanyId}
          node={dialog.node}
          onClose={() => setDialog(null)}
          onDone={() => {
            void refresh();
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.type === "move" ? (
        <MoveDialog
          companyId={selectedCompanyId}
          node={dialog.node}
          onClose={() => setDialog(null)}
          onDone={() => {
            void refresh();
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function RowAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="border border-transparent p-1 text-muted-foreground hover:border-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

// ---- Folder tree ----------------------------------------------------------------

function FolderTree({
  companyId,
  currentId,
  onNavigate,
  onPick,
  pickedId,
  excludeId,
}: {
  companyId: string;
  currentId?: string | null;
  onNavigate?: (trail: Crumb[]) => void;
  onPick?: (id: string | null) => void;
  pickedId?: string | null;
  excludeId?: string;
}) {
  const { data } = useQuery({
    queryKey: tethrKeys.drive(companyId, null),
    queryFn: () => tethrApi.drive(companyId, null),
  });
  const folders = (data ?? []).filter((n) => n.kind === "folder");
  if (!folders.length) {
    return <p className="px-1 text-xs text-muted-foreground">No folders yet.</p>;
  }
  return (
    <div className="space-y-0.5">
      {folders.map((node) => (
        <TreeNode
          key={node.id}
          companyId={companyId}
          node={node}
          trail={[{ id: node.id, name: node.name }]}
          depth={0}
          currentId={currentId}
          onNavigate={onNavigate}
          onPick={onPick}
          pickedId={pickedId}
          excludeId={excludeId}
        />
      ))}
    </div>
  );
}

function TreeNode({
  companyId,
  node,
  trail,
  depth,
  currentId,
  onNavigate,
  onPick,
  pickedId,
  excludeId,
}: {
  companyId: string;
  node: TethrDriveNode;
  trail: Crumb[];
  depth: number;
  currentId?: string | null;
  onNavigate?: (trail: Crumb[]) => void;
  onPick?: (id: string | null) => void;
  pickedId?: string | null;
  excludeId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data } = useQuery({
    queryKey: tethrKeys.drive(companyId, node.id),
    queryFn: () => tethrApi.drive(companyId, node.id),
    enabled: expanded,
  });
  const subFolders = (data ?? []).filter((n) => n.kind === "folder");
  const isExcluded = excludeId === node.id;
  const active = onPick ? pickedId === node.id : currentId === node.id;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 pr-1",
          isExcluded && "opacity-40",
        )}
        style={{ paddingLeft: depth * 12 }}
      >
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <button
          disabled={isExcluded}
          onClick={() => (onPick ? onPick(node.id) : onNavigate?.(trail))}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-left text-xs",
            active
              ? "font-bold text-foreground"
              : "text-muted-foreground hover:text-foreground",
            isExcluded && "cursor-not-allowed",
          )}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
      </div>
      {expanded
        ? subFolders.map((child) => (
            <TreeNode
              key={child.id}
              companyId={companyId}
              node={child}
              trail={[...trail, { id: child.id, name: child.name }]}
              depth={depth + 1}
              currentId={currentId}
              onNavigate={onNavigate}
              onPick={onPick}
              pickedId={pickedId}
              excludeId={excludeId}
            />
          ))
        : null}
    </div>
  );
}

// ---- Dialogs --------------------------------------------------------------------

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md border-2 border-foreground bg-background"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b-2 border-foreground px-4 py-3">
          <MonoTag className="text-foreground">{title}</MonoTag>
          <button onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function DialogError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="mt-2 border-l-2 border-foreground pl-2 text-xs text-muted-foreground">
      {error instanceof Error ? error.message : "Something went wrong."}
    </p>
  );
}

function NewFolderDialog({
  companyId,
  parentId,
  parentName,
  onClose,
  onDone,
}: {
  companyId: string;
  parentId: string | null;
  parentName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () => tethrApi.createDriveFolder(companyId, parentId, name.trim()),
    onSuccess: onDone,
  });
  return (
    <Modal title="new folder" onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">
        Create a folder inside <span className="font-mono">{parentName}</span>.
      </p>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mutation.mutate();
        }}
        placeholder="folder name"
        className="font-mono text-sm"
      />
      <DialogError error={mutation.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!name.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}

function RenameDialog({
  companyId,
  node,
  onClose,
  onDone,
}: {
  companyId: string;
  node: TethrDriveNode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(node.name);
  const mutation = useMutation({
    mutationFn: () =>
      tethrApi.moveDriveNode(companyId, node.id, { newName: name.trim() }),
    onSuccess: onDone,
  });
  const unchanged = name.trim() === node.name || !name.trim();
  return (
    <Modal title="rename" onClose={onClose}>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !unchanged) mutation.mutate();
        }}
        className="font-mono text-sm"
      />
      <DialogError error={mutation.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={unchanged || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Rename
        </Button>
      </div>
    </Modal>
  );
}

function MoveDialog({
  companyId,
  node,
  onClose,
  onDone,
}: {
  companyId: string;
  node: TethrDriveNode;
  onClose: () => void;
  onDone: () => void;
}) {
  // undefined = nothing picked yet; null = root.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const mutation = useMutation({
    mutationFn: () =>
      tethrApi.moveDriveNode(companyId, node.id, { newParentId: picked ?? null }),
    onSuccess: onDone,
  });
  return (
    <Modal title="move" onClose={onClose}>
      <p className="mb-2 text-xs text-muted-foreground">
        Move <span className="font-mono">{node.name}</span> to:
      </p>
      <div className="max-h-72 overflow-auto border-2 border-border p-2">
        <button
          onClick={() => setPicked(null)}
          className={cn(
            "mb-1 flex w-full items-center gap-1.5 px-1 py-1 text-left text-xs",
            picked === null
              ? "font-bold text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <HardDrive className="h-3.5 w-3.5" />
          drive (root)
        </button>
        <FolderTree
          companyId={companyId}
          onPick={(id) => setPicked(id)}
          pickedId={picked === undefined ? undefined : picked}
          excludeId={node.id}
        />
      </div>
      <DialogError error={mutation.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={picked === undefined || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Move here
        </Button>
      </div>
    </Modal>
  );
}

function FilePanel({
  companyId,
  node,
  onClose,
}: {
  companyId: string;
  node: TethrDriveNode;
  onClose: () => void;
}) {
  const [versionId, setVersionId] = useState<string | undefined>(undefined);

  const { data: detail } = useQuery({
    queryKey: tethrKeys.driveNode(companyId, node.id),
    queryFn: () => tethrApi.driveNode(companyId, node.id),
  });
  const { data: content, isLoading: contentLoading } = useQuery({
    queryKey: tethrKeys.driveContent(companyId, node.id, versionId),
    queryFn: () => tethrApi.driveContent(companyId, node.id, versionId),
  });

  const versions = detail?.versions ?? [];
  const isMarkdown =
    (content?.contentType ?? node.contentType ?? "").includes("markdown") ||
    node.name.endsWith(".md");

  return (
    <div className="border-2 border-foreground bg-card">
      <header className="border-b-2 border-foreground px-4 py-3">
        <button
          onClick={onClose}
          className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground lg:hidden"
        >
          ← back to files
        </button>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <File className="h-4 w-4 shrink-0" />
            <h2 className="truncate text-base font-extrabold tracking-tight">
              {node.name}
            </h2>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {node.path}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {node.tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 border border-border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-muted-foreground"
            >
              <Tag className="h-2.5 w-2.5" />
              {tag}
            </span>
          ))}
          <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3" />
            owner {node.permissions.owner} · read {node.permissions.read.join(", ")} · write{" "}
            {node.permissions.write.join(", ")}
          </span>
        </div>
      </header>

      <div className="max-h-96 overflow-auto px-4 py-4">
        {contentLoading ? (
          <p className="shimmer-text text-sm font-semibold">reading…</p>
        ) : content ? (
          isMarkdown ? (
            <MarkdownBody className="text-sm leading-relaxed">
              {content.content}
            </MarkdownBody>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {content.content}
            </pre>
          )
        ) : (
          <p className="text-sm text-muted-foreground">No content.</p>
        )}
      </div>

      <div className="border-t-2 border-foreground px-4 py-3">
        <div className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <MonoTag>versions</MonoTag>
        </div>
        <div className="mt-2 space-y-1">
          {versions.map((version) => (
            <button
              key={version.id}
              onClick={() => setVersionId(version.id)}
              className={cn(
                "flex w-full items-center justify-between gap-3 border px-2.5 py-1.5 text-left transition-colors",
                (versionId ?? node.currentVersionId) === version.id
                  ? "border-foreground"
                  : "border-border hover:border-foreground/60",
              )}
            >
              <span className="font-mono text-[11px] font-bold">
                v{version.versionNumber}
                {node.currentVersionId === version.id ? (
                  <span className="ml-1.5 text-muted-foreground">· current</span>
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {version.note ?? ""}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {version.createdByTag} · {formatRelative(version.createdAt)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
