// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";

const mockIssuesApiGet = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: mockIssuesApiGet,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Quicklook title",
    description: "Quicklook description",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    workMode: "standard",
    ...overrides,
  };
}

describe("IssueLinkQuicklook", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    mockIssuesApiGet.mockResolvedValue(createIssue());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("opens the quicklook on the first click and suppresses navigation", () => {
    const issue = createIssue();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <IssueLinkQuicklook
              issuePathId="PAP-1"
              issuePrefetch={issue}
              to="/companies/company-1/issues/PAP-1"
            >
              PAP-1
            </IssueLinkQuicklook>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const trigger = container.querySelector("a") as HTMLAnchorElement | null;
    expect(trigger).not.toBeNull();

    // Hover should NOT open the popover anymore.
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain("Quicklook title");

    // First click opens the popover and suppresses the link navigation.
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      trigger?.dispatchEvent(clickEvent);
    });
    expect(clickEvent.defaultPrevented).toBe(true);
    expect(document.body.textContent).toContain("Quicklook title");

    // Click again closes it.
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(document.body.textContent).not.toContain("Quicklook title");
  });
});
