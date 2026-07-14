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
  BudgetBar,
  MonoTag,
  OutputStatusBadge,
  SensitivityBadge,
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
      navigate(`/console`);
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
          <div className="flex h-14 w-14 items-center justify-center border-2 border-foreground bg-foreground text-background">
            <AgentGlyph icon={agent.icon} className="h-6 w-6" />
          </div>
          <div>
            <MonoTag className="text-foreground">{profile.tag}</MonoTag>
            <h1 className="flex items-center gap-2 text-3xl font-extrabold tracking-tight">
              {agent.name}
              <AgentStatusDot status={agent.status} className="mt-1" />
            </h1>
            <p className="text-sm text-muted-foreground">{agent.title}</p>
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
        <p className="border-2 border-dashed border-amber-600 px-3 py-2 text-sm font-semibold text-amber-700 dark:border-amber-400 dark:text-amber-300">
          Paused: {agent.pauseReason}
        </p>
      ) : null}

      {/* Facts row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-tethr-stagger>
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
          <p className="text-sm font-bold">{describeCron(profile.heartbeatCron)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{profile.heartbeatNote}</p>
        </FactCard>
        <FactCard label="budget · this month">
          <p className="text-sm font-bold">
            {formatCents(agent.spentMonthlyCents)}{" "}
            <span className="text-muted-foreground">
              / {formatCents(agent.budgetMonthlyCents)}
            </span>
            {policy?.hardStopEnabled ? (
              <span className="ml-2 border border-foreground bg-foreground px-1 py-0.5 font-mono text-[9px] font-bold uppercase text-background">
                hard stop
              </span>
            ) : null}
          </p>
          <BudgetBar
            spentCents={agent.spentMonthlyCents}
            capCents={agent.budgetMonthlyCents}
            warnPercent={policy?.warnPercent ?? 80}
            className="mt-2"
          />
        </FactCard>
      </div>

      {/* Autonomy + who gets buzzed */}
      <ApprovalsCard companyId={selectedCompanyId} agentId={agentId} profile={profile} />

      {/* Routing table */}
      {profile.routingTable.length > 0 ? (
        <section className="border-2 border-foreground bg-card">
          <header className="border-b-2 border-foreground px-4 py-2.5">
            <MonoTag className="text-foreground">routing table</MonoTag>
          </header>
          <div>
            {profile.routingTable.map((entry, index) => (
              <div
                key={entry.to}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5",
                  index < profile.routingTable.length - 1 && "border-b border-border",
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{entry.description}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                    {entry.when.slice(0, 4).join(" · ")}
                  </p>
                </div>
                <span className="font-mono text-[12px] font-bold">{entry.to}</span>
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
          <div className="grid gap-3 lg:grid-cols-2" data-tethr-stagger>
            {subagents.map((subagent) => (
              <SubagentCard key={subagent.id} subagent={subagent} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Recent work */}
      <div className="grid gap-5 lg:grid-cols-2">
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
                  className="group flex items-center justify-between gap-3 border border-border bg-card px-3 py-2 transition-colors hover:border-foreground"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {output.title}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
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
            <p className="text-sm text-muted-foreground">No outputs yet.</p>
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
                  className="flex items-center justify-between gap-3 border border-border bg-card px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">
                      {run.summary ?? run.triggerDetail ?? "Heartbeat"}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                      {run.invocationSource} · {formatRelative(run.startedAt)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em]",
                      run.status === "succeeded"
                        ? "border-emerald-700 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300"
                        : run.status === "failed"
                          ? "border-destructive text-destructive"
                          : "border-border text-muted-foreground",
                    )}
                  >
                    {run.status}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function FactCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-2 border-border bg-card p-4">
      <MonoTag>{label}</MonoTag>
      <div className="mt-1.5">{children}</div>
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
    <section className="grid gap-3 sm:grid-cols-2">
      {/* Auto / manual approvals */}
      <div className="border-2 border-foreground bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <MonoTag className="text-foreground">approvals</MonoTag>
            <p className="mt-1.5 text-sm font-bold">{profile.autoApprove ? "Auto" : "Manual"}</p>
          </div>
          <Switch
            on={profile.autoApprove}
            disabled={update.isPending}
            onToggle={() => update.mutate({ autoApprove: !profile.autoApprove })}
            label="Auto-approve"
          />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {profile.autoApprove
            ? "This agent applies its role-appropriate org decisions (create/modify agents) without you. Budget, medical, public & PR still need your approval; new agents still start paused."
            : "Everything this agent stages waits for you to approve in the Queue."}
        </p>
      </div>

      {/* Who gets buzzed */}
      <div className="border-2 border-border bg-card p-4">
        <MonoTag>overseer · who gets buzzed</MonoTag>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {OVERSEER_ROLES.map((role) => (
            <button
              key={role}
              onClick={() => update.mutate({ overseerRole: role })}
              disabled={update.isPending}
              className={cn(
                "border-2 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.1em] transition-colors",
                profile.overseerRole === role
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground hover:text-foreground",
              )}
            >
              {ROLE_LABEL[role]}
            </button>
          ))}
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

function Switch({ on, disabled, onToggle, label }: { on: boolean; disabled?: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-foreground transition-colors",
        on ? "bg-foreground" : "bg-background",
        disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 rounded-full transition-transform",
          on ? "translate-x-[1.375rem] bg-background" : "translate-x-0.5 bg-foreground",
        )}
      />
    </button>
  );
}

function SubagentCard({ subagent }: { subagent: TethrSubagent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-2 border-border bg-card transition-colors hover:border-foreground/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="font-mono text-[12px] font-bold">{subagent.tag}</p>
          <p className="mt-0.5 text-sm font-semibold leading-snug">{subagent.job}</p>
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
        <div className="space-y-3 border-t border-border px-4 py-3 text-xs leading-relaxed">
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
            <span className="shrink-0 font-mono font-bold text-foreground">
              {ordered ? `${index + 1}.` : "→"}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
