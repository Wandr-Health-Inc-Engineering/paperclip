import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { MonoTag, formatRelative } from "@/components/tethr/primitives";
import { useBreadcrumbs } from "../../context/BreadcrumbContext";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";
import { tethrApi, tethrKeys } from "@/api/tethr";

// The memory layer surfaced: company-wide rules + per-agent history that the
// recall_memory tool feeds back into every run.

export function TethrMemory() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const { data: memories, isLoading } = useQuery({
    queryKey: tethrKeys.memories(selectedCompanyId!),
    queryFn: () => tethrApi.memories(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: overview } = useQuery({
    queryKey: tethrKeys.overview(selectedCompanyId!),
    queryFn: () => tethrApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentNameById = useMemo(
    () => new Map((overview?.agents ?? []).map((a) => [a.agent.id, a.profile.tag])),
    [overview],
  );

  const filtered = useMemo(() => {
    let rows = memories ?? [];
    if (agentFilter === "company") rows = rows.filter((m) => !m.agentId);
    else if (agentFilter !== "all") rows = rows.filter((m) => m.agentId === agentFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      rows = rows.filter((m) => m.content.toLowerCase().includes(q));
    }
    return rows;
  }, [memories, agentFilter, query]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to browse memory." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;

  const agentsWithMemories = (overview?.agents ?? []).filter((a) =>
    (memories ?? []).some((m) => m.agentId === a.agent.id),
  );

  return (
    <div className="space-y-5">
      <div>
        <MonoTag>tethr · memory</MonoTag>
        <h1 className="tethr-display mt-3 text-[34px] md:text-[40px]">recall</h1>
        <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground">
          What the company remembers. Agents pull from here on every run via
          recall_memory; company-wide rules apply to everyone.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {[
          { value: "all", label: "everything" },
          { value: "company", label: "company-wide" },
          ...agentsWithMemories.map((a) => ({
            value: a.agent.id,
            label: a.profile.tag,
          })),
        ].map((option) => (
          <button
            key={option.value}
            onClick={() => setAgentFilter(option.value)}
            className={cn(
              "tethr-btn h-7 px-3 font-mono text-[10.5px] tracking-[0.1em]",
              agentFilter === option.value ? "tethr-btn-primary" : "tethr-btn-glass text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search memory…"
          className="ml-auto h-8 w-56 font-mono text-xs"
        />
      </div>

      {filtered.length ? (
        <div className="tethr-panel overflow-hidden">
          {filtered.map((memory, index) => (
            <div
              key={memory.id}
              className={cn(
                "grid grid-cols-[9.5rem_minmax(0,1fr)_auto] items-baseline gap-3 px-4 py-2.5 max-md:grid-cols-1 max-md:gap-1",
                index < filtered.length - 1 && "tethr-rule border-b",
              )}
            >
              <span
                className={cn(
                  "tethr-pill justify-center whitespace-nowrap px-2 py-0.5 text-[9.5px] max-md:w-fit",
                  memory.kind === "rule" && "tethr-pill-solid",
                )}
              >
                {memory.kind}
              </span>
              <span className="min-w-0 text-sm leading-relaxed">{memory.content}</span>
              <span className="tethr-eyebrow shrink-0 text-[9.5px] tracking-[0.14em]">
                {memory.agentId ? (agentNameById.get(memory.agentId) ?? "agent") : "company"} ·{" "}
                {formatRelative(memory.createdAt)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="tethr-empty px-4 py-10 text-center text-sm">
          No memories match.
        </p>
      )}
    </div>
  );
}
