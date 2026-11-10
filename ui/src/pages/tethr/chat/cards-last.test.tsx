// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { StreamingMarkdown } from "@/components/tethr/StreamingMarkdown";
import { useCardsLast } from "./cards-last";

vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));

/** A chat turn reduced to what matters here: its answer, then its card. */
function Turn({ running, text }: { running: boolean; text: string }) {
  const { cardsShown, onTextShown, riseIn } = useCardsLast(running, !!text);
  return (
    <div>
      {text ? <StreamingMarkdown text={text} live={running} onShown={onTextShown} /> : null}
      {cardsShown ? <p data-card={riseIn ? "rises" : "still"}>Approve this</p> : null}
    </div>
  );
}

const FIRST = "Here is the plan.";
const WHOLE = `${FIRST} ${"It covers the spring push, the budget and who does what. ".repeat(6)}The card below sets it up.`;

describe("a turn's cards come last", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });
  const render = (props: { running: boolean; text: string }) =>
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <ThemeProvider>
            <Turn {...props} />
          </ThemeProvider>
        </QueryClientProvider>,
      ),
    );
  const mount = (props: { running: boolean; text: string }) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    render(props);
  };
  const card = () => host.querySelector("[data-card]");

  it("shows a finished turn's card at once, without the rise", () => {
    mount({ running: false, text: WHOLE });
    expect(card()?.getAttribute("data-card")).toBe("still");
  });

  // Mark, 2026-11-10: "I get the card… before all the text is done when it should be the last thing that pops out".
  it("holds the card while the turn runs and until its text is all on screen, then it rises in", async () => {
    mount({ running: true, text: FIRST });
    expect(card()).toBeNull();
    render({ running: false, text: WHOLE });
    expect(card()).toBeNull();
    for (let i = 0; i < 60 && !card(); i++) await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(host.textContent).toContain("The card below sets it up.");
    expect(card()?.getAttribute("data-card")).toBe("rises");
  });

  it("shows the card once the turn is done when there's no text", () => {
    mount({ running: true, text: "" });
    expect(card()).toBeNull();
    render({ running: false, text: "" });
    expect(card()).not.toBeNull();
  });
});
