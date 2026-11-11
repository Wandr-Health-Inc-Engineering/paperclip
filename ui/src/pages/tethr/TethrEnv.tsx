import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, StatusDot } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrEnvEntry } from "@/api/tethr";

// Environment (phase 19.2): the instance .env file tethr loads at boot, edited
// like a hosting dashboard's environment variables. Values stay hidden until
// you reveal one; saving applies to the running server right away (settings it
// only reads at startup still need a restart).

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** "KEY=value" lines (as pasted from a .env file) → pairs. Comments and blanks are skipped. */
export function parseEnvPaste(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith("#")) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'" || q === "`") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out.push({ key: m[1], value });
  }
  return out;
}

/** Same rule as the server's isCoreKey (server/src/tethr/env-file.ts). */
const CORE_KEY = /^(PAPERCLIP_|BETTER_AUTH_|DATABASE_URL$|PORT$|HOST$|NODE_ENV$)/;

/** The question asked before saving several pasted settings: what's new, what
 * gets replaced, and which ones tethr itself depends on. */
export function pasteConfirmText(pairs: Array<{ key: string }>, existing: Set<string>): string {
  const keys = [...new Set(pairs.map((p) => p.key))];
  const added = keys.filter((k) => !existing.has(k));
  const replaced = keys.filter((k) => existing.has(k));
  const core = keys.filter((k) => CORE_KEY.test(k));
  const parts = [`Save these ${keys.length} settings?`];
  if (added.length) parts.push(`New: ${added.join(", ")}`);
  if (replaced.length) parts.push(`Replaces the current value of: ${replaced.join(", ")}`);
  if (core.length) parts.push(`tethr itself depends on ${core.join(", ")} (database, login or server); a wrong value can stop it from starting.`);
  return parts.join("\n\n");
}

export function TethrEnv() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const c = selectedCompanyId ?? "";
  const [filter, setFilter] = useState("");
  const [showKnown, setShowKnown] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [showDraft, setShowDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Environment" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: tethrKeys.env(c),
    queryFn: () => tethrApi.env(c),
    enabled: !!selectedCompanyId,
  });
  // The setup's Connections step reads these keys too, so it refreshes with them.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: tethrKeys.env(c) });
    void queryClient.invalidateQueries({ queryKey: tethrKeys.setup(c) });
  };

  const add = useMutation({
    mutationFn: async (pairs: Array<{ key: string; value: string }>) => {
      for (const p of pairs) await tethrApi.setEnv(c, p.key, p.value);
      return pairs;
    },
    onSuccess: (pairs) => {
      setDraftKey("");
      setDraftValue("");
      setShowDraft(false);
      setError(null);
      setSaved(pairs.length === 1 ? `Saved ${pairs[0].key}.` : `Saved ${pairs.length} settings.`);
      window.setTimeout(() => setSaved(null), 4000);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save that."),
    onSettled: refresh,
  });

  if (!selectedCompanyId) return <EmptyState icon={KeyRound} message="Select a company first." />;
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (loadError || !data) {
    return (
      <EmptyState
        icon={KeyRound}
        message={loadError instanceof Error ? loadError.message : "Couldn't read the environment file."}
      />
    );
  }

  const existing = new Set(data.entries.map((e) => e.key));
  const q = filter.trim().toLowerCase();
  const entries = q ? data.entries.filter((e) => e.key.toLowerCase().includes(q)) : data.entries;
  const known = q ? data.suggestions.filter((s) => s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) : data.suggestions;
  const stale = data.entries.filter((e) => !e.active);

  const submit = () => {
    const key = draftKey.trim();
    if (!KEY_RE.test(key)) {
      setError("Names use letters, digits and underscores, and can't start with a digit.");
      return;
    }
    if (existing.has(key) && !window.confirm(`${key} is already set. Replace its value?`)) return;
    add.mutate([{ key, value: draftValue }]);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1 px-1">
        <h1 className="tethr-display text-[26px]">Environment</h1>
        <p className="text-[13px] text-muted-foreground">
          API keys and settings tethr reads from its <span className="font-mono text-[12px]">.env</span> file on this Mac.
          Saving applies right away; a few settings (database, login, Slack connection) only load when tethr restarts.
        </p>
        <p className="truncate font-mono text-[11px] tethr-text-3" title={data.path}>
          {data.path}
        </p>
      </div>

      {/* Add a setting (or paste several KEY=value lines into the name box). */}
      <section className="space-y-2">
        <div className="px-1">
          <MonoTag>add</MonoTag>
        </div>
        <div className="tethr-panel space-y-2.5 p-3.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value.replace(/\s/g, "_"))}
              onPaste={(e) => {
                const pairs = parseEnvPaste(e.clipboardData.getData("text"));
                if (!pairs.length) return;
                e.preventDefault();
                if (pairs.length === 1) {
                  setDraftKey(pairs[0].key);
                  setDraftValue(pairs[0].value);
                  valueRef.current?.focus();
                } else if (window.confirm(pasteConfirmText(pairs, existing))) {
                  add.mutate(pairs);
                }
              }}
              placeholder="NAME, or paste KEY=value lines"
              aria-label="Setting name"
              spellCheck={false}
              autoCapitalize="characters"
              className="h-9 font-mono text-[13px] sm:w-[42%]"
            />
            <div className="relative flex-1">
              <Input
                ref={valueRef}
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                type={showDraft ? "text" : "password"}
                placeholder="Value"
                aria-label="Setting value"
                spellCheck={false}
                autoComplete="off"
                className="h-9 pr-9 font-mono text-[13px]"
              />
              <button
                type="button"
                onClick={() => setShowDraft((s) => !s)}
                aria-label={showDraft ? "Hide value" : "Show value"}
                className="absolute right-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
              >
                {showDraft ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <button
              type="button"
              onClick={submit}
              disabled={!draftKey.trim() || add.isPending}
              className="tethr-btn tethr-btn-primary h-9 shrink-0 px-4 text-[12.5px]"
            >
              <Plus className="h-3.5 w-3.5" /> Save
            </button>
          </div>
          {error ? <p className="text-[12px] text-[var(--tethr-bad)]">{error}</p> : null}
          {saved ? <p className="text-[12px] tethr-text-3">{saved}</p> : null}
        </div>
      </section>

      {stale.length ? (
        <div className="tethr-panel flex items-start gap-2.5 px-3.5 py-3 text-[12.5px]">
          <StatusDot tone="warn" className="mt-1.5" />
          <p>
            The running server has a different value for <span className="font-mono">{stale.map((e) => e.key).join(", ")}</span> than the
            file (set before tethr started, or edited outside this page). Restart tethr to use the file's value.
          </p>
        </div>
      ) : null}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 px-1">
          <MonoTag>{`${data.entries.length} ${data.entries.length === 1 ? "setting" : "settings"}`}</MonoTag>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search"
            aria-label="Search settings"
            className="h-8 w-44 text-[12.5px]"
          />
        </div>
        {entries.length ? (
          <div className="tethr-panel divide-y divide-[var(--tethr-rim)] overflow-hidden">
            {entries.map((e) => (
              <EnvRow key={e.key} companyId={c} entry={e} onChanged={refresh} />
            ))}
          </div>
        ) : (
          <div className="tethr-panel px-4 py-6 text-center text-[13px] text-muted-foreground">
            {data.exists ? "No settings match." : "There's no .env file yet. Add a setting above to create it."}
          </div>
        )}
      </section>

      {data.suggestions.length ? (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setShowKnown((s) => !s)}
            className="flex items-center gap-1.5 px-1 text-[12px] tethr-text-3 hover:text-foreground"
          >
            {showKnown ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Other settings tethr understands ({data.suggestions.length})
          </button>
          {showKnown ? (
            <div className="tethr-panel divide-y divide-[var(--tethr-rim)] overflow-hidden">
              {known.map((s) => (
                <div key={s.key} className="flex items-start gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[12.5px]">{s.key}</p>
                    {s.description ? <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{s.description}</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftKey(s.key);
                      setDraftValue("");
                      setError(null);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                      window.setTimeout(() => valueRef.current?.focus(), 250);
                    }}
                    className="tethr-btn tethr-btn-ghost h-7 shrink-0 px-3 text-[12px]"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function EnvRow({ companyId, entry, onChanged }: { companyId: string; entry: TethrEnvEntry; onChanged: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = useMutation({
    mutationFn: () => tethrApi.revealEnv(companyId, entry.key),
    onSuccess: (r) => setValue(r.value),
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't read it."),
  });
  const save = useMutation({
    mutationFn: (v: string) => tethrApi.setEnv(companyId, entry.key, v),
    onSuccess: (_r, v) => {
      setEditing(false);
      setValue(v);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't save it."),
    onSettled: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => tethrApi.deleteEnv(companyId, entry.key),
    onError: (e) => setError(e instanceof Error ? e.message : "Couldn't remove it."),
    onSettled: onChanged,
  });

  const startEdit = async () => {
    const current = value ?? (await reveal.mutateAsync().then((r) => r.value).catch(() => null));
    if (current === null) return;
    if (entry.core && !window.confirm(`${entry.key} is one tethr itself depends on (database, login or server). Change it anyway?`)) return;
    setDraft(current);
    setEditing(true);
  };

  return (
    <div className="px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex min-w-0 items-center gap-2 sm:w-[42%] sm:shrink-0">
            <span className="truncate font-mono text-[12.5px]" title={entry.key}>
              {entry.key}
            </span>
            {entry.core ? <MonoTag className="shrink-0">core</MonoTag> : null}
          </span>
          {editing ? (
            <Input
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save.mutate(draft);
                if (e.key === "Escape") setEditing(false);
              }}
              spellCheck={false}
              autoComplete="off"
              aria-label={`New value for ${entry.key}`}
              className="h-8 min-w-0 flex-1 font-mono text-[12.5px]"
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono text-[12.5px]",
                value === null ? "tethr-text-3" : "select-all",
              )}
              title={value ?? undefined}
            >
              {value !== null ? value || "(empty)" : entry.set ? "•".repeat(Math.min(16, Math.max(8, entry.length))) : "(empty)"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {editing ? (
            <>
              <button type="button" onClick={() => save.mutate(draft)} disabled={save.isPending} className="tethr-btn tethr-btn-primary h-7 px-3 text-[12px]">
                Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className="tethr-btn tethr-btn-ghost h-7 px-2.5 text-[12px]">
                Cancel
              </button>
            </>
          ) : entry.multiline ? (
            <span className="text-[11.5px] tethr-text-3">edit in the file</span>
          ) : (
            <>
              <IconButton
                label={value !== null ? "Hide value" : "Show value"}
                onClick={() => (value !== null ? setValue(null) : reveal.mutate())}
                disabled={reveal.isPending}
              >
                {value !== null ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </IconButton>
              {value !== null ? (
                <IconButton
                  label="Copy value"
                  onClick={() => {
                    void navigator.clipboard.writeText(value).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </IconButton>
              ) : null}
              <IconButton label="Edit value" onClick={() => void startEdit()}>
                <Pencil className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label="Remove"
                onClick={() => {
                  const warn = entry.core ? " tethr itself depends on this one." : "";
                  if (window.confirm(`Remove ${entry.key} from the .env file?${warn}`)) remove.mutate();
                }}
                disabled={remove.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {error ? <p className="mt-1 text-[12px] text-[var(--tethr-bad)]">{error}</p> : null}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--tethr-frost-strong)] hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  );
}
