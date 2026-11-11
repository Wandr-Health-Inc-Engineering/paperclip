// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TethrChatOutput, TethrQuestion } from "@/api/tethr";

vi.mock("../../../lib/router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));
const answerQuestion = vi.fn(async () => ({ question: {}, routeRunId: null, threadId: "t1" }));
const sendChatMessage = vi.fn(async () => ({ routeRunId: "r2", threadId: "t1" }));
vi.mock("@/api/tethr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tethr")>();
  return { ...actual, tethrApi: { ...actual.tethrApi, answerQuestion, sendChatMessage } };
});

const { ApprovalCard, QuestionCard } = await import("./decision-cards");

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

  // Mark, 2026-11-10: "it didn't animate or change on approval… animate it into a nice check".
  it("turns into a drawn check with what happened as soon as it's answered", async () => {
    render(card({ access: true }));
    const give = [...host.querySelectorAll("button")].find((b) => b.textContent === "Give access, on its own")!;
    await act(async () => give.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(answerQuestion).toHaveBeenCalledWith("c1", "q1", { choice: "grant_auto" });
    expect(host.querySelector(".tethr-done-check")).not.toBeNull();
    expect(host.textContent).toContain("@paid-ads has Google Ads now, and changes run on their own.");
    expect(host.textContent).not.toContain("Give access, ask each time");
  });

  it("offers the fix when it really isn't connected", () => {
    const text = render(card({ access: false }));
    expect(text).toContain("Connect Google Ads");
    expect(text).toContain("I've connected it");
  });
});

describe("an approval card's comment", () => {
  // Mark, 2026-11-10: "Commenting doesn't change like pressing approve or reject… It does work to comment but not clear".
  it("draws a check and says it went to tethr, and the card stays open for the decision", async () => {
    const output: TethrChatOutput = { id: "o1", title: "Send the partner email", status: "gated", sensitivity: "public", kind: "document", body: "Hello partners.", meta: {}, createdAt: "" };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ApprovalCard output={output} companyId="c1" threadId="t1" />
        </QueryClientProvider>,
      ),
    );
    const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
    await act(async () => button("Comment").click());
    const box = host.querySelector("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "Why this list?");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(sendChatMessage).toHaveBeenCalledWith("c1", "t1", 'About your request "Send the partner email": Why this list?');
    expect(host.querySelector(".tethr-done-check")).not.toBeNull();
    expect(host.textContent).toContain("Sent to tethr.");
    expect(button("Approve")).toBeTruthy();
    act(() => root.unmount());
    host.remove();
  });
});
