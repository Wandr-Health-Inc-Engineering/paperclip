import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ChoiceChip } from "@/components/tethr/Chip";
import { MonoTag } from "@/components/tethr/primitives";
import { tethrApi, tethrKeys } from "@/api/tethr";
import { ErrorLine, Field, GLASS_BUTTON, PRIMARY_BUTTON, StepActions } from "./controls";
import { TIMEZONES, useRefreshSetup, type SetupData, type StepProps } from "./shared";

// Step 1: the company, and you as its admin. tethr's mission is built in, so
// it's shown, not asked.

interface CompanyForm {
  companyName: string;
  sells: string;
  name: string;
  email: string;
  position: string;
  positionTitle: string;
  slackId: string;
  timezone: string;
  /** Null until edited: then the saved integration list shows instead. */
  domains: string | null;
}

function initialCompanyForm(data: SetupData, browserZone: string): CompanyForm {
  const admin = data.profile?.admin ?? null;
  const saved = !!data.state.steps.company;
  return {
    companyName: data.profile?.name ?? "",
    // The seeded company description isn't "what it sells": start empty until this step is saved.
    sells: saved ? (data.profile?.sells ?? "") : "",
    name: admin?.name ?? "",
    email: admin?.email ?? "",
    position: admin?.position ?? "",
    positionTitle: admin?.position === "other" ? admin.title : "",
    slackId: admin?.slackUserId ?? "",
    timezone: saved ? data.state.timezone : browserZone || data.state.timezone,
    domains: null,
  };
}

function isComplete(form: CompanyForm): boolean {
  return !!form.companyName.trim() && !!form.name.trim() && !!form.position && (form.position !== "other" || !!form.positionTitle.trim());
}

export function CompanyStep({ companyId, data, onDone }: StepProps) {
  const refresh = useRefreshSetup(companyId);
  const { data: integrations } = useQuery({ queryKey: tethrKeys.integrations(companyId), queryFn: () => tethrApi.integrations(companyId) });
  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const [form, setForm] = useState(() => initialCompanyForm(data, browserZone));
  const update = <K extends keyof CompanyForm>(field: K, value: CompanyForm[K]) => setForm((f) => ({ ...f, [field]: value }));
  const domainText = form.domains ?? (integrations?.internalAddresses ?? []).join(", ");
  const zones = useMemo(() => [...new Set([form.timezone, browserZone, ...TIMEZONES].filter(Boolean))], [form.timezone, browserZone]);
  const focus = data.positions.find((p) => p.key === form.position)?.focus;

  const save = useMutation({
    mutationFn: () =>
      tethrApi.setupCompany(companyId, {
        companyName: form.companyName.trim(),
        sells: form.sells.trim(),
        adminName: form.name.trim(),
        adminEmail: form.email.trim(),
        position: form.position,
        positionTitle: form.position === "other" ? form.positionTitle.trim() : undefined,
        slackUserId: form.slackId.trim(),
        timezone: form.timezone,
        internalAddresses: domainText.split(/[,\s]+/).map((d) => d.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });

  return (
    <div className="space-y-4">
      <div className="tethr-inset space-y-1 px-3.5 py-3">
        <MonoTag>what tethr is for</MonoTag>
        <p className="text-[13px] leading-relaxed">{data.mission}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name">
          <Input aria-label="Company name" value={form.companyName} onChange={(e) => update("companyName", e.target.value)} placeholder="e.g. Wandr Health" className="h-9 text-[13.5px]" />
        </Field>
        <Field label="What it sells" help="One line, so tethr knows the business.">
          <Input aria-label="What it sells" value={form.sells} onChange={(e) => update("sells", e.target.value)} placeholder="e.g. Travel medicine, prescribed online" className="h-9 text-[13.5px]" />
        </Field>
      </div>

      <div className="space-y-3">
        <MonoTag>you · the admin</MonoTag>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <Input aria-label="Your name" value={form.name} onChange={(e) => update("name", e.target.value)} autoComplete="name" className="h-9 text-[13.5px]" />
          </Field>
          <Field label="Email">
            <Input aria-label="Email" value={form.email} onChange={(e) => update("email", e.target.value)} type="email" autoComplete="email" className="h-9 text-[13.5px]" />
          </Field>
        </div>
        <Field label="Your position" help={focus ? `tethr helps you with ${focus}.` : "tethr helps each person through their position."}>
          <div className="flex flex-wrap gap-1.5">
            {data.positions.map((p) => (
              <ChoiceChip key={p.key} selected={form.position === p.key} onClick={() => update("position", p.key)}>
                {p.title}
              </ChoiceChip>
            ))}
          </div>
        </Field>
        {form.position === "other" ? (
          <Field label="Your position, in a few words">
            <Input aria-label="Your position" value={form.positionTitle} onChange={(e) => update("positionTitle", e.target.value)} placeholder="e.g. Head of partnerships" className="h-9 text-[13.5px]" />
          </Field>
        ) : null}
        <Field label="Your Slack member ID (optional)" help="So you can approve from Slack and tethr can send you ideas. Slack: your profile, ⋯, Copy member ID.">
          <Input aria-label="Your Slack member ID" value={form.slackId} onChange={(e) => update("slackId", e.target.value)} placeholder="U0123ABCD" className="h-9 font-mono text-[12.5px] sm:w-56" />
        </Field>
      </div>

      <InviteComingSoon />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" help="For the schedule and working hours.">
          <select
            aria-label="Time zone"
            value={form.timezone}
            onChange={(e) => update("timezone", e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-[13px]"
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inside the company" help="Email domains that count as the company.">
          <Input aria-label="Inside the company" value={domainText} onChange={(e) => update("domains", e.target.value)} placeholder="company.com" className="h-9 font-mono text-[12.5px]" />
        </Field>
      </div>
      <ErrorLine error={save.error} />
      <StepActions>
        <button type="button" onClick={() => save.mutate()} disabled={!isComplete(form) || save.isPending} className={PRIMARY_BUTTON}>
          Save and continue
        </button>
      </StepActions>
    </div>
  );
}

function InviteComingSoon() {
  return (
    <div className="space-y-1.5">
      <span className="block text-[12.5px] font-medium">Invite teammates</span>
      <div className="flex items-center gap-2">
        <Input aria-label="Teammate email (coming soon)" disabled placeholder="teammate@company.com" className="h-9 text-[13px] sm:w-72" />
        <button type="button" disabled className={`${GLASS_BUTTON} opacity-60`}>
          Invite
        </button>
        <MonoTag>coming soon</MonoTag>
      </div>
      <span className="block text-[11.5px] tethr-text-3">Each teammate will get their own tethr, working through their position.</span>
    </div>
  );
}
