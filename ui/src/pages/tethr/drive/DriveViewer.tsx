import { useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cloud,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import type { DriveSource, FmItem } from "./adapters";
import { FolderDialog } from "./FileManager";

// A full-screen, MD-first reader/manager for the 00 Tethr folder. Left: the
// whole folder tree (lazy-expanding). Right: the selected file rendered large.
// Smoked Glass L3: a heavy-glass sheet over a dimmed page, frosted tree pane,
// generous reading whitespace. Reuses the fs source.

export function DriveViewer({ source, onClose }: { source: DriveSource; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<FmItem | null>(null);
  const [dialog, setDialog] = useState<{ type: "newFolder"; ref: string } | { type: "rename"; item: FmItem } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: source.invalidateKey });
  const archive = useMutation({
    mutationFn: (key: string) => source.archive(key),
    onSuccess: (_r, key) => {
      if (selected?.key === key) setSelected(null);
      refresh();
    },
  });

  const parentRef = (key: string) => {
    const i = key.lastIndexOf("/");
    return i === -1 ? "" : key.slice(0, i);
  };

  // Portal to <body> so the full-screen overlay escapes any transformed
  // ancestor (the page's stagger animations) and truly covers the viewport.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex bg-[var(--tethr-overlay)] p-2 backdrop-blur-[6px] md:p-5">
    <div className="tethr-glass-heavy flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b tethr-rule px-4 py-2.5">
        <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm font-medium">00 Tethr · viewer</span>
        <div className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--tethr-text-3)]">
          {selected ? `· ${selected.key}` : "· pick a file to read"}
        </div>
        <button
          onClick={() => setDialog({ type: "newFolder", ref: selected ? parentRef(selected.key) : "" })}
          title="New folder"
          className="tethr-btn tethr-btn-ghost h-8 w-8 shrink-0"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
        {selected ? (
          <>
            <button
              onClick={() => setDialog({ type: "rename", item: selected })}
              title="Rename"
              className="tethr-btn tethr-btn-ghost h-8 w-8 shrink-0"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={() => archive.mutate(selected.key)}
              title="Archive"
              className="tethr-btn tethr-btn-ghost h-8 w-8 shrink-0"
            >
              <Archive className="h-4 w-4" />
            </button>
          </>
        ) : null}
        <Button variant="outline" size="sm" className="ml-1 shrink-0 gap-1.5" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
          Close
        </Button>
      </div>

      {/* Body: tree + reader */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 overflow-y-auto border-e tethr-rule bg-[var(--tethr-frost)] p-2">
          <TreeLevel source={source} folderRef="" depth={0} selectedKey={selected?.key ?? null} onSelectFile={setSelected} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          {selected ? (
            <Reader source={source} item={selected} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">Select a file on the left to read it.</p>
            </div>
          )}
        </main>
      </div>

    </div>

      {dialog?.type === "newFolder" ? (
        <FolderDialog
          title="New folder"
          confirmLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await source.createFolder(dialog.ref, name);
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
            await source.rename(dialog.item.key, parentRef(dialog.item.key), name);
            refresh();
            setSelected(null);
            setDialog(null);
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

/** One lazily-loaded level of the folder tree. Folders expand; files select. */
function TreeLevel({
  source,
  folderRef,
  depth,
  selectedKey,
  onSelectFile,
}: {
  source: DriveSource;
  folderRef: string;
  depth: number;
  selectedKey: string | null;
  onSelectFile: (item: FmItem) => void;
}) {
  const { data: items, isLoading } = useQuery({
    queryKey: source.listKey(folderRef),
    queryFn: () => source.list(folderRef),
  });
  if (isLoading) {
    return <p className="px-2 py-1 font-mono text-[10.5px] text-[var(--tethr-text-3)]">…</p>;
  }
  if (!items?.length) {
    return depth === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">Empty.</p> : null;
  }
  return (
    <div className="space-y-0.5">
      {items.map((item) =>
        item.kind === "folder" ? (
          <FolderNode
            key={item.key}
            source={source}
            item={item}
            depth={depth}
            selectedKey={selectedKey}
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileNode key={item.key} item={item} depth={depth} selected={selectedKey === item.key} onSelect={() => onSelectFile(item)} />
        ),
      )}
    </div>
  );
}

function FolderNode({
  source,
  item,
  depth,
  selectedKey,
  onSelectFile,
}: {
  source: DriveSource;
  item: FmItem;
  depth: number;
  selectedKey: string | null;
  onSelectFile: (item: FmItem) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm font-medium transition-colors hover:bg-[var(--tethr-frost-strong)]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--tethr-text-3)]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--tethr-text-3)]" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{item.name}</span>
      </button>
      {open ? (
        <TreeLevel source={source} folderRef={item.key} depth={depth + 1} selectedKey={selectedKey} onSelectFile={onSelectFile} />
      ) : null}
    </div>
  );
}

function FileNode({ item, depth, selected, onSelect }: { item: FmItem; depth: number; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      style={{ paddingLeft: `${depth * 12 + 18}px` }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
        selected
          ? "tethr-panel-active text-foreground"
          : "text-muted-foreground hover:bg-[var(--tethr-frost-strong)] hover:text-foreground",
      )}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{item.name}</span>
    </button>
  );
}

function Reader({ source, item }: { source: DriveSource; item: FmItem }) {
  const { data, isLoading, error } = useQuery({
    queryKey: [...source.invalidateKey, "read", item.key],
    queryFn: () => source.read(item.key),
  });
  const isMarkdown = /\.(md|markdown)$/i.test(item.name);
  return (
    <div className="mx-auto max-w-[68ch] px-6 py-8 md:px-10 md:py-12">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Reading…</p>
      ) : error || data?.kind === "missing" ? (
        <p className="text-sm text-muted-foreground">Couldn't read this file.</p>
      ) : data?.kind === "text" ? (
        isMarkdown ? (
          <MarkdownBody className="text-[15px] leading-relaxed">{data.content ?? ""}</MarkdownBody>
        ) : (
          <pre className="tethr-inset whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed">
            {data.content}
          </pre>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          {data?.kind === "toolarge" ? "This file is too large to preview." : "This file type can't be previewed."}{" "}
          Open it in Google Drive or Finder.
        </p>
      )}
    </div>
  );
}
