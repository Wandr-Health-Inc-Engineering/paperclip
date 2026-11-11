import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TETHR_STARTER_COMPANY_NAME } from "@paperclipai/shared";
import { useLocation } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";
import {
  INTRO,
  INTRO_EVENT,
  exitAt,
  introReady,
  introReason,
  isPublicPath,
  markIntroPlayed,
  sessionStorageOrNull,
  terminalFrame,
  type IntroReason,
} from "@/lib/tethr-intro";
import { Nebula } from "./Nebula";
import { StatusDot } from "./primitives";

// The startup intro: plays when the desktop app starts and right after signing
// in (rules in lib/tethr-intro.ts). tethr's nebula swirls in out of a blur, its
// core flares once, the wordmark rises under it, and a black terminal types
// itself (`tethr connect`, three status lines, then "connecting" until the app
// is really up, then "ready"). Then the app comes up from underneath. Click or
// press any key to skip. Reduced motion gets a short, still card instead.

/** Lines the terminal can show (the command, three statuses, the last word). */
const TERMINAL_LINES = 5;

/** While this class is on <html>, the shell's own entrance animations wait, so
 * they play as the intro leaves instead of unseen underneath it. */
const HOLD_CLASS = "tethr-intro-hold";
/** The app's main column (core Layout): once it renders, the app is up. */
const READY_SELECTOR = "#main-content";

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
      session: sessionStorageOrNull(),
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
        session: sessionStorageOrNull(),
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
  return <IntroOverlay key={play.id} reason={play.reason} onDone={done} />;
}

function IntroOverlay({ reason, onDone }: { reason: IntroReason; onDone: () => void }) {
  const reduced = useMemo(prefersReducedMotion, []);
  const { loading, selectedCompany, companies } = useCompany();
  const location = useLocation();

  const [leaving, setLeaving] = useState(false);
  const [ready, setReady] = useState(false);
  const liveState = useRef({ companyLoading: loading, publicPage: false, leaving: false, readyAt: null as number | null });
  liveState.current.companyLoading = loading;
  liveState.current.publicPage = isPublicPath(location.pathname);
  // Before setup, the company still has its placeholder name: say tethr instead.
  const named = selectedCompany?.name ?? companies[0]?.name;
  const isNamed = !!named && named !== TETHR_STARTER_COMPANY_NAME;
  const company = isNamed ? named! : APP_NAME;
  // The terminal's workspace line: the company, or a new one that setup comes next for.
  const workspace = useRef({ name: "", status: "ok" });
  workspace.current = isNamed ? { name: named!.slice(0, 16), status: "ok" } : { name: loading ? "..." : "new", status: loading ? "..." : "set up next" };

  const leave = useRef<() => void>(() => {});
  const termLines = useRef<Array<HTMLDivElement | null>>([]);

  useLayoutEffect(() => {
    markIntroPlayed();
    const root = document.documentElement;
    root.classList.add(HOLD_CLASS);
    return () => root.classList.remove(HOLD_CLASS);
  }, []);

  useEffect(() => {
    const state = liveState.current;
    // The clock starts on the first painted frame, the same moment the CSS
    // animation starts, so "ready" and leaving stay in step with what's on
    // screen even when the first frame is late (a busy load, a background window).
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
      introReady({
        reason,
        t,
        hasMainColumn: document.querySelector(READY_SELECTOR) !== null,
        onPublicPage: state.publicPage,
        companyLoading: state.companyLoading,
      });

    const step = (now: number) => {
      if (start === null) start = now;
      const t = now - start;
      if (!reduced) {
        writeTerminal(
          termLines.current,
          terminalFrame(t, { host: window.location.host, workspace: workspace.current.name, workspaceStatus: workspace.current.status, readyAt: state.readyAt }),
        );
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
  }, [onDone, reduced, reason]);

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
        <div className="tethr-intro-nebula">
          <Nebula />
          <span className="tethr-intro-flare" />
        </div>
        <div className="tethr-intro-word">
          {Array.from(APP_NAME).map((letter, i) => (
            <span key={i} style={{ "--i": i } as CSSProperties}>
              {letter}
            </span>
          ))}
        </div>
        <div className="tethr-intro-term">
          <div className="tethr-intro-term-bar">
            <StatusDot tone={ready ? "ok" : "live"} />
            <span>
              {APP_NAME} · {window.location.host}
            </span>
          </div>
          <div className="tethr-intro-term-body">
            {Array.from({ length: TERMINAL_LINES }, (_, i) => (
              <div
                key={i}
                ref={(el) => {
                  termLines.current[i] = el;
                }}
                className="tethr-intro-term-line"
              >
                {reduced ? reducedTerminal(company)[i] : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The terminal's lines, written straight to the page each frame (no React
 * render per frame). The active line carries the blinking cursor. */
function writeTerminal(lines: Array<HTMLDivElement | null>, frame: ReturnType<typeof terminalFrame>) {
  lines.forEach((el, i) => {
    if (!el) return;
    const text = frame.lines[i] ?? "";
    if (el.dataset.text !== text) {
      el.dataset.text = text;
      el.textContent = text;
    }
    el.classList.toggle("is-active", i === frame.active);
  });
}

/** Reduced motion: the finished terminal, shown still. */
function reducedTerminal(company: string): string[] {
  return ["$ tethr connect", `workspace  ${company.slice(0, 16)}`, "ready."];
}
