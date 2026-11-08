import { describe, expect, it } from "vitest";
import {
  INTRO,
  INTRO_PENDING_KEY,
  INTRO_SEEN_KEY,
  exitAt,
  introReason,
  isDesktopClient,
  SLACK_SAG,
  slackSag,
  tetherFrame,
  tetherPath,
} from "./tethr-intro";

const DESKTOP_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) TethrDesktop/1.0";
const BROWSER_UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

function store(entries: Record<string, string> = {}) {
  return { getItem: (k: string) => entries[k] ?? null };
}

const base = { pathname: "/WD/chat", search: "", userAgent: BROWSER_UA, session: store(), initial: true };

describe("when the intro plays", () => {
  it("plays when the desktop app starts, once per run", () => {
    expect(isDesktopClient(DESKTOP_UA)).toBe(true);
    expect(isDesktopClient(BROWSER_UA)).toBe(false);
    expect(introReason({ ...base, userAgent: DESKTOP_UA })).toBe("desktop");
    expect(introReason({ ...base, userAgent: DESKTOP_UA, session: store({ [INTRO_SEEN_KEY]: "1" }) })).toBeNull();
  });

  it("doesn't play in a plain browser tab", () => {
    expect(introReason(base)).toBeNull();
  });

  it("plays after signing in, even if it already played in this window", () => {
    const session = store({ [INTRO_PENDING_KEY]: "1", [INTRO_SEEN_KEY]: "1" });
    expect(introReason({ ...base, session, initial: false })).toBe("login");
    // ...including on the sign-in page itself, so it covers the hop into the app
    expect(introReason({ ...base, pathname: "/auth", session, initial: false })).toBe("login");
  });

  it("never plays on its own on the sign-in or invite pages", () => {
    for (const pathname of ["/auth", "/invite/abc", "/board-claim/x", "/cli-auth/1"]) {
      expect(introReason({ ...base, pathname, userAgent: DESKTOP_UA })).toBeNull();
    }
    expect(introReason({ ...base, pathname: "/authors", userAgent: DESKTOP_UA })).toBe("desktop");
  });

  it("?intro previews it, but only on the first load", () => {
    expect(introReason({ ...base, search: "?intro", session: store({ [INTRO_SEEN_KEY]: "1" }) })).toBe("preview");
    expect(introReason({ ...base, search: "?intro", initial: false })).toBeNull();
  });

  it("treats unreadable storage as nothing stored", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(introReason({ ...base, userAgent: DESKTOP_UA, session: broken })).toBe("desktop");
    expect(introReason({ ...base, session: null })).toBeNull();
  });
});

describe("the tether", () => {
  it("starts empty: no nodes, nothing drawn", () => {
    const f = tetherFrame(0);
    expect(f.drawn).toBe(0);
    expect(f.nodeLeft.scale).toBe(0);
    expect(f.nodeRight.scale).toBe(0);
    expect(f.pulse).toBeNull();
    expect(f.glint).toBeNull();
  });

  it("hangs slack while it's thrown, then pulls apart until taut", () => {
    const thrown = tetherFrame(INTRO.drawTo);
    expect(thrown.drawn).toBe(1);
    expect(thrown.xRight - thrown.xLeft).toBeCloseTo(INTRO.spanSlack);
    expect(thrown.sag).toBe(SLACK_SAG);

    let lastSag = Infinity;
    for (let t = INTRO.pullFrom; t <= INTRO.pullTo; t += 20) {
      const f = tetherFrame(t);
      expect(f.sag).toBeGreaterThanOrEqual(0);
      expect(f.sag).toBeLessThanOrEqual(lastSag + 1e-9);
      lastSag = f.sag;
    }
    const taut = tetherFrame(INTRO.pullTo);
    expect(taut.xRight - taut.xLeft).toBeCloseTo(INTRO.spanTaut);
    expect(taut.sag).toBeCloseTo(0);
  });

  it("twangs a little when it catches, then settles straight and centered", () => {
    let maxUp = 0;
    for (let t = INTRO.pullTo; t < INTRO.pullTo + 400; t += 4) maxUp = Math.min(maxUp, tetherFrame(t).sag);
    expect(maxUp).toBeLessThan(-2);
    expect(maxUp).toBeGreaterThan(-6);

    const settled = tetherFrame(INTRO.holdMin);
    expect(settled.sag).toBe(0);
    expect((settled.xLeft + settled.xRight) / 2).toBe(INTRO.width / 2);
    expect(settled.nodeLeft.scale).toBeCloseTo(1);
    expect(settled.nodeRight.opacity).toBe(1);
  });

  it("pulses the nodes and runs the light along the line only around the catch", () => {
    expect(tetherFrame(INTRO.pullTo - 10).pulse).toBeNull();
    const mid = tetherFrame(INTRO.pullTo + INTRO.pulse / 2).pulse;
    expect(mid?.radius).toBeGreaterThan(3);
    expect(mid?.opacity).toBeGreaterThan(0);
    expect(tetherFrame(INTRO.pullTo + INTRO.pulse + 10).pulse).toBeNull();

    const g = tetherFrame(INTRO.pullTo + INTRO.glintDelay + INTRO.glint / 2).glint;
    expect(g?.at).toBeGreaterThan(0);
    expect(g?.at).toBeLessThan(1);
    expect(tetherFrame(INTRO.holdMin).glint).toBeNull();
  });

  it("draws the sag as a curve whose middle sits that far below the ends", () => {
    expect(tetherPath({ xLeft: 60, xRight: 360, sag: 10 })).toBe("M 60 40 Q 210 60 360 40");
    expect(slackSag(INTRO.spanTaut)).toBe(0);
    expect(slackSag(INTRO.spanTaut + 20)).toBe(0);
  });
});

describe("when it leaves", () => {
  it("waits for the wordmark even if the app is ready at once", () => {
    expect(exitAt(100, 200, false)).toBe(INTRO.holdMin);
    expect(exitAt(100, 200, true)).toBe(INTRO.reducedHold);
  });

  it("leaves as soon as the app is ready after that", () => {
    expect(exitAt(3200, 3200, false)).toBe(3200);
  });

  it("holds while the app is still loading, but not forever", () => {
    expect(exitAt(null, 5000, false)).toBeNull();
    expect(exitAt(null, INTRO.holdMax, false)).toBe(INTRO.holdMax);
  });
});
