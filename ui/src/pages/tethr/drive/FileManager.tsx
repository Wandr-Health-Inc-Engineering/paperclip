import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Archive,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  GripVertical,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MarkdownBody } from "@/components/MarkdownBody";
import { formatRelative } from "@/components/tethr/primitives";
import { cn } from "@/lib/utils";
import type { DriveSource, FmItem } from "./adapters";

interface Crumb {
  ref: string;
  name: string;
}

/** A store-agnostic file manager: browse, new folder, rename, drag-to-move,
 * archive — identical UI for the DB drive and any synced folder. */
export function FileManager({ source }: { source: DriveSource }) {
  const queryClient = useQueryClient();
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ ref: "", name: source.rootLabel }]);
  const [dialog, setDialog] = useState<{ type: "newFolder" } | { type: "rename"; item: FmItem } | null>(null);
  const [activeItem, setActiveItem] = useState<FmItem | null>(null);
  const [preview, setPreview] = useState<FmItem | null>(null);
  const current = crumbs[crumbs.length - 1];

  // Reset to root if the source identity changes (e.g. a mount is removed).
  useEffect(() => {
    setCrumbs([{ ref: "", name: source.rootLabel }]);
  }, [source.id, source.rootLabel]);

  const { data: items, isLoading, error } = useQuery({
    queryKey: source.listKey(current.ref),
    queryFn: () => source.list(current.ref),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: source.invalidateKey });

  const moveMut = useMutation({
    mutationFn: ({ key, toRef }: { key: string; toRef: string }) => source.move(key, toRef),
    onSuccess: refresh,
  });
  const archiveMut = useMutation({
    mutationFn: (key: string) => source.archive(key),
    onSuccess: refresh,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function onDragStart(e: DragStartEvent) {
    setActiveItem(items?.find((i) => i.key === e.active.id) ?? null);
  }
  function onDragEnd(e: DragEndEvent) {
    setActiveItem(null);
    const { active, over } = e;
    if (!over) return;
    const key = String(active.id);
    // Drop target: a folder row (id = its key) or a breadcrumb ("up:<ref>").
    const overId = String(over.id);
    const toRef = overId.startsWith("up:") ? overId.slice(3) : overId;
    if (toRef === key) return; // onto itself
    moveMut.mutate({ key, toRef });
  }

  const open = (item: FmItem) => {
    if (item.kind === "folder") setCrumbs((prev) => [...prev, { ref: item.key, name: item.name }]);
    else setPreview(item);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <div className="border-2 border-foreground bg-card">
        {/* Toolbar: breadcrumbs (droppable to move up) + new folder */}
        <div className="flex flex-wrap items-center gap-2 border-b-2 border-foreground px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {crumbs.map((crumb, index) => (
              <CrumbButton
                key={`${crumb.ref}-${index}`}
                crumb={crumb}
                isLast={index === crumbs.length - 1}
                showChevron={index > 0}
                onClick={() => setCrumbs((prev) => prev.slice(0, index + 1))}
              />
            ))}
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setDialog({ type: "newFolder" })}>
            <FolderPlus className="h-3.5 w-3.5" />
            New folder
          </Button>
        </div>

        {/* Listing */}
        <div className="p-2">
          {isLoading ? (
            <PageSkeleton variant="list" />
          ) : error ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Couldn't read this folder{source.isFs ? " (is Google Drive mounted?)" : ""}.
            </p>
          ) : items?.length ? (
            <div className="space-y-1">
              {items.map((item) => (
                <Row
                  key={item.key}
                  item={item}
                  onOpen={() => open(item)}
                  onRename={() => setDialog({ type: "rename", item })}
                  onArchive={() => archiveMut.mutate(item.key)}
                />
              ))}
            </div>
          ) : (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">Empty folder.</p>
          )}
        </div>
      </div>

      <DragOverlay>
        {activeItem ? (
          <div className="flex items-center gap-2 border-2 border-foreground bg-card px-3 py-2 text-sm font-semibold shadow-lg">
            {activeItem.kind === "folder" ? <Folder className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            {activeItem.name}
          </div>
        ) : null}
      </DragOverlay>

      {dialog?.type === "newFolder" ? (
        <FolderDialog
          title="New folder"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await source.createFolder(current.ref, name);
            refresh();
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.type === "rename" ? (
        <FolderDialog
          title="Rename"
          confirmLabel="Rename"
          initial={dialog.item.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await source.rename(dialog.item.key, current.ref, name);
            refresh();
            setDialog(null);
          }}
        />
      ) : null}
      {preview ? (
        <PreviewModal source={source} item={preview} onClose={() => setPreview(null)} />
      ) : null}
    </DndContext>
  );
}

/** Read a file in-app. Text/markdown render inline; other types point at Drive. */
function PreviewModal({ source, item, onClose }: { source: DriveSource; item: FmItem; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: [...source.invalidateKey, "read", item.key],
    queryFn: () => source.read(item.key),
  });
  const isMarkdown = /\.(md|markdown)$/i.test(item.name);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col border-2 border-foreground bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b-2 border-foreground px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate text-sm font-bold">{item.name}</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-auto px-5 py-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Reading…</p>
          ) : error || data?.kind === "missing" ? (
            <p className="text-sm text-muted-foreground">Couldn't read this file.</p>
          ) : data?.kind === "text" ? (
            isMarkdown ? (
              <MarkdownBody className="text-sm leading-relaxed">{data.content ?? ""}</MarkdownBody>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{data.content}</pre>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              {data?.kind === "toolarge" ? "This file is too large to preview here." : "This file type can't be previewed in-app."}{" "}
              {source.isFs ? "Open it in Google Drive or Finder." : "Open it from the drive."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** A breadcrumb that is also a drop target (drag an item onto an ancestor to move it up). */
function CrumbButton({
  crumb,
  isLast,
  showChevron,
  onClick,
}: {
  crumb: Crumb;
  isLast: boolean;
  showChevron: boolean;
  onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `up:${crumb.ref}` });
  return (
    <span className="flex items-center gap-1">
      {showChevron ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : null}
      <button
        ref={setNodeRef}
        onClick={onClick}
        className={cn(
          "px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em]",
          isOver && "bg-foreground text-background",
          isLast ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {crumb.name}
      </button>
    </span>
  );
}

/** A file/folder row: draggable everywhere; folders are also drop targets. */
function Row({
  item,
  onOpen,
  onRename,
  onArchive,
}: {
  item: FmItem;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
}) {
  const drag = useDraggable({ id: item.key });
  const drop = useDroppable({ id: item.key, disabled: item.kind !== "folder" });
  const setRef = useCombinedRefs(drag.setNodeRef, item.kind === "folder" ? drop.setNodeRef : null);
  const isFolder = item.kind === "folder";

  return (
    <div
      ref={setRef}
      className={cn(
        "group flex items-center gap-2 border bg-card px-3 py-2.5 transition-colors",
        drag.isDragging ? "opacity-40" : "",
        isFolder && drop.isOver ? "border-foreground bg-accent" : "border-border hover:border-foreground/60",
      )}
    >
      <button
        {...drag.listeners}
        {...drag.attributes}
        aria-label="Drag to move"
        className="cursor-grab text-muted-foreground/50 hover:text-foreground active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {isFolder ? (
          <Folder className="h-4 w-4 shrink-0" />
        ) : (
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {item.kind === "file" && item.size != null ? formatBytes(item.size) : ""}
        </span>
        {item.modifiedAt ? (
          <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
            {formatRelative(item.modifiedAt)}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
        <RowAction title="Rename" onClick={onRename}>
          <Pencil className="h-3.5 w-3.5" />
        </RowAction>
        <RowAction title="Archive" onClick={onArchive}>
          <Archive className="h-3.5 w-3.5" />
        </RowAction>
      </div>
    </div>
  );
}

function RowAction({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="border border-transparent p-1 text-muted-foreground hover:border-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}

function FolderDialog({
  title,
  confirmLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  initial?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(name.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm border-2 border-foreground bg-card p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-xs font-bold uppercase tracking-[0.14em]">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Name"
        />
        {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function useCombinedRefs(...refs: Array<((node: HTMLElement | null) => void) | null>) {
  return useCallback((node: HTMLElement | null) => {
    for (const ref of refs) if (ref) ref(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refs);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
