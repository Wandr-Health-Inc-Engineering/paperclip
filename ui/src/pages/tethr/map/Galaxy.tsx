import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { TethrAreaId, TethrGrowthArea, TethrGrowthMap } from "@/api/tethr";
import {
  galaxyDust,
  layoutGalaxy,
  linkPath,
  ringSegment,
  specFor,
  type EarnedUnlocks,
  type GalaxySpec,
  type PlacedStar,
} from "@/lib/tethr-growth-map";

// The growth map as a galaxy (phase 26.9): the company's nebula at the center,
// one star per growth area on two spiral arms, a ring of six unlocks around
// each, a planet for each thing tethr knows there, and faint lines between
// areas that feed each other (lit once both are Working). All ink (currentColor)
// at different strengths; the only color is the status dot of an agent at work.
// Styles: `.tethr-galaxy*` in tethr-theme.css. Every star is a button.

const UNLOCK_ORDER = ["mapped", "equipped", "informed", "aimed", "staffed", "proven"] as const;

function starLabel(a: TethrGrowthArea): string {
  const next = a.next ? ` Next: ${a.next.label}.` : " All six unlocked.";
  return `${a.name}, level ${a.level} of 6, ${a.levelName}.${a.focus ? " This week's focus." : ""}${a.active ? " An agent is working here now." : ""}${next}`;
}

function Star({
  area,
  star,
  spec,
  selected,
  fresh,
  glowId,
  onSelect,
}: {
  area: TethrGrowthArea;
  star: PlacedStar;
  spec: GalaxySpec;
  selected: boolean;
  fresh: string[];
  glowId: string;
  onSelect: (id: TethrAreaId) => void;
}) {
  const { x, y } = star;
  const earned = new Set(area.unlocks.filter((u) => u.earned).map((u) => u.key));
  const onKey = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(area.id);
    }
  };
  const origin = { transformOrigin: `${x}px ${y}px` };
  const s = spec.scale;
  const lineGap = spec.subFont * 1.6;
  return (
    <g
      className={cn("tethr-galaxy-star", selected && "is-selected", area.level === 0 && "is-unexplored")}
      role="button"
      tabIndex={0}
      aria-label={starLabel(area)}
      aria-pressed={selected}
      onClick={() => onSelect(area.id)}
      onKeyDown={onKey}
      data-area={area.id}
    >
      {area.level > 0 ? <circle cx={x} cy={y} r={star.glow} fill={`url(#${glowId})`} opacity={0.3 + area.level * 0.1} /> : null}
      <circle className="tethr-galaxy-hit" cx={x} cy={y} r={star.ring + 12 * s} />
      {star.planets.length ? (
        <>
          {[...new Set(star.planets.map((p) => p.orbit))].map((r) => (
            <circle key={r} cx={x} cy={y} r={r} className="tethr-galaxy-orbit-line" />
          ))}
          <g className="tethr-galaxy-orbit" style={origin}>
            {star.planets
              .filter((p) => p.orbit === star.orbits[0])
              .map((p, i) => (
                <circle key={i} cx={x + p.orbit * Math.cos((p.angle * Math.PI) / 180)} cy={y + p.orbit * Math.sin((p.angle * Math.PI) / 180)} r={p.r} className="tethr-galaxy-planet" />
              ))}
          </g>
          <g className="tethr-galaxy-orbit tethr-galaxy-orbit-outer" style={origin}>
            {star.planets
              .filter((p) => p.orbit === star.orbits[1])
              .map((p, i) => (
                <circle key={i} cx={x + p.orbit * Math.cos((p.angle * Math.PI) / 180)} cy={y + p.orbit * Math.sin((p.angle * Math.PI) / 180)} r={p.r} className="tethr-galaxy-planet" />
              ))}
          </g>
        </>
      ) : null}
      {area.focus ? <circle cx={x} cy={y} r={star.ring + 7 * s} className="tethr-galaxy-halo" style={origin} /> : null}
      {selected ? <circle cx={x} cy={y} r={star.ring + 4.5 * s} className="tethr-galaxy-selected" /> : null}
      <circle cx={x} cy={y} r={star.ring + 4.5 * s} className="tethr-galaxy-focusring" />
      {UNLOCK_ORDER.map((key, i) => {
        const on = earned.has(key);
        const isNew = fresh.includes(key);
        return (
          <path
            key={key}
            d={ringSegment(x, y, star.ring, i)}
            className={cn("tethr-galaxy-seg", on && "is-on", isNew && "is-new")}
            style={{ strokeWidth: (on ? 2.4 : 1.6) * s, ...(isNew ? { animationDelay: `${300 + i * 140}ms` } : {}) }}
          />
        );
      })}
      {fresh.length ? <circle cx={x} cy={y} r={star.ring} className="tethr-galaxy-bloom" /> : null}
      {star.core ? (
        <circle cx={x} cy={y} r={star.core} className="tethr-galaxy-core" opacity={0.55 + area.level * 0.075} />
      ) : (
        <circle cx={x} cy={y} r={4 * s} className="tethr-galaxy-core tethr-galaxy-core-empty" style={{ strokeWidth: 1.2 * s }} />
      )}
      {area.active ? <circle cx={x + star.ring * 0.72} cy={y - star.ring * 0.72} r={3.4 * s} className="tethr-galaxy-live" /> : null}
      <text x={star.label.x} y={star.label.y} textAnchor={star.label.anchor} className="tethr-galaxy-label">
        {star.label.lines.map((line, i) => (
          <tspan
            key={i}
            x={star.label.x}
            dy={i === 0 ? 0 : lineGap}
            className={i === 0 ? "tethr-galaxy-name" : "tethr-galaxy-sub"}
            style={{ fontSize: i === 0 ? spec.labelFont : spec.subFont }}
          >
            {line}
          </tspan>
        ))}
      </text>
    </g>
  );
}

/** The galaxy sized to its box: wide or compact, with text at the same px size at any width. */
export function Galaxy(props: { map: TethrGrowthMap; selected: TethrAreaId | null; fresh: EarnedUnlocks; onSelect: (id: TethrAreaId) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const spec = useMemo(() => specFor(width), [width]);
  return <div ref={ref}>{width ? <GalaxySvg {...props} spec={spec} /> : null}</div>;
}

function GalaxySvg({
  map,
  spec,
  selected,
  fresh,
  onSelect,
}: {
  map: TethrGrowthMap;
  spec: GalaxySpec;
  selected: TethrAreaId | null;
  fresh: EarnedUnlocks;
  onSelect: (id: TethrAreaId) => void;
}) {
  const uid = `tg${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const visible = map.areas.filter((a) => !a.hidden);
  const placed = useMemo(
    () =>
      layoutGalaxy(
        visible.map((a) => ({
          id: a.id,
          name: a.name,
          short: a.short,
          arm: a.arm,
          step: a.step,
          level: a.level,
          levelName: a.levelName,
          knows: a.knowledge.notes.length + a.knowledge.skills.length,
          focus: a.focus,
        })),
        spec,
      ),
    // Re-lay out only when what the layout reads changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, visible.map((a) => `${a.id}:${a.level}:${a.knowledge.notes.length + a.knowledge.skills.length}:${a.focus}`).join("|")],
  );
  const dust = useMemo(() => galaxyDust(spec), [spec]);
  const at = new Map(placed.map((p) => [p.id, p]));
  const { cx, cy } = spec;
  const wide = spec.kind === "wide";

  return (
    <svg
      viewBox={`0 0 ${spec.width} ${spec.height}`}
      className={cn("tethr-galaxy-svg", `tethr-galaxy-${spec.kind}`)}
      role="group"
      aria-label={`Growth map. ${map.company.name} is at level ${map.company.level} of ${map.company.max}.`}
    >
      {/* The gradients use currentColor, so they follow Day and Night. */}
      <defs>
        <radialGradient id={`${uid}-glow`}>
          <stop offset="0" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="0.35" stopColor="currentColor" stopOpacity="0.13" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-core`}>
          <stop offset="0" stopColor="currentColor" stopOpacity="0.9" />
          <stop offset="0.18" stopColor="currentColor" stopOpacity="0.32" />
          <stop offset="0.6" stopColor="currentColor" stopOpacity="0.06" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g className="tethr-galaxy-dust" aria-hidden="true">
        {dust.map((d, i) => (
          <circle key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} r={d.r.toFixed(2)} opacity={d.o.toFixed(2)} />
        ))}
      </g>

      <g aria-hidden="true">
        {map.links.map((l) => {
          const a = at.get(l.from);
          const b = at.get(l.to);
          if (!a || !b) return null;
          return <path key={`${l.from}-${l.to}`} d={linkPath(a, b, spec)} className={cn("tethr-galaxy-link", l.lit && "is-lit")} />;
        })}
      </g>

      <g className="tethr-galaxy-center" aria-hidden="true">
        <circle cx={cx} cy={cy} r={spec.centerR} fill={`url(#${uid}-core)`} />
        <g className="tethr-galaxy-swirl" style={{ transformOrigin: `${cx}px ${cy}px` }}>
          {[
            [34, 13, -24],
            [46, 17, 28],
            [26, 10, 70],
          ].map(([rx, ry, rot]) => (
            <ellipse key={rot} cx={cx} cy={cy} rx={rx * spec.scale} ry={ry * spec.scale} transform={`rotate(${rot} ${cx} ${cy})`} />
          ))}
        </g>
        <circle cx={cx} cy={cy} r={4.2 * spec.scale} className="tethr-galaxy-heart" />
        {/* On a phone the page says the level above the map: there's no room for it here. */}
        {wide ? (
          <>
            <text x={cx} y={cy + spec.centerR * 0.6 + spec.labelFont * 0.4} textAnchor="middle" className="tethr-galaxy-company" style={{ fontSize: spec.labelFont }}>
              {map.company.name.length > 22 ? `${map.company.name.slice(0, 21)}…` : map.company.name}
            </text>
            <text x={cx} y={cy + spec.centerR * 0.6 + spec.labelFont * 0.4 + spec.subFont * 1.6} textAnchor="middle" className="tethr-galaxy-sub" style={{ fontSize: spec.subFont }}>
              LEVEL {map.company.level} OF {map.company.max}
            </text>
          </>
        ) : null}
      </g>

      {visible.map((area) => {
        const star = at.get(area.id);
        if (!star) return null;
        return (
          <Star key={area.id} area={area} star={star} spec={spec} selected={selected === area.id} fresh={fresh[area.id] ?? []} glowId={`${uid}-glow`} onSelect={onSelect} />
        );
      })}
    </svg>
  );
}
