// @vitest-environment jsdom
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TethrChatRun, TethrStudy } from "@/api/tethr";

vi.mock("../../../lib/router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));
vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children, useNavigate: () => vi.fn() }));
const undoStudySkill = vi.fn(async () => ({ skill: {} }));
const stopStudy = vi.fn(async () => ({ study: null }));
vi.mock("@/api/tethr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tethr")>();
  return { ...actual, tethrApi: { ...actual.tethrApi, undoStudySkill, stopStudy } };
});

const { StudyCard } = await import("./study-card");

const study = (over: Partial<TethrStudy>): TethrStudy => ({
  id: "s1",
  trigger: "asked",
  by: "you",
  asked: "small-budget search",
  status: "done",
  depth: "deep",
  topic: "Running Google Search on a small budget",
  why: "People keep asking.",
  area: "paid_ads",
  questions: ["How should a small budget be structured?"],
  baseline: null,
  findings: [{ claim: "One tight ad group beats several.", detail: "d", evidence: "case_study", strength: "moderate", sources: [{ url: "https://example.com/g", title: "Guide" }], appliesWhen: null, counterpoint: null }],
  researchSummary: null,
  verdicts: [{ finding: 1, verdict: "new", note: "We had nothing on this." }],
  summary: "Learned how to run a first search test on a small budget.",
  skills: [{ name: "small-budget-search", description: "d", area: "paid_ads", change: "new", whatChanged: "How to run the first test.", body: "", status: "applied", at: "" }],
  reason: null,
  cardRunId: "r1",
  mainCardRunId: null,
  startedAt: "2026-11-10T20:00:00.000Z",
  finishedAt: null,
  ...over,
});

const run = (s: TethrStudy): TethrChatRun =>
  ({ id: "r1", threadId: "t1", sourceKey: "tethr-study-card", requestText: "Learn: x", resultText: "", status: s.status === "done" ? "done" : "running", createdAt: "2026-11-10T20:00:00.000Z", outputs: [], hops: [], study: s }) as unknown as TethrChatRun;

describe("a study card", () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  });
  const render = (s: TethrStudy, inMainChat = false) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient()}>
          <StudyCard run={run(s)} companyId="c1" inMainChat={inMainChat} />
        </QueryClientProvider>,
      ),
    );
    return host.textContent ?? "";
  };
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

  it("shows a running study's step and lets a person stop it", async () => {
    const text = render(study({ status: "researching", summary: null, skills: [] }));
    expect(text).toContain("Researching 1 question on the web, in depth.");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe("Researching");
    await act(async () => button("Stop")!.click());
    expect(stopStudy).toHaveBeenCalledWith("c1", "s1");
  });

  it("ends with what it learned and an Undo per saved skill, and opens what it found", async () => {
    const text = render(study({}), true);
    expect(text).toContain("Sage learned");
    expect(text).toContain("Learned how to run a first search test");
    expect(text).toContain("small-budget-search");
    expect(text).not.toContain(".md");
    await act(async () => button("What it found")!.click());
    expect(host.textContent).toContain("One tight ad group beats several.");
    expect(host.textContent).toContain("New to tethr: We had nothing on this.");
    await act(async () => button("Undo")!.click());
    expect(undoStudySkill).toHaveBeenCalledWith("c1", "s1", "small-budget-search");
  });
});
