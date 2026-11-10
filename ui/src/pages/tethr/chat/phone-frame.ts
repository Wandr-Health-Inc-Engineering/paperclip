import { useEffect, useState } from "react";

// The chat on a phone. Core's phone layout scrolls the whole page and slides the top
// bar and tabs away on scroll, so the iPhone keyboard (which scrolls the page to show
// the text box) left the composer floating mid-screen with both bars gone. On phones
// the chat is a fixed frame instead: between the top bar and the tabs, or, while the
// keyboard is up, the whole visible area above it. Only the messages scroll.

export interface PhoneFrame {
  top: number;
  height: number;
}

export interface PhoneViewport {
  /** The layout viewport (window.innerHeight). */
  innerHeight: number;
  /** The visible area (visualViewport), which shrinks and pans while the keyboard is up. */
  viewportTop: number;
  viewportHeight: number;
  /** Where the chat starts when nothing is covering the page (under the top bar). */
  anchorTop: number;
  /** The tabs' top edge, or null when there are none. */
  navTop: number | null;
}

/** More than this much of the screen hidden means the keyboard is up. */
const KEYBOARD_MIN_PX = 120;
const MIN_FRAME_PX = 240;

export function phoneFrame(v: PhoneViewport): PhoneFrame {
  if (v.innerHeight - v.viewportHeight > KEYBOARD_MIN_PX) {
    return { top: Math.round(v.viewportTop), height: Math.round(v.viewportHeight) };
  }
  const top = Math.max(0, v.anchorTop);
  const bottom = Math.min(v.navTop ?? Infinity, v.viewportTop + v.viewportHeight);
  return { top: Math.round(top), height: Math.round(Math.max(MIN_FRAME_PX, bottom - top)) };
}

const NAV_SELECTOR = 'nav[aria-label="Mobile navigation"]';

/**
 * The chat's frame on a phone, or null on a wider screen (the chat then sits in the page).
 * `anchor` is an empty element where the chat would start in the page; it's state, not a
 * ref, because the chat's loading view renders without it and the frame must be measured
 * again once it appears.
 */
export function usePhoneFrame(enabled: boolean, anchor: HTMLElement | null): PhoneFrame | null {
  const [frame, setFrame] = useState<PhoneFrame | null>(null);

  useEffect(() => {
    if (!enabled || !anchor) {
      setFrame(null);
      return;
    }
    const vv = window.visualViewport;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const nav = document.querySelector<HTMLElement>(NAV_SELECTOR);
      const next = phoneFrame({
        innerHeight: window.innerHeight,
        viewportTop: vv?.offsetTop ?? 0,
        viewportHeight: vv?.height ?? window.innerHeight,
        anchorTop: anchor.getBoundingClientRect().top,
        navTop: nav ? nav.getBoundingClientRect().top : null,
      });
      setFrame((prev) => (prev && prev.top === next.top && prev.height === next.height ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    // The tabs slide in and out with a transition; measure again once it ends.
    document.addEventListener("transitionend", schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("transitionend", schedule);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
    };
  }, [enabled, anchor]);

  return enabled ? frame : null;
}
