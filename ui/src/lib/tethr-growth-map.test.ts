import { describe, expect, it } from "vitest";
import {
  COMPACT_SPEC,
  earnedUnlocks,
  layoutGalaxy,
  newUnlocks,
  overlaps,
  starPosition,
  specFor,
  starSizes,
  WIDE_SPEC,
  type GalaxySpec,
  type Rect,
  type StarInput,
} from "./tethr-growth-map";

// Phase 26.9: the growth map's geometry. No two labels, and no label and a
// star, may overlap at desktop or phone size, whatever the levels and however
// much tethr knows.

const AREAS: Array<Pick<StarInput, "id" | "name" | "short" | "arm" | "step">> = [
  { id: "positioning", name: "Positioning", short: "Position", arm: 0, step: 0 },
  { id: "content", name: "Content & social", short: "Content", arm: 0, step: 1 },
  { id: "seo", name: "Search (SEO)", short: "SEO", arm: 0, step: 2 },
  { id: "geo", name: "AI search (GEO)", short: "GEO", arm: 0, step: 3 },
  { id: "paid_ads", name: "Paid ads", short: "Paid ads", arm: 0, step: 4 },
  { id: "measurement", name: "Measurement", short: "Measure", arm: 0, step: 5 },
  { id: "customer_voice", name: "Customer voice", short: "Voice", arm: 1, step: 0 },
  { id: "conversion", name: "Conversion", short: "Convert", arm: 1, step: 1 },
  { id: "pricing", name: "Pricing & offers", short: "Pricing", arm: 1, step: 2 },
  { id: "retention", name: "Retention", short: "Retain", arm: 1, step: 3 },
  { id: "email", name: "Email & lifecycle", short: "Email", arm: 1, step: 4 },
  { id: "partnerships", name: "Partnerships", short: "Partners", arm: 1, step: 5 },
];
const NAMES = ["Unexplored", "Discovered", "Charted", "Working", "Established", "Strong", "Mastered"];

const stars = (level: (i: number) => number, knows: (i: number) => number): StarInput[] =>
  AREAS.map((a, i) => ({ ...a, level: level(i), levelName: NAMES[level(i)], knows: knows(i) }));

function body(spec: GalaxySpec, s: StarInput): Rect {
  const { x, y } = starPosition(s.arm, s.step, spec);
  const h = starSizes(s.level, spec).ring + 3;
  return { x0: x - h, y0: y - h, x1: x + h, y1: y + h };
}

const CASES: Array<[string, StarInput[]]> = [
  ["all unexplored", stars(() => 0, () => 0)],
  ["every level 0-6", stars((i) => i % 7, (i) => i % 9)],
  ["all mastered, full orbits", stars(() => 6, () => 8)],
  // The focus is one area at a time: try each.
  ...AREAS.map((a): [string, StarInput[]] => [`focus on ${a.id}`, stars(() => 4, () => 5).map((s) => ({ ...s, focus: s.id === a.id }))]),
];

// Phones (320-639px wide), then the wide map from its narrowest to full size.
const WIDTHS = [320, 375, 430, 600, 640, 700, 768, 900, 1000, 1200];

describe("growth map layout", () => {
  it("keeps text at least 10px on screen at every width", () => {
    for (const w of WIDTHS) {
      const spec = specFor(w);
      const px = (units: number) => (units * w) / spec.width;
      expect(px(spec.labelFont), `name at ${w}px`).toBeGreaterThanOrEqual(10.9);
      if (spec.subFont) expect(px(spec.subFont), `level at ${w}px`).toBeGreaterThanOrEqual(9.9);
    }
    expect(specFor(375).kind).toBe("compact");
    expect(specFor(800).kind).toBe("wide");
  });

  for (const spec of [WIDE_SPEC, COMPACT_SPEC, ...WIDTHS.map(specFor)]) {
    for (const [what, input] of CASES) {
      it(`${spec.kind} (name ${spec.labelFont}), ${what}: labels clear each other, the stars, the center and the frame`, () => {
        const placed = layoutGalaxy(input, spec);
        expect(placed).toHaveLength(12);
        const center: Rect = {
          x0: spec.cx - spec.centerBox.w / 2,
          y0: spec.cy - spec.centerBox.h / 2,
          x1: spec.cx + spec.centerBox.w / 2,
          y1: spec.cy + spec.centerBox.h / 2,
        };
        for (const [i, p] of placed.entries()) {
          const box = p.label.box;
          expect(box.x0).toBeGreaterThanOrEqual(0);
          expect(box.y0).toBeGreaterThanOrEqual(0);
          expect(box.x1).toBeLessThanOrEqual(spec.width);
          expect(box.y1).toBeLessThanOrEqual(spec.height);
          expect(overlaps(box, center), `${p.id} label on the center`).toBe(false);
          for (const [j, q] of placed.entries()) {
            if (i === j) continue;
            expect(overlaps(box, q.label.box), `${p.id} and ${q.id} labels`).toBe(false);
            expect(overlaps(box, body(spec, input[j])), `${p.id} label on ${q.id}`).toBe(false);
          }
        }
        // Stars never sit on each other either.
        for (let i = 0; i < input.length; i++) {
          for (let j = i + 1; j < input.length; j++) expect(overlaps(body(spec, input[i]), body(spec, input[j]))).toBe(false);
        }
      });
    }
  }

  it("gives each thing tethr knows a planet, up to eight, the same way every time", () => {
    const a = layoutGalaxy(stars(() => 3, (i) => i), WIDE_SPEC);
    const b = layoutGalaxy(stars(() => 3, (i) => i), WIDE_SPEC);
    expect(a.map((s) => s.planets.length)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8]);
    expect(a).toEqual(b);
  });

  it("shows names with levels on the wide map and short names on a phone", () => {
    const input = stars(() => 3, () => 0);
    expect(layoutGalaxy(input, WIDE_SPEC)[2].label.lines).toEqual(["Search (SEO)", "LV 3"]);
    expect(layoutGalaxy(input.map((s) => ({ ...s, focus: s.id === "seo" })), WIDE_SPEC)[2].label.lines).toEqual(["Search (SEO)", "LV 3 · FOCUS"]);
    expect(layoutGalaxy(input, COMPACT_SPEC)[2].label.lines).toEqual(["SEO"]);
  });
});

describe("growth map: what's new since the last visit", () => {
  const areas = (seoKeys: string[]) => [
    { id: "seo", unlocks: ["mapped", "equipped", "informed"].map((key) => ({ key, earned: seoKeys.includes(key) })) },
    { id: "geo", unlocks: [{ key: "mapped", earned: false }] },
  ];

  it("blooms only unlocks earned since then, and nothing on a first visit", () => {
    const before = earnedUnlocks(areas(["mapped"]));
    const now = earnedUnlocks(areas(["mapped", "informed"]));
    expect(newUnlocks(before, now)).toEqual({ seo: ["informed"] });
    expect(newUnlocks(now, now)).toEqual({});
    expect(newUnlocks(null, now)).toEqual({});
    // A lost unlock isn't news.
    expect(newUnlocks(now, before)).toEqual({});
  });
});
