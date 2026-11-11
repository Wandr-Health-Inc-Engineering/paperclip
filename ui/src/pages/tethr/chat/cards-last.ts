import { useCallback, useRef, useState } from "react";

/**
 * Cards come last (Mark, 2026-11-10: the approval card popped out "before all the text is
 * done"). A card is made mid-turn, while the answer is still writing itself out, so a turn's
 * cards wait until the turn is done and its text is all on screen (`onTextShown`, from
 * StreamingMarkdown's `onShown`). A turn already done when it appeared shows its cards at once;
 * one you watched has them rise in (`riseIn`).
 */
export function useCardsLast(running: boolean, hasText: boolean) {
  const [textShown, setTextShown] = useState(!running);
  const onTextShown = useCallback(() => setTextShown(true), []);
  const watched = useRef(running);
  return { cardsShown: !running && (textShown || !hasText), onTextShown, riseIn: watched.current };
}
