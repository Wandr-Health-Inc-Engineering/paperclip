// When Enter sends from a chat box. On a computer Enter sends and Shift+Enter
// makes a new line. On a touch screen with no mouse or trackpad (a phone), Enter
// makes a new line and the send button sends (Mark, 2026-11-10: "if I hit enter
// or return on my phone it submits instead of new line"). Never mid-composition
// (an IME is still building the word).

interface EnterKey {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing?: boolean };
}

/** A touch screen with no fine pointer attached (a phone, or a tablet without a trackpad). */
export function isTouchOnly(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}

export function enterSends(e: EnterKey, touchOnly = isTouchOnly()): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchOnly;
}
