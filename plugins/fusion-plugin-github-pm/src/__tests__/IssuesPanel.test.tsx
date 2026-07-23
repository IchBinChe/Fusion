import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IssuesPanel } from "../IssuesPanel.js";
import { notifyIssuesChanged } from "../issues-events.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function baseListPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    repo: "acme/widgets",
    mode: "list",
    items: [
      { number: 1, title: "First issue", state: "open", htmlUrl: "https://github.com/acme/widgets/issues/1", labels: [{ name: "bug", color: "ff0000" }], assignees: [{ login: "octocat" }], commentsCount: 2, updatedAt: new Date().toISOString() },
    ],
    page: 1,
    hasNextPage: false,
    ...overrides,
  };
}

function mockFetch(handlers: { list?: (url: URL) => unknown; filterOptions?: unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
    if (url.pathname.endsWith("/issues/filter-options")) {
      return jsonResponse(handlers.filterOptions ?? { ok: true, labels: [], milestones: [] });
    }
    if (url.pathname.endsWith("/issues/list")) {
      return jsonResponse(handlers.list ? handlers.list(url) : baseListPayload());
    }
    return jsonResponse({ ok: false, error: "unexpected route" }, 404);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("IssuesPanel (FUSI-012)", () => {
  it("renders a 'select a repository' affordance and fires no fetch when repo is null", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo={null} />);
    expect(screen.getByTestId("issues-panel-no-repo")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders rows from a mocked list payload", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());
    expect(screen.getByText("First issue")).toBeInTheDocument();
  });

  it("changing state filter re-fetches with the expected query param and resets to page 1", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());

    fetchImpl.mockClear();
    fireEvent.change(screen.getByDisplayValue("Open"), { target: { value: "closed" } });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/issues/list"));
    const url = new URL(String(call?.[0]), "http://localhost");
    expect(url.searchParams.get("state")).toBe("closed");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("a non-empty search debounces then hits the search-mode payload and surfaces totalCount/cap notice", async () => {
    const fetchImpl = mockFetch({
      list: (url) => (url.searchParams.get("search")
        ? { ok: true, repo: "acme/widgets", mode: "search", items: [], page: 1, hasNextPage: false, totalCount: 1500, cappedAtLimit: true }
        : baseListPayload()),
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("issues-panel-search-input"), { target: { value: "crash" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    await waitFor(() => expect(screen.getByTestId("issues-panel-capped-notice")).toBeInTheDocument());
  });

  it("pagination next fetches only the requested page and does not accumulate rows in the DOM", async () => {
    const fetchImpl = mockFetch({
      list: (url) => {
        const page = url.searchParams.get("page");
        if (page === "2") {
          return { ok: true, repo: "acme/widgets", mode: "list", items: [{ number: 2, title: "Second page issue", state: "open", htmlUrl: "https://x", labels: [], assignees: [], commentsCount: 0 }], page: 2, hasNextPage: false };
        }
        return { ...baseListPayload(), hasNextPage: true };
      },
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());
    expect(screen.getByTestId("issues-panel-next")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("issues-panel-next"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(screen.getByTestId("issue-row-2")).toBeInTheDocument());
    expect(screen.queryByTestId("issue-row-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("issues-panel-next")).toBeDisabled();
  });

  it("renders empty ('no issues match') state distinctly from loading", async () => {
    vi.stubGlobal("fetch", mockFetch({ list: () => ({ ok: true, repo: "acme/widgets", mode: "list", items: [], page: 1, hasNextPage: false }) }));
    render(<IssuesPanel repo="acme/widgets" />);
    expect(screen.getByTestId("issues-panel-loading")).toBeInTheDocument();
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issues-panel-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("issues-panel-loading")).not.toBeInTheDocument();
  });

  it("renders an error state using the (already-redacted) backend message, verbatim, without adding token text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "GitHub PM is not authenticated. Configure gh CLI, GITHUB_TOKEN, or a plugin PAT." }, 401)));
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issues-panel-error")).toBeInTheDocument());
    expect(screen.getByTestId("issues-panel-error").textContent).not.toMatch(/ghp_|gho_|github_pat_/);
  });

  it("clicking a row calls onSelectIssue when provided", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const onSelectIssue = vi.fn();
    render(<IssuesPanel repo="acme/widgets" onSelectIssue={onSelectIssue} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());

    fireEvent.click(screen.getByText("First issue"));
    expect(onSelectIssue).toHaveBeenCalledWith(1);
  });

  it("notifyIssuesChanged for the current repo triggers a current-page re-fetch without remount", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());

    const callsBefore = fetchImpl.mock.calls.length;
    act(() => {
      notifyIssuesChanged({ repo: "acme/widgets", issueNumber: 1, kind: "closed" });
    });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("notifyIssuesChanged for a different repo does not trigger a re-fetch", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());

    const callsBefore = fetchImpl.mock.calls.length;
    act(() => {
      notifyIssuesChanged({ repo: "other/repo", kind: "closed" });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });

    expect(fetchImpl.mock.calls.length).toBe(callsBefore);
  });

  it("never renders a PAT/token value even if it leaked into a response", async () => {
    vi.stubGlobal("fetch", mockFetch({ list: () => ({ ...baseListPayload(), personalAccessToken: "ghp_should_never_render" }) }));
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());
    expect(screen.queryByText(/ghp_should_never_render/)).not.toBeInTheDocument();
  });

  it("zero labels/milestones render dropdowns with only the default Any option", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<IssuesPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("issue-row-1")).toBeInTheDocument());
    const milestoneSelect = screen.getByTestId("issues-panel-milestone-select") as HTMLSelectElement;
    expect(milestoneSelect.options.length).toBe(1);
    expect(milestoneSelect.options[0].textContent).toBe("Any");
    expect(screen.queryByTestId("issues-panel-label-filters")).not.toBeInTheDocument();
  });
});
