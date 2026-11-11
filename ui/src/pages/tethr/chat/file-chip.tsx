import { useState } from "react";
import { FileImage, FileText, X } from "lucide-react";
import { StatusDot } from "@/components/tethr/primitives";
import { CHIP_HOVER, CHIP_SURFACE } from "@/components/tethr/Chip";
import type { TethrChatAttachment } from "@/api/tethr";
import { cn } from "@/lib/utils";

/** A file pill: opens in the side panel when it can. */
export function FileChip({
  name,
  kind,
  detail,
  tone,
  onClick,
  onRemove,
}: {
  name: string;
  kind?: TethrChatAttachment["kind"];
  detail?: string;
  tone?: "live" | "bad";
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const Icon = kind === "image" ? FileImage : FileText;
  const body = (
    <>
      {tone ? <StatusDot tone={tone} /> : <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      <span className="max-w-[200px] truncate">{name}</span>
      {detail ? <span className="shrink-0 font-mono text-[10.5px] tethr-text-3">{detail}</span> : null}
    </>
  );
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full py-1 text-[12px]", CHIP_SURFACE, onRemove ? "pl-2.5 pr-1" : "px-2.5", onClick && CHIP_HOVER)}>
      {onClick ? (
        <button type="button" onClick={onClick} title={`Open ${name}`} className="inline-flex min-w-0 items-center gap-1.5">
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1.5" title={name}>
          {body}
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-[var(--tethr-frost-strong)] hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

const SHOWN = 2;

/** A turn's files: the first two, then "+N more" (a wall of file pills is noise). */
export function FileChips({ files, onOpen }: { files: string[]; onOpen: (path: string) => void }) {
  const [all, setAll] = useState(false);
  if (!files.length) return null;
  const shown = all ? files : files.slice(0, SHOWN);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((f) => (
        <FileChip key={f} name={f.split("/").pop() ?? f} onClick={() => onOpen(f)} />
      ))}
      {files.length > SHOWN ? (
        <button type="button" onClick={() => setAll((v) => !v)} className="tethr-touch-sized rounded-full px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
          {all ? "Fewer" : `+${files.length - SHOWN} more`}
        </button>
      ) : null}
    </div>
  );
}
