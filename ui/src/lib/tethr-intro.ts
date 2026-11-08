// The startup intro: when it plays, and the geometry of the tether at each
// moment. Pure functions only (the component in components/tethr/StartupIntro
// draws them), so the timing is testable.
//
// The picture: two nodes appear close together with a slack line hanging
// between them, the line is thrown from one to the other, then the nodes pull
// apart until the line catches taut with a small twang. The wordmark rises
// above the taut line, and the app comes up from underneath.

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

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Ask for the intro (the sign-in page calls this when sign-in succeeds). */
export function requestIntro(): void {
  try {
    session()?.setItem(INTRO_PENDING_KEY, "1");
  } catch {
    /* storage blocked: the intro just won't play */
  }
  window.dispatchEvent(new Event(INTRO_EVENT));
}

/** Played: don't play again in this window (a reload mid-intro doesn't replay it). */
export function markIntroPlayed(): void {
  try {
    const s = session();
    s?.removeItem(INTRO_PENDING_KEY);
    s?.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    /* ignore */
  }
}

// ---- timing (ms from the start) -------------------------------------------

export const INTRO = {
  /** viewBox of the tether drawing */
  width: 420,
  height: 80,
  y: 40,
  /** span between the nodes at the start (slack) and at the end (taut) */
  spanSlack: 120,
  spanTaut: 300,
  nodeLeftAt: 100,
  nodeRightAt: 180,
  nodeIn: 320,
  drawFrom: 200,
  drawTo: 700,
  pullFrom: 720,
  pullTo: 1140,
  pulse: 650,
  glintDelay: 40,
  glint: 620,
  /** earliest the app may come up; the wordmark has settled by then */
  holdMin: 1950,
  /** latest: if the app still isn't ready, get out of the way anyway */
  holdMax: 9000,
  exit: 620,
  /** reduced motion: a short, still card */
  reducedHold: 900,
  reducedExit: 300,
} as const;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const progress = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));
export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeInCubic = (x: number) => x * x * x;
export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

/** How far the line hangs below its ends at a given span: deepest at the
 * slack start, zero once the span reaches the line's length, and dropping
 * fastest at the very end, so the line visibly snaps taut. (The textbook
 * shallow-cable formula isn't used: at this much slack it would make the line
 * hang deeper for a moment before tightening.) */
export const SLACK_SAG = 34;
export function slackSag(span: number, length: number = INTRO.spanTaut, start: number = INTRO.spanSlack): number {
  if (span >= length) return 0;
  if (span <= start) return SLACK_SAG;
  return SLACK_SAG * Math.sqrt((length - span) / (length - start));
}

export interface TetherFrame {
  xLeft: number;
  xRight: number;
  /** how far the middle of the line sits below the ends (negative = above) */
  sag: number;
  /** fraction of the line drawn, 0..1 */
  drawn: number;
  nodeLeft: { scale: number; opacity: number };
  nodeRight: { scale: number; opacity: number };
  /** the ring that pulses out of each node when the line catches; null when off */
  pulse: { radius: number; opacity: number } | null;
  /** the light that runs along the taut line; position -0.15..1 along it, null when off */
  glint: { at: number; opacity: number } | null;
}

function node(t: number, at: number) {
  const p = progress(t, at, at + INTRO.nodeIn);
  return { scale: p === 0 ? 0 : easeOutBack(p), opacity: clamp01((t - at) / (INTRO.nodeIn / 2)) };
}

/** The tether at time t (ms). */
export function tetherFrame(t: number): TetherFrame {
  const center = INTRO.width / 2;
  const pull = easeInCubic(progress(t, INTRO.pullFrom, INTRO.pullTo));
  const span = INTRO.spanSlack + (INTRO.spanTaut - INTRO.spanSlack) * pull;

  let sag = slackSag(span);
  if (t > INTRO.pullTo) {
    // The catch: a quick, damped twang above and below the taut line.
    const tau = (t - INTRO.pullTo) / 1000;
    sag = -6 * Math.exp(-9 * tau) * Math.sin(30 * tau);
    if (Math.abs(sag) < 0.01) sag = 0;
  }

  const pulseP = progress(t, INTRO.pullTo, INTRO.pullTo + INTRO.pulse);
  const glintFrom = INTRO.pullTo + INTRO.glintDelay;
  const glintP = progress(t, glintFrom, glintFrom + INTRO.glint);

  return {
    xLeft: center - span / 2,
    xRight: center + span / 2,
    sag,
    drawn: easeInOutCubic(progress(t, INTRO.drawFrom, INTRO.drawTo)),
    nodeLeft: node(t, INTRO.nodeLeftAt),
    nodeRight: node(t, INTRO.nodeRightAt),
    pulse:
      pulseP > 0 && pulseP < 1
        ? { radius: 3 + 13 * easeOutCubic(pulseP), opacity: 0.45 * (1 - pulseP) }
        : null,
    glint:
      glintP > 0 && glintP < 1
        ? { at: -0.15 + 1.15 * easeInOutCubic(glintP), opacity: Math.sin(Math.PI * glintP) }
        : null,
  };
}

/** The SVG path for a frame: a quadratic curve whose middle sits `sag` below the ends. */
export function tetherPath(f: Pick<TetherFrame, "xLeft" | "xRight" | "sag">, y: number = INTRO.y): string {
  const mid = (f.xLeft + f.xRight) / 2;
  const r = (n: number) => Math.round(n * 100) / 100;
  return `M ${r(f.xLeft)} ${y} Q ${r(mid)} ${r(y + 2 * f.sag)} ${r(f.xRight)} ${y}`;
}

/** When the overlay starts leaving, given when the app became ready (ms, or null if not yet). */
export function exitAt(readyAt: number | null, now: number, reduced: boolean): number | null {
  const min = reduced ? INTRO.reducedHold : INTRO.holdMin;
  if (readyAt !== null) return Math.max(min, readyAt);
  return now >= INTRO.holdMax ? now : null;
}
