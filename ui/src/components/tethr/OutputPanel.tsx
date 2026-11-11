import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, X } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { fsSource } from "@/pages/tethr/drive/adapters";
import { FileGlyph, PreviewBody, previewQueryKey } from "@/pages/tethr/drive/filePreview";

// The chat's side panel (phase 18.5): files Tethr writes open here, Claude-
// artifact style, sliding in from the right over the conversation. Opaque
// (tethr-window) so the page never shows through. Reuses the Drive's preview:
// Markdown with front matter, sandboxed HTML, plain text.

export interface PanelFile {
  /** Path relative to the 00 Tethr folder (the Drive "mirror" mount). */
  path: string;
  /** Changes when Tethr edits the file again, so the preview refreshes. */
  version: string;
}

export function OutputPanel({
  companyId,
  files,
  current,
  onSelect,
  onClose,
}: {
  companyId: string;
  files: PanelFile[];
  current: PanelFile;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const source = useMemo(() => fsSource(companyId, "mirror", "00 Tethr"), [companyId]);
  const name = current.path.split("/").pop() ?? current.path;

  // A newer edit of the open file: refetch its preview.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: previewQueryKey(source, current.path) });
  }, [current.version, current.path, queryClient, source]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label={`Preview of ${name}`}
      className="tethr-window tethr-window-lifted absolute inset-y-0 right-0 z-30 flex w-full flex-col overflow-hidden md:w-[min(600px,52%)]"
    >
      <div className="tethr-window-bar flex h-12 shrink-0 items-center gap-2 border-b tethr-rule pl-4 pr-2">
        <FileGlyph item={{ name, kind: "file" }} className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">{name}</p>
          <p className="truncate font-mono text-[10.5px] tethr-text-3" title={current.path}>
            00 Tethr/{current.path}
          </p>
        </div>
        <Link
          to="/drive"
          title="Open the Drive"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
        >
          Drive
          <ArrowUpRight className="h-3 w-3" />
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview (Esc)"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-foreground/80 transition-colors hover:bg-[var(--tethr-select-blur)] hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {files.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b tethr-rule px-3 py-2">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelect(f.path)}
              title={f.path}
              className={cn(
                "inline-flex max-w-[220px] shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors",
                f.path === current.path
                  ? "bg-primary text-primary-foreground"
                  : "bg-[var(--tethr-frost)] text-muted-foreground shadow-[inset_0_0_0_1px_var(--tethr-rim)] hover:text-foreground",
              )}
            >
              <span className="truncate">{f.path.split("/").pop()}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PreviewBody key={`${current.path}@${current.version}`} source={source} item={{ key: current.path, name, kind: "file" }} size="full" />
      </div>
    </aside>
  );
}
