import { useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A one-field name dialog (new folder, rename). Portaled to <body> so it is
 * never trapped by a transformed ancestor, and stacked above the full-screen
 * Finder. The scrim only dims; the sheet's own glass does the blurring. */
export function FolderDialog({
  title,
  confirmLabel,
  initial,
  hint,
  placeholder = "Name",
  onClose,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  initial?: string;
  hint?: string;
  placeholder?: string;
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
  return createPortal(
    <div className="tethr-scrim fixed inset-0 z-[85] flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="tethr-window tethr-window-lifted w-full max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="tethr-btn tethr-btn-ghost h-7 w-7">
            <X className="h-4 w-4" />
          </button>
        </div>
        {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : null}
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={(e) => {
            // Select the name without the extension, like Finder's rename.
            const dot = e.currentTarget.value.lastIndexOf(".");
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
          }}
          placeholder={placeholder}
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
    </div>,
    document.body,
  );
}
