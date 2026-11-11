import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { MonoTag, StatusDot } from "@/components/tethr/primitives";
import type { TethrAreaId, TethrGrowthArea, TethrGrowthMap } from "@/api/tethr";
import type { EarnedUnlocks } from "@/lib/tethr-growth-map";
import { UnlockRing } from "./AreaPanel";

// The growth map as rows (phase 26.9): the same areas and the same facts as the
// galaxy (level, the six unlocks, the next one, what tethr knows, focus, an
// agent at work, what's new), for reading, for keyboards and for phones.

function LevelBar({ area }: { area: TethrGrowthArea }) {
  return (
    <span className="flex gap-[3px]" aria-label={`${area.level} of 6 unlocked`}>
      {area.unlocks.map((u) => (
        <span key={u.key} title={`${u.label}: ${u.earned ? "unlocked" : "not yet"}`} className={cn("h-1.5 w-3.5 rounded-full", u.earned ? "bg-foreground" : "bg-[var(--tethr-rim-strong)]")} />
      ))}
    </span>
  );
}

function Row({ area, selected, fresh, onSelect }: { area: TethrGrowthArea; selected: boolean; fresh: string[]; onSelect: (id: TethrAreaId) => void }) {
  const knows = area.knowledge.notes.length + area.knowledge.skills.length;
  return (
    <button
      type="button"
      onClick={() => onSelect(area.id)}
      aria-pressed={selected}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--tethr-frost-strong)]",
        selected && "bg-[var(--tethr-frost-strong)]",
      )}
    >
      <UnlockRing area={area} size={34} />
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-[14px]">{area.name}</span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] tethr-text-3">
            {area.level} · {area.levelName}
          </span>
          {area.focus ? <span className="tethr-eyebrow">focus</span> : null}
          {fresh.length ? <span className="tethr-galaxy-new">new: {fresh.length === 1 ? area.unlocks.find((u) => u.key === fresh[0])?.label : `${fresh.length} unlocks`}</span> : null}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <LevelBar area={area} />
          {area.next ? <span className="truncate">Next: {area.next.label}</span> : <span>All six unlocked</span>}
          <span>{knows ? `${knows} known` : "nothing known yet"}</span>
          {area.lastAudit ? <span>audit {area.lastAudit.score}/100</span> : null}
          {area.active ? (
            <span className="inline-flex items-center gap-1.5">
              <StatusDot tone="live" /> agent at work
            </span>
          ) : null}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 tethr-text-3" aria-hidden="true" />
    </button>
  );
}

export function AreaList({
  map,
  selected,
  fresh,
  onSelect,
}: {
  map: TethrGrowthMap;
  selected: TethrAreaId | null;
  fresh: EarnedUnlocks;
  onSelect: (id: TethrAreaId) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const visible = map.areas.filter((a) => !a.hidden);
  const hidden = map.areas.filter((a) => a.hidden);
  const arm = (n: 0 | 1) => visible.filter((a) => a.arm === n);
  return (
    <div className="tethr-panel overflow-hidden">
      {([0, 1] as const).map((n) => (
        <section key={n}>
          <header className="border-b tethr-rule px-4 py-2.5">
            <MonoTag>{n === 0 ? "reach · how people find you" : "customers · how they buy and stay"}</MonoTag>
          </header>
          <div className="divide-y divide-[var(--tethr-rim)] border-b tethr-rule">
            {arm(n).map((a) => (
              <Row key={a.id} area={a} selected={selected === a.id} fresh={fresh[a.id] ?? []} onSelect={onSelect} />
            ))}
          </div>
        </section>
      ))}
      {hidden.length ? (
        <section>
          <button type="button" onClick={() => setShowHidden((v) => !v)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left" aria-expanded={showHidden}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showHidden && "rotate-90")} />
            <MonoTag>hidden · {hidden.length}</MonoTag>
          </button>
          {showHidden ? (
            <div className="divide-y divide-[var(--tethr-rim)] border-t tethr-rule opacity-70">
              {hidden.map((a) => (
                <Row key={a.id} area={a} selected={selected === a.id} fresh={[]} onSelect={onSelect} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
