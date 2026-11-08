import { describe, expect, it } from "vitest";
import { INTRO, INTRO_PENDING_KEY, INTRO_SEEN_KEY, exitAt, introReady, introReason, isDesktopClient } from "./tethr-intro";

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

describe("when the app counts as ready under the intro", () => {
  const base = { t: 500, hasMainColumn: false, onPublicPage: false, companyLoading: false };

  it("is ready once the app's main column renders", () => {
    expect(introReady({ ...base, reason: "desktop", hasMainColumn: true })).toBe(true);
    expect(introReady({ ...base, reason: "login", hasMainColumn: true })).toBe(true);
  });

  it("a signed-out desktop launch lands on the sign-in page: that's ready, not a 9 second wait", () => {
    expect(introReady({ ...base, reason: "desktop", onPublicPage: true })).toBe(true);
    expect(introReady({ ...base, reason: "preview", onPublicPage: true })).toBe(true);
  });

  it("a sign-in intro starts on the sign-in page and waits for the hop into the app", () => {
    expect(introReady({ ...base, reason: "login", onPublicPage: true, t: 8000 })).toBe(false);
  });

  it("a screen without the main column counts after a while, once companies have loaded", () => {
    expect(introReady({ ...base, reason: "desktop", t: 3000 })).toBe(false);
    expect(introReady({ ...base, reason: "desktop", t: 3600 })).toBe(true);
    expect(introReady({ ...base, reason: "desktop", t: 3600, companyLoading: true })).toBe(false);
  });
});

