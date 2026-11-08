import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";
import {
  INTRO,
  INTRO_EVENT,
  exitAt,
  introReason,
  isPublicPath,
  markIntroPlayed,
  tetherFrame,
  tetherPath,
  type IntroReason,
  type TetherFrame,
} from "@/lib/tethr-intro";
import { StatusDot } from "./primitives";

// The startup intro: plays when the desktop app starts and right after signing
// in (rules in lib/tethr-intro.ts). A line is thrown between two nodes and
// pulls taut, the wordmark rises above it, and the app comes up from
// underneath. Click or press any key to skip. Reduced motion gets a short,
// still card instead.

/** While this class is on <html>, the shell's own entrance animations wait, so
 * they play as the intro leaves instead of unseen underneath it. */
const HOLD_CLASS = "tethr-intro-hold";
/** The app counts as ready once its main column has rendered. */
const READY_SELECTOR = "#main-content";
/** A screen without the main column (onboarding, an error) counts after this. */
const READY_FALLBACK_MS = 3500;
/** After the line catches, the drawing has settled by then: stop redrawing. */
const SETTLED_MS = INTRO.pullTo + 1000;

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function TethrStartupIntro() {
  const location = useLocation();
  const where = useRef(location);
  where.current = location;

  const [play, setPlay] = useState<{ reason: IntroReason; id: number } | null>(() => {
    const reason = introReason({
      pathname: location.pathname,
      search: location.search,
      userAgent: navigator.userAgent,
      session: sessionStore(),
      initial: true,
    });
    return reason ? { reason, id: 1 } : null;
  });

  // Later chances to play: the sign-in page asked for it, or the first screen
  // was a public page (an invite) and the app opened after it.
  const evaluate = useCallback(() => {
    setPlay((current) => {
      if (current) return current;
      const reason = introReason({
        pathname: where.current.pathname,
        search: where.current.search,
        userAgent: navigator.userAgent,
        session: sessionStore(),
        initial: false,
      });
      return reason ? { reason, id: Date.now() } : null;
    });
  }, []);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    evaluate();
  }, [location.pathname, evaluate]);

  useEffect(() => {
    window.addEventListener(INTRO_EVENT, evaluate);
    return () => window.removeEventListener(INTRO_EVENT, evaluate);
  }, [evaluate]);

  const done = useCallback(() => setPlay(null), []);
  if (!play) return null;
  return <IntroOverlay key={play.id} onDone={done} />;
}

const FINAL_FRAME = tetherFrame(SETTLED_MS);

function IntroOverlay({ onDone }: { onDone: () => void }) {
  const reduced = useMemo(prefersReducedMotion, []);
  const { loading, selectedCompany, companies } = useCompany();
  const location = useLocation();
  const glowId = useId().replace(/:/g, "");

  const [leaving, setLeaving] = useState(false);
  const [ready, setReady] = useState(false);
  const live = useRef({ companyLoading: loading, publicPage: false, leaving: false, readyAt: null as number | null });
  live.current.companyLoading = loading;
  live.current.publicPage = isPublicPath(location.pathname);

  const line = useRef<SVGPathElement>(null);
  const glint = useRef<SVGPathElement>(null);
  const nodeLeft = useRef<SVGCircleElement>(null);
  const nodeRight = useRef<SVGCircleElement>(null);
  const ringLeft = useRef<SVGCircleElement>(null);
  const ringRight = useRef<SVGCircleElement>(null);
  const leave = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    markIntroPlayed();
    const root = document.documentElement;
    root.classList.add(HOLD_CLASS);
    return () => root.classList.remove(HOLD_CLASS);
  }, []);

  useEffect(() => {
    const state = live.current;
    // The clock starts on the first painted frame, the same moment the CSS
    // parts (the wordmark, the status line) start, so the two stay in step
    // even when the first frame is late (a busy load, a background window).
    let start: number | null = null;
    let raf = 0;
    let exitTimer: number | undefined;

    leave.current = () => {
      if (state.leaving) return;
      state.leaving = true;
      document.documentElement.classList.remove(HOLD_CLASS);
      setLeaving(true);
      exitTimer = window.setTimeout(onDone, reduced ? INTRO.reducedExit : INTRO.exit);
    };

    const isReady = (t: number) =>
      document.querySelector(READY_SELECTOR) !== null ||
      (t >= READY_FALLBACK_MS && !state.companyLoading && !state.publicPage);

    const step = (now: number) => {
      if (start === null) start = now;
      const t = now - start;
      if (!reduced && t <= SETTLED_MS + 50) {
        draw(tetherFrame(t), { line, glint, nodeLeft, nodeRight, ringLeft, ringRight });
      }
      if (state.readyAt === null && isReady(t)) {
        state.readyAt = t;
        setReady(true);
      }
      const at = exitAt(state.readyAt, t, reduced);
      if (at !== null && t >= at) leave.current();
      if (!state.leaving) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const skip = () => leave.current();
    window.addEventListener("keydown", skip);
    return () => {
      cancelAnimationFrame(raf);
      if (exitTimer !== undefined) window.clearTimeout(exitTimer);
      window.removeEventListener("keydown", skip);
      // A remount (React strict mode) starts the timeline over.
      state.leaving = false;
      state.readyAt = null;
    };
  }, [onDone, reduced]);

  const company = selectedCompany?.name ?? companies[0]?.name ?? APP_NAME;
  const initial = reduced ? FINAL_FRAME : tetherFrame(0);

  return (
    <div
      className={cn("tethr-intro", leaving && "is-leaving", reduced && "is-reduced")}
      onPointerDown={() => leave.current()}
    >
      <span className="sr-only" role="status">
        {ready ? `${APP_NAME} is ready` : `Starting ${APP_NAME}`}
      </span>
      <div className="tethr-intro-ground" aria-hidden="true">
        <div className="tethr-intro-reeds-wrap">
          <div className="tethr-intro-reeds" />
        </div>
      </div>
      <div className="tethr-intro-stage" aria-hidden="true">
        <div className="tethr-intro-word">
          {Array.from(APP_NAME).map((letter, i) => (
            <span key={i} style={{ "--i": i } as CSSProperties}>
              {letter}
            </span>
          ))}
        </div>
        <svg
          className="tethr-intro-tether"
          viewBox={`0 0 ${INTRO.width} ${INTRO.height}`}
          fill="none"
          aria-hidden="true"
        >
          <defs>
            <filter id={glowId} x="-20%" y="-200%" width="140%" height="500%">
              <feGaussianBlur stdDeviation="2.4" />
            </filter>
          </defs>
          <path
            ref={glint}
            className="tethr-intro-glint"
            pathLength={1}
            filter={`url(#${glowId})`}
            d={tetherPath(initial)}
            style={{ opacity: 0 }}
          />
          <path
            ref={line}
            className="tethr-intro-line"
            pathLength={1}
            d={tetherPath(initial)}
            style={reduced ? undefined : { visibility: "hidden" }}
          />
          <circle ref={ringLeft} className="tethr-intro-ring" cx={initial.xLeft} cy={INTRO.y} r={3} style={{ opacity: 0 }} />
          <circle ref={ringRight} className="tethr-intro-ring" cx={initial.xRight} cy={INTRO.y} r={3} style={{ opacity: 0 }} />
          <circle ref={nodeLeft} className="tethr-intro-node" cx={initial.xLeft} cy={INTRO.y} r={reduced ? 3 : 0} />
          <circle ref={nodeRight} className="tethr-intro-node" cx={initial.xRight} cy={INTRO.y} r={reduced ? 3 : 0} />
        </svg>
        <div className="tethr-intro-status tethr-eyebrow">
          <StatusDot tone={ready ? "ok" : "live"} />
          <span>{ready ? `${company} · ready` : "connecting"}</span>
        </div>
      </div>
    </div>
  );
}

type Refs = {
  line: React.RefObject<SVGPathElement | null>;
  glint: React.RefObject<SVGPathElement | null>;
  nodeLeft: React.RefObject<SVGCircleElement | null>;
  nodeRight: React.RefObject<SVGCircleElement | null>;
  ringLeft: React.RefObject<SVGCircleElement | null>;
  ringRight: React.RefObject<SVGCircleElement | null>;
};

/** Paint one frame straight onto the SVG (no React render per frame). */
function draw(f: TetherFrame, r: Refs) {
  const d = tetherPath(f);
  const line = r.line.current;
  if (line) {
    line.setAttribute("d", d);
    line.style.visibility = f.drawn > 0 ? "visible" : "hidden";
    line.style.strokeDasharray = f.drawn >= 1 ? "none" : `${f.drawn} 1`;
  }
  const glint = r.glint.current;
  if (glint) {
    glint.setAttribute("d", d);
    glint.style.opacity = f.glint ? String(f.glint.opacity) : "0";
    if (f.glint) glint.style.strokeDashoffset = String(-f.glint.at);
  }
  const nodes: Array<[SVGCircleElement | null, number, TetherFrame["nodeLeft"]]> = [
    [r.nodeLeft.current, f.xLeft, f.nodeLeft],
    [r.nodeRight.current, f.xRight, f.nodeRight],
  ];
  for (const [el, x, n] of nodes) {
    if (!el) continue;
    el.setAttribute("cx", String(x));
    el.setAttribute("r", String(Math.max(0, 3 * n.scale)));
    el.style.opacity = String(n.opacity);
  }
  const rings: Array<[SVGCircleElement | null, number]> = [
    [r.ringLeft.current, f.xLeft],
    [r.ringRight.current, f.xRight],
  ];
  for (const [el, x] of rings) {
    if (!el) continue;
    el.setAttribute("cx", String(x));
    el.setAttribute("r", String(f.pulse?.radius ?? 3));
    el.style.opacity = String(f.pulse?.opacity ?? 0);
  }
}
