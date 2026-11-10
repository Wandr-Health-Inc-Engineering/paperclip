// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TethrQuestion } from "@/api/tethr";

vi.mock("../../../lib/router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));

const { QuestionCard } = await import("./decision-cards");

const card = (over: Partial<TethrQuestion>): TethrQuestion => ({
  id: "q1",
  threadId: "t1",
  runId: null,
  agentTag: "@paid-ads",
  question: "@paid-ads needs Google Ads",
  detail: "Creating the campaign needs write access.",
  options: null,
  connection: { key: "Google Ads" },
  status: "open",
  answer: null,
  askedAt: "2026-11-10T20:00:00.000Z",
  ...over,
});

describe("a connection card", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });
  const render = (q: TethrQuestion) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <QuestionCard question={q} companyId="c1" />
        </QueryClientProvider>,
      ),
    );
    return host.textContent ?? "";
  };

  // Mark, 2026-11-10: the keys were all set, yet the card asked for them again. The
  // connection worked; the agent just wasn't given it.
  it("asks for access, not keys, when the connection works but the agent isn't given it", () => {
    const text = render(card({ access: true }));
    expect(text).toContain("Give @paid-ads Google Ads?");
    expect(text).toContain("Give access, on its own");
    expect(text).toContain("Give access, ask each time");
    expect(text).not.toContain("I've connected it");
  });

  it("offers the fix when it really isn't connected", () => {
    const text = render(card({ access: false }));
    expect(text).toContain("Connect Google Ads");
    expect(text).toContain("I've connected it");
  });
});
