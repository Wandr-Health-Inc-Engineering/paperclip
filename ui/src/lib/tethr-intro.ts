// The startup intro: when it plays, when the app under it counts as ready, and
// when it leaves. Pure functions only (components/tethr/StartupIntro.tsx shows
// it), so the timing is testable.
//
// The picture: tethr's nebula swirls in out of a blur and settles, its core
// flares once, then the wordmark rises under it and the app comes up from
// underneath. The motion itself is CSS (.tethr-intro* in tethr-theme.css).

export type IntroReason = "login" | "desktop" | "preview";

/** Set by the sign-in page so the next app screen opens with the intro. */
export const INTRO_PENDING_KEY = "tethr.intro.pending";
/** Set once the intro has played in this window (sessionStorage). */
export const INTRO_SEEN_KEY = "tethr.intro.seen";
export const INTRO_EVENT = "tethr:intro";

/** Pages outside the app (sign-in, invites, CLI and board claims). */
const PUBLIC_ROUTES = /^\/(auth|invite|board-claim|cli-auth)(\/|$)/;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_ROUTES.test(pathname);
}

/** The Tethr desktop app's window identifies itself in the user agent. */
export function isDesktopClient(userAgent: string): boolean {
  return /\bTethrDesktop\//.test(userAgent);
}

type SessionLike = Pick<Storage, "getItem">;

/**
 * Whether the intro should play now, and why:
 * - right after signing in (the sign-in page asks for it),
 * - when the desktop app starts (once per app run: sessionStorage lives as long
 *   as the window's web view),
 * - `?intro` in the address, on first load, to preview it.
 * Never on the sign-in or invite pages unless it was asked for by signing in.
 */
export function introReason(input: {
  pathname: string;
  search: string;
  userAgent: string;
  session: SessionLike | null;
  /** First evaluation after the page loaded (only then does ?intro count). */
  initial: boolean;
}): IntroReason | null {
  const read = (key: string) => {
    try {
      return input.session?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  if (input.initial && new URLSearchParams(input.search).has("intro")) return "preview";
  if (read(INTRO_PENDING_KEY)) return "login";
  if (read(INTRO_SEEN_KEY)) return null;
  if (isPublicPath(input.pathname)) return null;
  if (isDesktopClient(input.userAgent)) return "desktop";
  return null;
}

/** This window's sessionStorage, or null where the browser blocks it. */
export function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Ask for the intro (the sign-in page calls this when sign-in succeeds). */
export function requestIntro(): void {
  try {
    sessionStorageOrNull()?.setItem(INTRO_PENDING_KEY, "1");
  } catch {
    /* storage blocked: the intro just won't play */
  }
  window.dispatchEvent(new Event(INTRO_EVENT));
}

/** Played: don't play again in this window (a reload mid-intro doesn't replay it). */
export function markIntroPlayed(): void {
  try {
    const storage = sessionStorageOrNull();
    storage?.removeItem(INTRO_PENDING_KEY);
    storage?.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    /* storage blocked: it may replay on reload, which is harmless */
  }
}

// ---- timing (ms from the start) -------------------------------------------

export const INTRO = {
  /** earliest the app may come up; the nebula and the wordmark have settled by then */
  holdMin: 1950,
  /** latest: if the app still isn't ready, get out of the way anyway */
  holdMax: 9000,
  exit: 620,
  /** reduced motion: a short, still card */
  reducedHold: 900,
  reducedExit: 300,
} as const;

/** A screen without the app's main column (onboarding, an error) counts as ready after this. */
export const READY_FALLBACK_MS = 3500;

/**
 * Has the app come up under the intro? Its main column has rendered; or a
 * screen without one has settled; or (for anything but a sign-in) the app has
 * gone to a public page such as the sign-in form, which is what the person
 * needs to see next. A sign-in intro starts ON the sign-in page and waits for
 * the hop into the app, so it doesn't count that page.
 */
export function introReady(input: {
  reason: IntroReason;
  t: number;
  hasMainColumn: boolean;
  onPublicPage: boolean;
  companyLoading: boolean;
}): boolean {
  if (input.hasMainColumn) return true;
  if (input.onPublicPage) return input.reason !== "login";
  return input.t >= READY_FALLBACK_MS && !input.companyLoading;
}

/** When the overlay starts leaving, given when the app became ready (ms, or null if not yet). */
export function exitAt(readyAt: number | null, now: number, reduced: boolean): number | null {
  const min = reduced ? INTRO.reducedHold : INTRO.holdMin;
  if (readyAt !== null) return Math.max(min, readyAt);
  return now >= INTRO.holdMax ? now : null;
}
