// The growth map's geometry and memory (phase 26.9). Pure, so it's tested
// without a browser: where each star sits on the two spiral arms, where its
// label goes so no two labels (or a label and a star) ever overlap, the links,
// the dust, and which unlocks are new since this person last opened the map.

export interface GalaxySpec {
  kind: "wide" | "compact";
  width: number;
  height: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** How far out each step of an arm sits (fraction of rx/ry). */
  radii: number[];
  /** Sizes scale with this (stars, rings, orbits). */
  scale: number;
  labelFont: number;
  subFont: number;
  /** The company nebula at the center: its radius, and the box its label needs. */
  centerR: number;
  centerBox: { w: number; h: number };
}

export const WIDE_SPEC: GalaxySpec = {
  kind: "wide",
  width: 800,
  height: 512,
  cx: 400,
  cy: 254,
  rx: 336,
  ry: 202,
  radii: [0.3, 0.43, 0.56, 0.69, 0.82, 0.95],
  scale: 0.82,
  labelFont: 12.5,
  subFont: 10,
  centerR: 60,
  centerBox: { w: 140, h: 104 },
};

/** For a phone: nearly square, bigger type (it's scaled down to ~350px), short names. */
export const COMPACT_SPEC: GalaxySpec = {
  kind: "compact",
  width: 600,
  height: 660,
  cx: 300,
  cy: 330,
  rx: 252,
  ry: 290,
  radii: [0.36, 0.48, 0.6, 0.71, 0.83, 0.95],
  scale: 1.25,
  labelFont: 18,
  subFont: 0,
  centerR: 70,
  centerBox: { w: 150, h: 112 },
};

/** Below this container width the page uses the compact map. */
export const COMPACT_BELOW = 640;

/** The size the map's text shows at on screen, in px (the brand's floor is 10). */
export const TEXT_PX = { wide: { name: 12.5, sub: 10 }, compact: { name: 11, sub: 0 } } as const;

/**
 * The spec for a map drawn `renderWidth` px wide. The SVG scales with its box,
 * so text is sized in map units to land at the same px size at any width.
 */
export function specFor(renderWidth: number): GalaxySpec {
  const base = renderWidth < COMPACT_BELOW ? COMPACT_SPEC : WIDE_SPEC;
  if (!(renderWidth > 0)) return base;
  const unitsPerPx = base.width / renderWidth;
  const units = (px: number) => Math.round(px * unitsPerPx * 10) / 10;
  const px = TEXT_PX[base.kind];
  return { ...base, labelFont: Math.max(units(px.name), base.kind === "compact" ? base.labelFont : 0), subFont: px.sub ? units(px.sub) : 0 };
}

export const MAX_PLANETS = 8;

export interface StarInput {
  id: string;
  name: string;
  short: string;
  arm: 0 | 1;
  step: number;
  level: number;
  levelName: string;
  /** Things tethr knows here (notes and skills): one planet each, up to MAX_PLANETS. */
  knows: number;
  /** The area tethr is working this week. */
  focus?: boolean;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface StarLabel {
  x: number;
  /** Baseline of the first line. */
  y: number;
  anchor: "start" | "middle" | "end";
  lines: string[];
  box: Rect;
}

export interface PlacedStar {
  id: string;
  x: number;
  y: number;
  /** Radius of the bright core (0 for an unexplored area, drawn as a dashed ring). */
  core: number;
  glow: number;
  ring: number;
  orbits: number[];
  planets: Array<{ orbit: number; angle: number; r: number }>;
  label: StarLabel;
}

export interface Dust {
  x: number;
  y: number;
  r: number;
  o: number;
}

/** Small seeded generator, so the map looks the same on every visit. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 1) / 2 ** 31;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function starPosition(arm: number, step: number, spec: GalaxySpec): { x: number; y: number } {
  const theta = ((-30 + 42 * step + 180 * arm) * Math.PI) / 180;
  const r = spec.radii[Math.max(0, Math.min(spec.radii.length - 1, step))];
  return { x: spec.cx + spec.rx * r * Math.cos(theta), y: spec.cy + spec.ry * r * Math.sin(theta) };
}

/** Sizes for a star at a level (0-6). */
export function starSizes(level: number, spec: GalaxySpec) {
  const s = spec.scale;
  return { core: level ? (3 + level * 1.3) * s : 0, glow: (16 + level * 7.5) * s, ring: 19 * s, orbits: [27 * s, 34 * s] };
}

/** Text width, estimated: Geist runs about 0.56em a character, the spaced mono label about 0.72em. */
export function textWidth(text: string, font: number, mono = false): number {
  return text.length * font * (mono ? 0.72 : 0.57);
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function inside(r: Rect, spec: GalaxySpec, margin = 6): boolean {
  return r.x0 >= margin && r.y0 >= margin && r.x1 <= spec.width - margin && r.y1 <= spec.height - margin;
}

/** The lines a star's label shows: the name and level ("LV 3") on the wide map, the short name on a phone. */
export function labelLines(star: StarInput, spec: GalaxySpec): string[] {
  return spec.kind === "wide" ? [star.name, `LV ${star.level}${star.focus ? " · FOCUS" : ""}`] : [star.short];
}

function labelBox(x: number, y: number, anchor: StarLabel["anchor"], lines: string[], spec: GalaxySpec): Rect {
  const widths = lines.map((l, i) => textWidth(l, i === 0 ? spec.labelFont : spec.subFont, i > 0));
  const w = Math.max(...widths);
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  const lineGap = spec.subFont * 1.6;
  return { x0, y0: y - spec.labelFont * 0.82, x1: x0 + w, y1: y + (lines.length - 1) * lineGap + spec.labelFont * 0.28 };
}

/** The square a star (with its ring) takes up, for keeping labels off it. */
function bodyBox(x: number, y: number, ring: number): Rect {
  const h = ring + 3;
  return { x0: x - h, y0: y - h, x1: x + h, y1: y + h };
}

function centerRect(spec: GalaxySpec): Rect {
  const { w, h } = spec.centerBox;
  return { x0: spec.cx - w / 2, y0: spec.cy - h / 2, x1: spec.cx + w / 2, y1: spec.cy + h / 2 + 8 };
}

function labelCandidates(x: number, y: number, reach: number, lines: string[], spec: GalaxySpec): Array<Omit<StarLabel, "box" | "lines">> {
  const dx = x - spec.cx;
  const dy = y - spec.cy;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  const lineGap = spec.subFont * 1.6;
  const tall = (lines.length - 1) * lineGap;
  const side = (dir: 1 | -1) => ({ x: x + dir * (reach + 4), y: y + spec.labelFont * 0.32 - tall / 2, anchor: dir > 0 ? ("start" as const) : ("end" as const) });
  const below = { x, y: y + reach + spec.labelFont * 0.9, anchor: "middle" as const };
  const above = { x, y: y - reach - tall - spec.labelFont * 0.3, anchor: "middle" as const };
  const outward = Math.abs(ux) >= 0.45 ? [side(ux > 0 ? 1 : -1)] : uy > 0 ? [below] : [above];
  // Corners: beside the star, a line above or below its middle.
  const corner = (dir: 1 | -1, up: 1 | -1) => ({ ...side(dir), y: y + up * (reach * 0.7 + spec.labelFont * 0.2) + (up > 0 ? spec.labelFont * 0.6 : -tall) });
  return [
    ...outward,
    uy > 0 ? below : above,
    uy > 0 ? above : below,
    side(1),
    side(-1),
    corner(ux >= 0 ? 1 : -1, uy >= 0 ? 1 : -1),
    corner(ux >= 0 ? 1 : -1, uy >= 0 ? -1 : 1),
    corner(ux >= 0 ? -1 : 1, uy >= 0 ? 1 : -1),
    corner(ux >= 0 ? -1 : 1, uy >= 0 ? -1 : 1),
  ];
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
}

/**
 * Where every star, its planets and its label go. Labels are placed one by one,
 * each at the first spot (outward from the center first) that clears the frame,
 * the center, every star and every label already placed.
 */
export function layoutGalaxy(stars: StarInput[], spec: GalaxySpec): PlacedStar[] {
  const bodies = stars.map((s) => {
    const p = starPosition(s.arm, s.step, spec);
    return { star: s, ...p, sizes: starSizes(s.level, spec) };
  });
  const blocked: Rect[] = [centerRect(spec), ...bodies.map((b) => bodyBox(b.x, b.y, b.sizes.ring))];
  // Stars nearest the center first: they have the least room.
  const order = [...bodies].sort((a, b) => a.star.step - b.star.step || a.star.arm - b.star.arm);
  const labels = new Map<string, StarLabel>();
  for (const b of order) {
    const knows = Math.min(MAX_PLANETS, b.star.knows);
    const reach = (knows > 4 ? b.sizes.orbits[1] : knows ? b.sizes.orbits[0] : b.sizes.ring) + 5 * spec.scale;
    const lines = labelLines(b.star, spec);
    const own = bodyBox(b.x, b.y, b.sizes.ring);
    const candidates = labelCandidates(b.x, b.y, reach, lines, spec).map((c) => ({ ...c, lines, box: labelBox(c.x, c.y, c.anchor, lines, spec) }));
    const fits = (c: StarLabel) => inside(c.box, spec) && blocked.every((r) => r === own || !overlaps(c.box, r));
    // Nowhere clear: the spot in the frame that covers the least.
    const least = () =>
      candidates
        .filter((c) => inside(c.box, spec))
        .map((c) => ({ c, cover: blocked.reduce((n, r) => (r === own ? n : n + overlapArea(c.box, r)), 0) }))
        .sort((a, b) => a.cover - b.cover)[0]?.c;
    const chosen = candidates.find(fits) ?? least() ?? candidates[0];
    labels.set(b.star.id, chosen);
    blocked.push(chosen.box);
  }
  return bodies.map((b) => {
    const rand = seeded(hash(b.star.id));
    const knows = Math.min(MAX_PLANETS, b.star.knows);
    const planets = Array.from({ length: knows }, (_, i) => ({
      orbit: i < 4 ? b.sizes.orbits[0] : b.sizes.orbits[1],
      angle: (i % 4) * 90 + rand() * 60,
      r: (1.5 + rand()) * spec.scale,
    }));
    return { id: b.star.id, x: b.x, y: b.y, ...b.sizes, planets, label: labels.get(b.star.id)! };
  });
}

/** A gently curved line between two stars, bowed away from the center. */
export function linkPath(a: { x: number; y: number }, b: { x: number; y: number }, spec: GalaxySpec): string {
  const mx = (a.x + b.x) / 2 + (spec.cy - (a.y + b.y) / 2) * 0.12;
  const my = (a.y + b.y) / 2 + ((a.x + b.x) / 2 - spec.cx) * 0.12;
  const f = (n: number) => n.toFixed(1);
  return `M${f(a.x)} ${f(a.y)} Q${f(mx)} ${f(my)} ${f(b.x)} ${f(b.y)}`;
}

/** Far stars, then dust along the two arms. */
export function galaxyDust(spec: GalaxySpec): Dust[] {
  const rand = seeded(7);
  const out: Dust[] = [];
  const far = spec.kind === "wide" ? 150 : 90;
  for (let i = 0; i < far; i++) out.push({ x: rand() * spec.width, y: rand() * spec.height, r: (0.5 + rand() * 0.7) * spec.scale, o: 0.05 + rand() * 0.16 });
  const perArm = spec.kind === "wide" ? 200 : 130;
  for (const arm of [0, 1]) {
    for (let i = 0; i < perArm; i++) {
      const t = i / perArm;
      const theta = ((-70 + 250 * t + 180 * arm) * Math.PI) / 180;
      const r = 0.12 + 0.9 * t;
      const spread = (14 + 34 * t) * spec.scale;
      out.push({
        x: spec.cx + spec.rx * r * Math.cos(theta) + (rand() - 0.5) * spread * 2,
        y: spec.cy + spec.ry * r * Math.sin(theta) + (rand() - 0.5) * spread * 1.3,
        r: (0.5 + rand()) * spec.scale,
        o: 0.05 + rand() * 0.2 * (1 - t * 0.6),
      });
    }
  }
  return out;
}

/** A six-segment ring: segment i of 6 as an SVG arc, with a small gap between segments. */
export function ringSegment(cx: number, cy: number, r: number, i: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a0 = rad(-90 + i * 60 + 6);
  const a1 = rad(-90 + (i + 1) * 60 - 6);
  const f = (n: number) => n.toFixed(2);
  return `M${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))} A${f(r)} ${f(r)} 0 0 1 ${f(cx + r * Math.cos(a1))} ${f(cy + r * Math.sin(a1))}`;
}

// ---- what's new since the last visit -------------------------------------------

/** Area id → the unlocks it has earned. */
export type EarnedUnlocks = Record<string, string[]>;

export function earnedUnlocks(areas: Array<{ id: string; unlocks: Array<{ key: string; earned: boolean }> }>): EarnedUnlocks {
  return Object.fromEntries(areas.map((a) => [a.id, a.unlocks.filter((u) => u.earned).map((u) => u.key)]));
}

/** Unlocks earned now that weren't at the last visit. A first visit has no last visit, so nothing is new. */
export function newUnlocks(seen: EarnedUnlocks | null, now: EarnedUnlocks): EarnedUnlocks {
  if (!seen) return {};
  const out: EarnedUnlocks = {};
  for (const [area, keys] of Object.entries(now)) {
    const fresh = keys.filter((k) => !(seen[area] ?? []).includes(k));
    if (fresh.length) out[area] = fresh;
  }
  return out;
}

const seenKey = (companyId: string) => `tethr.growthMap.seen.${companyId}`;

export function readSeenUnlocks(companyId: string): EarnedUnlocks | null {
  try {
    const raw = window.localStorage.getItem(seenKey(companyId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as EarnedUnlocks) : null;
  } catch {
    return null;
  }
}

export function writeSeenUnlocks(companyId: string, earned: EarnedUnlocks): void {
  try {
    window.localStorage.setItem(seenKey(companyId), JSON.stringify(earned));
  } catch {
    // Storage can be off (a private window); the map still works, nothing blooms.
  }
}
