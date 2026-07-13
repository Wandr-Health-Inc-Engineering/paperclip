import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Crown, Network, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import {
  AgentGlyph,
  AgentStatusDot,
  BudgetBar,
  MonoTag,
  formatCents,
  formatRelative,
  tethrIcon,
} from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { Link } from "../../lib/router";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys, type TethrOverviewAgent } from "@/api/tethr";

// The live company: CEO → divisions → agents → subagents. Growth is fully
// populated; the other divisions are real, navigable shells — adding one is
// data, not architecture.

export function TethrCompany() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [divisionDialogOpen, setDivisionDialogOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<{
    divisionId: string | null;
    divisionName: string;
    isHead: boolean;
  } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Company" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: tethrKeys.overview(selectedCompanyId!),
    queryFn: () => tethrApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to view the org." />;
  }
  if (isLoading) return <PageSkeleton variant="org-chart" />;
  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }
  if (!data || data.agents.length === 0) {
    return (
      <EmptyState
        icon={Network}
        message="No Tethr org seeded for this company. Switch to Wandr Growth, or run the seed."
      />
    );
  }

  const ceo = data.agents.find((a) => a.profile.tag === "@ceo");
  const byId = new Map(data.agents.map((a) => [a.agent.id, a]));
  // Specialists the CEO built (report to it, not slotted into a division).
  const ceoReports = ceo
    ? data.agents.filter(
        (a) => a.agent.reportsTo === ceo.agent.id && !a.profile.divisionId,
      )
    : [];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <MonoTag className="text-foreground">● tethr · company</MonoTag>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">the org</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One company, many divisions. Click an agent to see its routing table, crew,
            and recent work.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {ceo ? (
            <Button size="sm" onClick={() => setProposeOpen(true)}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Ask the CEO for an agent
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setDivisionDialogOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add division
          </Button>
        </div>
      </div>

      {/* CEO — head of the agent org (tier 0). @tethr, the conductor, sits
          separately as its own root; see its card in Operations. */}
      {ceo ? (
        <div className="flex justify-center">
          <Link
            to={`/crew/${ceo.agent.id}`}
            className="group flex items-center gap-3 border-2 border-foreground bg-foreground px-5 py-3 text-background transition-colors hover:bg-foreground/90"
          >
            <Crown className="h-4 w-4" />
            <div className="min-w-0">
              <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] opacity-70">
                tier · 00 · head of the agent org
              </span>
              <p className="flex items-center gap-1.5 text-sm font-extrabold leading-tight">
                {ceo.profile.codename}
                <AgentStatusDot status={ceo.agent.status} />
              </p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 opacity-70 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      ) : null}

      {/* The CEO's crew — specialists it proposed and you approved into being. */}
      {ceoReports.length ? (
        <div>
          <p className="mb-2 text-center font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
            reports to the CEO
          </p>
          <div className="mx-auto grid max-w-3xl gap-2 md:grid-cols-2">
            {ceoReports.map((entry) => (
              <AgentRow key={entry.agent.id} entry={entry} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Divisions */}
      <div className="grid gap-5 xl:grid-cols-2" data-tethr-stagger>
        {data.divisions.map((division) => {
          const head = division.headAgentId ? byId.get(division.headAgentId) : null;
          const members = data.agents.filter(
            (a) =>
              a.profile.divisionId === division.id &&
              a.agent.id !== division.headAgentId &&
              a.profile.tag !== "@ceo", // shown in the tier-0 banner, not as a member
          );
          const DivisionIcon = tethrIcon(division.icon);
          const isShell = division.status === "shell";
          return (
            <section
              key={division.id}
              className={cn(
                "border-2 bg-card",
                isShell ? "border-dashed border-foreground/40" : "border-foreground",
              )}
            >
              <header className="flex items-start justify-between gap-3 border-b-2 border-inherit px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <DivisionIcon className="h-4 w-4" />
                  <div>
                    <h2 className="text-base font-extrabold tracking-tight">
                      {division.name}
                    </h2>
                    <p className="text-xs text-muted-foreground">{division.description}</p>
                  </div>
                </div>
                <MonoTag className={cn(!isShell && "text-foreground")}>
                  {isShell ? "ready to fill" : "division · live"}
                </MonoTag>
              </header>

              {isShell ? (
                <div className="space-y-3 px-4 py-5">
                  <button
                    onClick={() =>
                      setAgentDialog({
                        divisionId: division.id,
                        divisionName: division.name,
                        isHead: true,
                      })
                    }
                    className="flex w-full items-center gap-3 border border-dashed border-foreground/40 px-3 py-2.5 text-left transition-colors hover:border-foreground"
                  >
                    <Plus className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold text-muted-foreground">
                      Head slot open — click to fill
                    </span>
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    {[0, 1].map((i) => (
                      <div
                        key={i}
                        className="flex h-12 items-center justify-center border border-dashed border-foreground/25"
                      >
                        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">
                          agent slot
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Adding this division is data, not architecture: create a head, point
                    its adapter at a spec folder, drop agents in.
                  </p>
                </div>
              ) : (
                <div className="px-4 py-4">
                  {head ? <AgentRow entry={head} isHead /> : null}
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {members.map((entry) => (
                      <AgentRow key={entry.agent.id} entry={entry} />
                    ))}
                    <button
                      onClick={() =>
                        setAgentDialog({
                          divisionId: division.id,
                          divisionName: division.name,
                          isHead: false,
                        })
                      }
                      className="flex min-h-16 items-center justify-center gap-2 border border-dashed border-foreground/30 text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em]">
                        add agent
                      </span>
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <AddDivisionDialog
        companyId={selectedCompanyId}
        open={divisionDialogOpen}
        onOpenChange={setDivisionDialogOpen}
      />
      <AddAgentDialog
        companyId={selectedCompanyId}
        state={agentDialog}
        onClose={() => setAgentDialog(null)}
      />
      <ProposeAgentDialog
        companyId={selectedCompanyId}
        open={proposeOpen}
        onOpenChange={setProposeOpen}
      />
    </div>
  );
}

function AddDivisionDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      tethrApi.createDivision(companyId, {
        name: name.trim(),
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.overview(companyId) });
      setName("");
      setDescription("");
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a division</DialogTitle>
          <DialogDescription>
            Divisions are data, not architecture. It starts as a ready-to-fill shell —
            add a head agent next.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Division name (e.g. Partnerships)"
            autoFocus
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this division owns (one sentence)"
            rows={2}
          />
          {create.isError ? (
            <p className="text-sm text-destructive">{(create.error as Error).message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create division
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProposeAgentDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [brief, setBrief] = useState("");
  const propose = useMutation({
    mutationFn: () => tethrApi.proposeAgent(companyId, brief.trim() || undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.overview(companyId) });
    },
  });
  const close = () => {
    setBrief("");
    propose.reset();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ask the CEO to propose an agent</DialogTitle>
          <DialogDescription>
            The CEO drafts a new agent for the area you name (or its own pick). It lands in
            the Queue and Slack as a yes/no — nothing is created until you approve it.
          </DialogDescription>
        </DialogHeader>
        {propose.data ? (
          <div className="space-y-2 border-2 border-foreground bg-card p-4">
            <p className="text-sm font-bold">
              Proposed: {propose.data.codename}{" "}
              <span className="font-mono text-xs text-muted-foreground">{propose.data.tag}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Review and approve it in the{" "}
              <Link to="/queue" className="font-semibold underline" onClick={close}>
                Queue
              </Link>{" "}
              (it also posted to Slack).
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <Textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="What should it work on? e.g. market research: competitor moves + rising search demand (leave blank to let the CEO decide)"
              rows={3}
              autoFocus
            />
            {propose.isError ? (
              <p className="text-sm text-destructive">{(propose.error as Error).message}</p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          {propose.data ? (
            <Button variant="outline" onClick={close}>
              Done
            </Button>
          ) : (
            <Button onClick={() => propose.mutate()} disabled={propose.isPending}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {propose.isPending ? "Thinking…" : "Propose an agent"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAgentDialog({
  companyId,
  state,
  onClose,
}: {
  companyId: string;
  state: { divisionId: string | null; divisionName: string; isHead: boolean } | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [codename, setCodename] = useState("");
  const [title, setTitle] = useState("");
  const [mission, setMission] = useState("");
  const [gate, setGate] = useState("internal");
  const create = useMutation({
    mutationFn: () =>
      tethrApi.createAgent(companyId, {
        codename: codename.trim(),
        title: title.trim(),
        mission: mission.trim() || undefined,
        divisionId: state?.divisionId ?? null,
        isHead: state?.isHead ?? false,
        approvalGate: gate,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tethrKeys.overview(companyId) });
      setCodename("");
      setTitle("");
      setMission("");
      setGate("internal");
      onClose();
    },
  });
  return (
    <Dialog open={!!state} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state?.isHead
              ? `Fill the ${state.divisionName} head slot`
              : `Add an agent to ${state?.divisionName}`}
          </DialogTitle>
          <DialogDescription>
            The agent runs on the Tethr adapter immediately — give it subagents and a
            routing table from its detail page afterward.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            value={codename}
            onChange={(e) => setCodename(e.target.value)}
            placeholder="Codename (e.g. Keel)"
            autoFocus
          />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={state?.isHead ? "Title (e.g. Head of Engineering)" : "Title (e.g. Release Captain)"}
          />
          <Textarea
            value={mission}
            onChange={(e) => setMission(e.target.value)}
            placeholder="Mission (one or two sentences)"
            rows={2}
          />
          <Select value={gate} onValueChange={setGate}>
            <SelectTrigger>
              <SelectValue placeholder="Approval gate" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="internal">internal — no hard gate</SelectItem>
              <SelectItem value="medical">medical — human review before publish</SelectItem>
              <SelectItem value="public">public — human sends</SelectItem>
              <SelectItem value="spend">spend — human approval before live</SelectItem>
              <SelectItem value="pr">pr — human review</SelectItem>
            </SelectContent>
          </Select>
          {create.isError ? (
            <p className="text-sm text-destructive">{(create.error as Error).message}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={!codename.trim() || !title.trim() || create.isPending}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {state?.isHead ? "Create head agent" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({ entry, isHead }: { entry: TethrOverviewAgent; isHead?: boolean }) {
  const { agent, profile, subagents, pendingApprovals, lastRunAt } = entry;
  const pct =
    agent.budgetMonthlyCents > 0
      ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
      : 0;
  return (
    <Link
      to={`/crew/${agent.id}`}
      className={cn(
        "group block border bg-background transition-colors hover:border-foreground",
        isHead ? "border-2 border-foreground" : "border-border",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center border",
              isHead
                ? "border-foreground bg-foreground text-background"
                : "border-foreground",
            )}
          >
            <AgentGlyph icon={agent.icon} />
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-bold leading-tight">
              {agent.name}
              <AgentStatusDot status={agent.status} />
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              {profile.tag} · {agent.title}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingApprovals > 0 ? (
            <span className="border border-amber-600 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-amber-700 dark:border-amber-400 dark:text-amber-300">
              {pendingApprovals} in queue
            </span>
          ) : null}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
      <div className="space-y-1.5 border-t border-border px-3 py-2">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          <span>last run {formatRelative(lastRunAt)}</span>
          {agent.budgetMonthlyCents > 0 ? (
            <span>
              {formatCents(agent.spentMonthlyCents)} / {formatCents(agent.budgetMonthlyCents)} ·{" "}
              {pct}%
            </span>
          ) : (
            <span>no cap</span>
          )}
        </div>
        {agent.budgetMonthlyCents > 0 ? (
          <BudgetBar
            spentCents={agent.spentMonthlyCents}
            capCents={agent.budgetMonthlyCents}
          />
        ) : null}
        {subagents.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {subagents.map((s) => (
              <span
                key={s.id}
                className="border border-border px-1.5 py-0.5 font-mono text-[9px] font-semibold text-muted-foreground"
              >
                .{s.key}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}
