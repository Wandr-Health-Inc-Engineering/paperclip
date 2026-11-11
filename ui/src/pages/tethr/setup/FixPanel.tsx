import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys, type TethrConnectorMode } from "@/api/tethr";
import { ApiError } from "@/api/client";
import type { CheckFix, EnvField } from "./fixes";
import { ErrorLine, GLASS_BUTTON, PRIMARY_BUTTON, Segmented } from "./controls";
import { useRefreshSetup, type StepKey } from "./shared";

// How a connection is fixed in place: a key to paste, a mode to pick, a Slack
// member ID to link, or what to do elsewhere. Used by Setup → Connections and
// by the chat's connection card, so nothing sends you to another page.

const MODE_OPTIONS: Array<{ value: TethrConnectorMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

const MODE_HELP: Record<TethrConnectorMode, string> = {
  off: "tethr can't use it.",
  read: "tethr can look, but can't change anything.",
  ask: "Changes wait for your OK in a card. Recommended.",
  auto: "Changes just happen. Money, anything public and anything medical still ask.",
};

export function FixPanel({
  fix,
  companyId,
  goTo,
  onFixed,
}: {
  fix: CheckFix;
  companyId: string;
  /** Setup only: jump to another step. Elsewhere the "step" kind shows its instructions. */
  goTo?: (step: StepKey) => void;
  /** Called after a save, so the caller can re-check what was waiting on it. */
  onFixed?: () => void;
}) {
  return (
    <div className="space-y-3 rounded-[10px] bg-[var(--tethr-frost)] p-3.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{fix.how}</p>
      {fix.kind === "env" ? <EnvFix fields={fix.fields} restart={!!fix.restart} companyId={companyId} onFixed={onFixed} /> : null}
      {fix.kind === "connector" ? <ConnectorFix connector={fix.connector} companyId={companyId} onFixed={onFixed} /> : null}
      {fix.kind === "slack-id" ? <SlackIdFix companyId={companyId} onFixed={onFixed} /> : null}
      {fix.kind === "step" && goTo ? (
        <button type="button" onClick={() => goTo(fix.step)} className={GLASS_BUTTON}>
          Go to that step
        </button>
      ) : null}
    </div>
  );
}

/** Paste one or more keys; saved to the instance .env (values never come back to the page). */
function EnvFix({ fields, restart, companyId, onFixed }: { fields: EnvField[]; restart: boolean; companyId: string; onFixed?: () => void }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSetup(companyId);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const env = useQuery({ queryKey: tethrKeys.env(companyId), queryFn: () => tethrApi.env(companyId), retry: false });
  const isSet = (key: string) => !!env.data?.entries.find((e) => e.key === key)?.set;
  const filled = fields.filter((f) => values[f.key]?.trim());
  const save = useMutation({
    mutationFn: async () => {
      for (const field of filled) await tethrApi.setEnv(companyId, field.key, values[field.key].trim());
    },
    onSuccess: () => {
      setValues({});
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: tethrKeys.env(companyId) });
      refresh();
      onFixed?.();
    },
  });

  if (env.error instanceof ApiError && env.error.status === 403) {
    return <p className="text-[12.5px]">Only the person who runs tethr on this computer can add keys. Ask them, or continue and come back.</p>;
  }
  return (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled.length) save.mutate();
      }}
    >
      {fields.map((field) => (
        <label key={field.key} className="block space-y-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
            <span className="font-medium">{field.label}</span>
            <span className="font-mono text-[10.5px] tethr-text-3">{field.key}</span>
            {isSet(field.key) ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] tethr-text-3">
                <StatusDot tone="ok" /> set, leave blank to keep
              </span>
            ) : field.optional ? (
              <span className="text-[11px] tethr-text-3">optional</span>
            ) : null}
          </span>
          <Input
            type={field.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[field.key] ?? ""}
            onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [field.key]: e.target.value }));
            }}
            placeholder={field.placeholder}
            className="h-9 font-mono text-[12.5px] placeholder:font-sans"
          />
        </label>
      ))}
      <ErrorLine error={save.error} />
      <div className="flex flex-wrap items-center justify-end gap-3 pt-0.5">
        {saved ? (
          <span className="mr-auto inline-flex items-center gap-1.5 text-[12px]">
            <StatusDot tone="ok" />
            {restart ? "Saved. Restart tethr from the launcher to use it." : "Saved."}
          </span>
        ) : null}
        <button type="submit" disabled={!filled.length || save.isPending} className={PRIMARY_BUTTON}>
          {save.isPending ? "Saving…" : filled.length > 1 ? `Save ${filled.length}` : "Save"}
        </button>
      </div>
    </form>
  );
}

/** Pick what tethr may do with a connector, saved straight to Integrations. */
function ConnectorFix({ connector, companyId, onFixed }: { connector: string; companyId: string; onFixed?: () => void }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshSetup(companyId);
  const integrations = useQuery({ queryKey: tethrKeys.integrations(companyId), queryFn: () => tethrApi.integrations(companyId) });
  const current = integrations.data?.connectors.find((c) => c.label === connector)?.mode ?? "off";
  const update = useMutation({
    mutationFn: (mode: TethrConnectorMode) => tethrApi.updateIntegrations(companyId, { connectors: { [connector]: { mode } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tethrKeys.integrations(companyId) });
      refresh();
      onFixed?.();
    },
  });
  const shown = update.isPending && update.variables ? update.variables : current;
  return (
    <div className="space-y-2">
      <Segmented value={shown} onChange={(mode) => update.mutate(mode)} options={MODE_OPTIONS} />
      <p className="text-[12px] tethr-text-3">{MODE_HELP[shown]}</p>
      <ErrorLine error={update.error} />
    </div>
  );
}

/**
 * Link your Slack member ID. One tap for the account Slack says has your email
 * ("That's me"). An account that merely wrote to tethr is shown with its ID to
 * check first: a name in Slack can be copied, and whoever is linked here drives
 * tethr as you. Or paste the ID.
 */
function SlackIdFix({ companyId, onFixed }: { companyId: string; onFixed?: () => void }) {
  const refresh = useRefreshSetup(companyId);
  const setup = useQuery({ queryKey: tethrKeys.setup(companyId), queryFn: () => tethrApi.setup(companyId) });
  const [typed, setTyped] = useState("");
  const link = useMutation({
    mutationFn: (slackUserId: string) => tethrApi.setAdminSlack(companyId, slackUserId),
    onSuccess: () => {
      setTyped("");
      refresh();
      onFixed?.();
    },
  });
  const lookup = useMutation({ mutationFn: () => tethrApi.slackLookup(companyId) });
  const claim = setup.data?.state.slackClaim ?? null;
  const linked = setup.data?.profile?.admin?.slackUserId ?? null;
  // Someone wrote to tethr from Slack: ask Slack whose account matches your email, to tell if it was you.
  const askSlack = lookup.mutate;
  const shouldAsk = !!claim && !linked && !lookup.data && !lookup.isPending && !lookup.isError;
  useEffect(() => {
    if (shouldAsk) askSlack();
  }, [shouldAsk, askSlack]);
  const found = lookup.data?.found ?? null;
  const verified = found && found.slackUserId !== linked ? found : null;
  const unverifiedClaim = claim && claim.slackUserId !== linked && claim.slackUserId !== found?.slackUserId ? claim : null;

  return (
    <div className="space-y-2.5">
      {linked ? (
        <p className="inline-flex items-center gap-1.5 text-[12px]">
          <StatusDot tone="ok" /> Linked: <span className="font-mono">{linked}</span>. Slack messages from you reach tethr.
        </p>
      ) : null}
      {verified ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={() => link.mutate(verified.slackUserId)} disabled={link.isPending} className={PRIMARY_BUTTON}>
            That's me: {verified.name ?? verified.slackUserId}
          </button>
          <span className="text-[11.5px] tethr-text-3">
            <span className="font-mono">{verified.slackUserId}</span> has your email in Slack
          </span>
        </div>
      ) : null}
      {unverifiedClaim ? (
        <div className="space-y-2 rounded-[10px] px-3 py-2.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)]">
          <p className="text-[12px] leading-relaxed">
            <StatusDot tone="warn" className="mr-1.5 inline-block align-middle" />
            Slack account <span className="font-mono">{unverifiedClaim.slackUserId}</span>
            {unverifiedClaim.name ? ` (shown as "${unverifiedClaim.name}")` : ""} wrote to tethr. A name in Slack can be copied, and whoever is linked here
            drives tethr as you: link it only if this ID is yours (Slack, your profile, then ⋯, then Copy member ID).
          </p>
          <button type="button" onClick={() => link.mutate(unverifiedClaim.slackUserId)} disabled={link.isPending} className={GLASS_BUTTON}>
            It's mine, link {unverifiedClaim.slackUserId}
          </button>
        </div>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) link.mutate(typed.trim());
        }}
      >
        <Input
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="U0123ABCD"
          aria-label="Slack member ID"
          className="h-9 w-44 font-mono text-[12.5px] placeholder:font-sans"
        />
        <button type="submit" disabled={!typed.trim() || link.isPending} className={GLASS_BUTTON}>
          {link.isPending ? "Saving…" : "Save"}
        </button>
        {!lookup.data ? (
          <button type="button" onClick={() => lookup.mutate()} disabled={lookup.isPending} className="tethr-btn tethr-btn-ghost h-9 px-3.5 text-[12.5px]">
            {lookup.isPending ? "Looking…" : "Find me in Slack"}
          </button>
        ) : null}
      </form>
      {lookup.data && !found && lookup.data.reason ? <p className="text-[12px] tethr-text-3">{lookup.data.reason}</p> : null}
      <ErrorLine error={link.error ?? lookup.error} />
    </div>
  );
}
