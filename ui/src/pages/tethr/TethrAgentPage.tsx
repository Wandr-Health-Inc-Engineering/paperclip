import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Bot,
  ChevronDown,
  Play,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  AgentStatusDot,
  BudgetRing,
  MonoTag,
  OutputStatusBadge,
  SensitivityBadge,
  StatusDot,
  describeCron,
  formatCents,
  formatRelative,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link, useNavigate, useParams } from "../../lib/router";
import { cn } from "@/lib/utils";
import {
  tethrApi,
  tethrKeys,
  type TethrOverseerRole,
  type TethrProfile,
  type TethrSubagent,
} from "@/api/tethr";

// Tethr agent detail: role, routing table, the fine-tuned subagent specs,
// recent runs + outputs, budget. Config editing stays on the core agent page.

export function TethrAgentPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const agentId = params.agentId!;

  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.agent(selectedCompanyId!, agentId),
    queryFn: () => tethrApi.agent(selectedCompanyId!, agentId),
    enabled: !!selectedCompanyId && !!agentId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Company", href: "/company-view" },
      { label: data?.agent.name ?? "Agent" },
    ]);
  }, [setBreadcrumbs, data?.agent.name]);

  const runNow = useMutation({
    mutationFn: () => tethrApi.runNow(selectedCompanyId!, agentId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.agent(selectedCompanyId!, agentId) });
      queryClient.invalidateQueries({ queryKey: ["tethr", selectedCompanyId, "outputs"] });
      navigate(`/chat`);
      void result;
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Bot} message="Select a company first." />;
  }
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !data) {
    return (
      <EmptyState
        icon={Bot}
        message="No Tethr profile for this agent. It may be a plain Paperclip employee."
      />
    );
  }

  const { agent, profile, subagents, outputs, runs, budgetPolicies } = data;
  const policy = budgetPolicies[0] ?? null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] bg-[var(--tethr-frost-strong)] shadow-[inset_0_1px_0_var(--tethr-rim-hi),inset_0_0_0_1px_var(--tethr-rim-strong)]">
            <AgentGlyph icon={agent.icon} className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <MonoTag>{profile.tag}</MonoTag>
            <h1 className="tethr-display mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[34px] md:text-[40px]">
              {agent.name}
              <span className="flex items-center gap-1.5 text-[13px] font-normal tracking-normal text-muted-foreground">
                <AgentStatusDot status={agent.status} />
                {agent.status.replace(/_/g, " ")}
              </span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{agent.title}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {runNow.isPending ? "Running…" : "Run heartbeat now"}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link to={`/agents/${agent.id}`}>
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Edit config
            </Link>
          </Button>
        </div>
      </div>

      {agent.pauseReason ? (
        <p className="flex items-center gap-2 rounded-[14px] border border-dashed border-[color-mix(in_srgb,var(--tethr-warn)_55%,transparent)] px-3.5 py-2.5 text-sm">
          <StatusDot tone="paused" />
          <span className="tethr-tone-warn font-medium">Paused:</span> {agent.pauseReason}
        </p>
      ) : null}

      {/* Facts row */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-4" data-tethr-stagger>
        <FactCard label="mission">
          <p className="text-sm leading-relaxed">{profile.mission}</p>
        </FactCard>
        <FactCard label="approval gate">
          <div className="flex items-center gap-2">
            <SensitivityBadge sensitivity={profile.approvalGate} />
            <p className="text-xs text-muted-foreground">
              {profile.approvalGate === "none" || profile.approvalGate === "internal"
                ? "No hard gate — internal output."
                : "Output stops in the Queue for a human."}
            </p>
          </div>
        </FactCard>
        <FactCard label="heartbeat">
          <p className="text-sm font-medium">{describeCron(profile.heartbeatCron)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{profile.heartbeatNote}</p>
        </FactCard>
        <FactCard label="budget · this month">
          <div className="flex items-center gap-4">
            {agent.budgetMonthlyCents > 0 ? (
              <BudgetRing
                spentCents={agent.spentMonthlyCents}
                capCents={agent.budgetMonthlyCents}
                warnPercent={policy?.warnPercent ?? 80}
                size={92}
                label={`${formatCents(agent.spentMonthlyCents)} of ${formatCents(agent.budgetMonthlyCents)} spent this month`}
              >
                <span className="tethr-figure text-[19px]">{formatCents(agent.spentMonthlyCents)}</span>
                <span className="text-[10px] text-muted-foreground">
                  of {formatCents(agent.budgetMonthlyCents)}
                </span>
              </BudgetRing>
            ) : (
              <p className="tethr-figure text-[28px]">
                {formatCents(agent.spentMonthlyCents)}
              </p>
            )}
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs text-muted-foreground tabular-nums">
                {agent.budgetMonthlyCents > 0
                  ? `${Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)}% of the monthly cap`
                  : "No monthly cap"}
              </p>
              {policy?.hardStopEnabled ? (
                <span className="tethr-pill tethr-pill-solid px-2 py-0.5 text-[10px]">
                  hard stop
                </span>
              ) : null}
            </div>
          </div>
        </FactCard>
      </div>

      {/* Autonomy + who gets buzzed */}
      <ApprovalsCard companyId={selectedCompanyId} agentId={agentId} profile={profile} />

      {/* Routing table */}
      {profile.routingTable.length > 0 ? (
        <section className="tethr-panel overflow-hidden">
          <header className="border-b tethr-rule px-4 py-3">
            <MonoTag>routing table</MonoTag>
          </header>
          <div>
            {profile.routingTable.map((entry, index) => (
              <div
                key={entry.to}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5",
                  index < profile.routingTable.length - 1 && "border-b tethr-rule",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{entry.description}</p>
                  <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                    {entry.when.slice(0, 4).join(" · ")}
                  </p>
                </div>
                <span className="tethr-pill px-2.5 py-1 text-[11px] normal-case tracking-normal text-foreground">
                  {entry.to}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Subagents */}
      {subagents.length > 0 ? (
        <section>
          <div className="mb-3">
            <MonoTag>subagents · {subagents.length}</MonoTag>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-tethr-stagger>
            {subagents.map((subagent) => (
              <SubagentCard key={subagent.id} subagent={subagent} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Recent work */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section>
          <div className="mb-3">
            <MonoTag>recent outputs</MonoTag>
          </div>
          {outputs.length ? (
            <div className="space-y-1.5">
              {outputs.map((output) => (
                <Link
                  key={output.id}
                  to={`/queue/${output.id}`}
                  className="tethr-panel tethr-panel-hover group flex items-center justify-between gap-3 rounded-[12px] px-3.5 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {output.title}
                    </span>
                    <span className="tethr-eyebrow text-[10px] tracking-[0.14em]">
                      {output.kind.replace(/_/g, " ")} · {formatRelative(output.createdAt)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <OutputStatusBadge status={output.status} />
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="tethr-empty px-4 py-6 text-center text-sm">No outputs yet.</p>
          )}
        </section>

        <section>
          <div className="mb-3">
            <MonoTag>recent runs</MonoTag>
          </div>
          {runs.length ? (
            <div className="space-y-1.5">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="tethr-panel flex items-center justify-between gap-3 rounded-[12px] px-3.5 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {run.summary ?? run.triggerDetail ?? "Heartbeat"}
                    </span>
                    <span className="tethr-eyebrow text-[10px] tracking-[0.14em]">
                      {run.invocationSource} · {formatRelative(run.startedAt)}
                    </span>
                  </span>
                  <span className="tethr-pill shrink-0 px-2 py-0.5 text-[10px]">
                    <StatusDot status={run.status} />
                    {run.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="tethr-empty px-4 py-6 text-center text-sm">No runs yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function FactCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tethr-panel p-4">
      <MonoTag>{label}</MonoTag>
      <div className="mt-2">{children}</div>
    </div>
  );
}

const OVERSEER_ROLES: TethrOverseerRole[] = ["tech", "exec", "growth"];
const ROLE_LABEL: Record<TethrOverseerRole, string> = { tech: "Tech", exec: "Exec", growth: "Growth & Ops" };

function ApprovalsCard({
  companyId,
  agentId,
  profile,
}: {
  companyId: string;
  agentId: string;
  profile: TethrProfile;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: tethrKeys.agent(companyId, agentId) });
  const { data: rosterData } = useQuery({
    queryKey: ["tethr", companyId, "overseers"],
    queryFn: () => tethrApi.overseers(companyId),
  });
  const update = useMutation({
    mutationFn: (patch: { autoApprove?: boolean; overseerRole?: TethrOverseerRole }) =>
      tethrApi.updateAgentProfile(companyId, agentId, patch),
    onSuccess: invalidate,
  });
  const roster = rosterData?.roster;

  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {/* Auto / manual approvals */}
      <div className="tethr-panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <MonoTag>approvals</MonoTag>
            <p className="mt-1.5 text-[15px] font-medium tracking-[-0.01em]">
              {profile.autoApprove ? "Auto" : "Manual"}
            </p>
          </div>
          <Segmented
            label="Auto-approve"
            value={profile.autoApprove ? "auto" : "manual"}
            disabled={update.isPending}
            options={[
              { value: "manual", label: "Manual" },
              { value: "auto", label: "Auto" },
            ]}
            onChange={(next) => update.mutate({ autoApprove: next === "auto" })}
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {profile.autoApprove
            ? "This agent applies its role-appropriate org decisions (create/modify agents) without you. Budget, medical, public & PR still need your approval; new agents still start paused."
            : "Everything this agent stages waits for you to approve in the Queue."}
        </p>
      </div>

      {/* Who gets buzzed */}
      <div className="tethr-panel p-4">
        <MonoTag>overseer · who gets buzzed</MonoTag>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Segmented
            label="Overseer role"
            value={profile.overseerRole}
            disabled={update.isPending}
            reselect
            options={OVERSEER_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role] }))}
            onChange={(role) => update.mutate({ overseerRole: role })}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {roster
            ? roster[profile.overseerRole]?.name
              ? `Alerts go to ${roster[profile.overseerRole].name}${roster[profile.overseerRole].slackId ? "" : " — add their Slack ID in Settings"}.`
              : "Set this role's person in Settings."
            : "…"}
        </p>
      </div>
    </section>
  );
}

/** Frosted pill segmented control (Auto/Manual, overseer role). */
function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  reselect,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled?: boolean;
  /** Fire onChange even when the already-active option is clicked. */
  reselect?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--tethr-frost)] p-0.5 shadow-[inset_0_0_0_1px_var(--tethr-rim)]"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => {
              if (active && !reselect) return;
              onChange(option.value);
            }}
            className={cn(
              "tethr-btn h-7 px-3 text-[12px]",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SubagentCard({ subagent }: { subagent: TethrSubagent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tethr-panel tethr-panel-hover overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-mono text-[12px] font-medium">{subagent.tag}</p>
          <p className="mt-0.5 text-sm leading-snug">{subagent.job}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SensitivityBadge sensitivity={subagent.sensitivity} />
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </button>
      {open ? (
        <div className="space-y-3 border-t tethr-rule px-4 py-3 text-xs leading-relaxed">
          {subagent.effectiveTools && subagent.effectiveTools.length ? (
            <div>
              <MonoTag>skills · tools</MonoTag>
              <div className="mt-1.5 space-y-1">
                {subagent.effectiveTools.map((t) => (
                  <div key={t.name} className="flex gap-2">
                    <span className="tethr-pill tethr-pill-solid h-fit shrink-0 px-2 py-0.5 text-[10px] normal-case tracking-normal">
                      {t.name}
                    </span>
                    <span className="text-muted-foreground">{t.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <MonoTag>skills · tools</MonoTag>
              <p className="mt-1 text-muted-foreground">
                Baseline only — reads/writes the Drive + memory, escalates to a human. No external tools.
              </p>
            </div>
          )}
          <SpecBlock label="route here when" items={subagent.routeWhen.map((w) => `“${w}”`)} />
          {subagent.notHere.length ? (
            <SpecBlock
              label="not here"
              items={subagent.notHere.map((n) => `${n.phrase} → ${n.to}`)}
            />
          ) : null}
          <SpecBlock label="reads" items={subagent.reads} />
          <SpecBlock label="steps" items={subagent.steps} ordered />
          {subagent.output ? (
            <div>
              <MonoTag>output</MonoTag>
              <p className="mt-1 text-muted-foreground">{subagent.output}</p>
            </div>
          ) : null}
          <SpecBlock label="guardrails" items={subagent.guardrails} />
          {subagent.doneWhen ? (
            <div>
              <MonoTag>done =</MonoTag>
              <p className="mt-1 text-muted-foreground">{subagent.doneWhen}</p>
            </div>
          ) : null}
          {subagent.escalation ? (
            <div>
              <MonoTag>escalation</MonoTag>
              <p className="mt-1 text-muted-foreground">{subagent.escalation}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SpecBlock({
  label,
  items,
  ordered,
}: {
  label: string;
  items: string[];
  ordered?: boolean;
}) {
  if (!items.length) return null;
  return (
    <div>
      <MonoTag>{label}</MonoTag>
      <ul className="mt-1 space-y-0.5">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-muted-foreground">
            <span className="tethr-text-3 shrink-0 font-mono">
              {ordered ? `${index + 1}.` : "→"}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
