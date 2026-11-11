import { MonoTag } from "@/components/tethr/primitives";
import type { TethrAreaId, TethrGrowthMap } from "@/api/tethr";
import type { EarnedUnlocks } from "@/lib/tethr-growth-map";

// The side of the growth map when no star is open (phase 26.9): the company's
// level, this week's focus, what's new since the last visit, where to start,
// and what the marks mean.

const LEGEND: Array<[string, string]> = [
  ["ring", "six unlocks: Mapped, Equipped, Informed, Aimed, Staffed, Proven"],
  ["planets", "what tethr knows there: notes and skills"],
  ["lines", "areas that feed each other; lit once both are Working"],
  ["dashed", "an area nobody has explored yet"],
  ["dot", "an agent is working there now"],
];

export function Overview({ map, fresh, onSelect }: { map: TethrGrowthMap; fresh: EarnedUnlocks; onSelect: (id: TethrAreaId) => void }) {
  const visible = map.areas.filter((a) => !a.hidden);
  const pct = map.company.max ? Math.round((map.company.level / map.company.max) * 100) : 0;
  const unexplored = visible.filter((a) => a.level === 0).length;
  // Where to start: the lowest areas, nearest the center first.
  const start = [...visible].sort((a, b) => a.level - b.level || a.step - b.step).slice(0, 3);
  const news = Object.entries(fresh).flatMap(([id, keys]) => {
    const area = map.areas.find((a) => a.id === id);
    return area ? keys.map((k) => ({ area, label: area.unlocks.find((u) => u.key === k)?.label ?? k })) : [];
  });
  return (
    <div className="flex flex-col gap-5">
      <section className="space-y-2">
        <MonoTag>company level</MonoTag>
        <p className="flex items-baseline gap-2">
          <span className="tethr-figure text-[44px] leading-none">{map.company.level}</span>
          <span className="text-[13px] text-muted-foreground">of {map.company.max}</span>
        </p>
        <div className="h-1 overflow-hidden rounded-full bg-[var(--tethr-rim)]" aria-hidden="true">
          <div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          {unexplored ? `${unexplored} of ${visible.length} areas are still unexplored.` : "Every area has been explored."} Levels come only from what tethr can check.
        </p>
      </section>

      <section className="space-y-1.5 border-t tethr-rule pt-4">
        <MonoTag>focus this week</MonoTag>
        {map.focus ? (
          <button type="button" className="block text-left" onClick={() => onSelect(map.focus!.area)}>
            <span className="text-[15px]">{map.focus.name}</span>
            {map.focus.why ? <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{map.focus.why}</span> : null}
          </button>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">None set. The Monday plan picks one when it's switched on, or ask tethr which area to work on.</p>
        )}
      </section>

      {news.length ? (
        <section className="space-y-1.5 border-t tethr-rule pt-4">
          <MonoTag>new since your last visit</MonoTag>
          <ul className="space-y-1 text-[13px]">
            {news.map((n) => (
              <li key={`${n.area.id}-${n.label}`}>
                <button type="button" className="text-left hover:underline" onClick={() => onSelect(n.area.id)}>
                  {n.area.name}: <span className="tethr-galaxy-new">{n.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-1.5 border-t tethr-rule pt-4">
        <MonoTag>start with</MonoTag>
        <ul className="space-y-1 text-[13px]">
          {start.map((a) => (
            <li key={a.id}>
              <button type="button" className="text-left hover:underline" onClick={() => onSelect(a.id)}>
                {a.name}
              </button>
              <span className="text-muted-foreground"> · {a.next ? `next: ${a.next.label}` : "all unlocked"}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-1.5 border-t tethr-rule pt-4">
        <MonoTag>reading the map</MonoTag>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
          {LEGEND.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-[11px] uppercase tracking-[0.12em] tethr-text-3">{k}</dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
