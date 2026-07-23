import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiscussionsPanel } from "../DiscussionsPanel.js";
import { GitHubPmView } from "../GitHubPmView.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const CATEGORIES = [
  { id: "C1", name: "Q&A", slug: "q-a", emoji: "\u2753", emojiHTML: "<div/>", isAnswerable: true, description: "Ask questions" },
  { id: "C2", name: "Ideas", slug: "ideas", emoji: "\ud83d\udca1", emojiHTML: "<div/>", isAnswerable: false },
];

function discussionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 1,
    title: "How do I configure X?",
    url: "https://github.com/acme/widgets/discussions/1",
    categoryName: "Q&A",
    categoryEmoji: "\u2753",
    upvoteCount: 3,
    commentCount: 5,
    isAnswered: false,
    authorLogin: "octocat",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockFetch(handlers: { categories?: unknown; list?: (url: URL) => unknown }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
    if (url.pathname.endsWith("/discussions/categories")) {
      return jsonResponse(handlers.categories ?? { ok: true, repo: "acme/widgets", categories: CATEGORIES });
    }
    if (url.pathname.endsWith("/discussions/list")) {
      return jsonResponse(handlers.list ? handlers.list(url) : { ok: true, repo: "acme/widgets", items: [discussionRow()], query: "repo:acme/widgets sort:updated" });
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

describe("DiscussionsPanel (KB-005)", () => {
  it("renders a 'select a repository' affordance and fires no fetch when repo is null", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionsPanel repo={null} />);
    expect(screen.getByTestId("discussions-panel-no-repo")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders every category with its emoji + exact name", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-q-a")).toBeInTheDocument());
    expect(screen.getByTestId("discussions-panel-category-q-a")).toHaveTextContent("\u2753");
    expect(screen.getByTestId("discussions-panel-category-q-a")).toHaveTextContent("Q&A");
    expect(screen.getByTestId("discussions-panel-category-ideas")).toHaveTextContent("Ideas");
    expect(screen.getByTestId("discussions-panel-category-all")).toBeInTheDocument();
  });

  it("renders zero-category empty state while keeping the rail's 'All categories' entry", async () => {
    vi.stubGlobal("fetch", mockFetch({ categories: { ok: true, repo: "acme/widgets", categories: [] }, list: () => ({ ok: true, repo: "acme/widgets", items: [], query: "repo:acme/widgets sort:updated" }) }));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-categories-empty")).toBeInTheDocument());
    expect(screen.getByTestId("discussions-panel-category-all")).toBeInTheDocument();
  });

  it("renders rows from a mocked list payload", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussion-row-1")).toBeInTheDocument());
    expect(screen.getByText("How do I configure X?")).toBeInTheDocument();
  });

  it("selecting a category re-fetches the list with the correct category param", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-q-a")).toBeInTheDocument());

    fetchImpl.mockClear();
    fireEvent.click(screen.getByTestId("discussions-panel-category-q-a"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/discussions/list"));
    const url = new URL(String(call?.[0]), "http://localhost");
    expect(url.searchParams.get("category")).toBe("Q&A");
  });

  it("the search box (after debounce) re-fetches with the search param", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussion-row-1")).toBeInTheDocument());

    fetchImpl.mockClear();
    fireEvent.change(screen.getByTestId("discussions-panel-search-input"), { target: { value: "dark mode" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/discussions/list"));
    const url = new URL(String(call?.[0]), "http://localhost");
    expect(url.searchParams.get("search")).toBe("dark mode");
  });

  it("the sort control toggles between activity and newest", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussion-row-1")).toBeInTheDocument());

    fetchImpl.mockClear();
    fireEvent.change(screen.getByTestId("discussions-panel-sort-select"), { target: { value: "newest" } });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/discussions/list"));
    const url = new URL(String(call?.[0]), "http://localhost");
    expect(url.searchParams.get("sort")).toBe("newest");
  });

  it("the answered/unanswered filter renders for an answerable (Q&A) category and re-fetches with the answered param", async () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-q-a")).toBeInTheDocument());

    expect(screen.queryByTestId("discussions-panel-answered-select")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("discussions-panel-category-q-a"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-answered-select")).toBeInTheDocument());

    fetchImpl.mockClear();
    fireEvent.change(screen.getByTestId("discussions-panel-answered-select"), { target: { value: "unanswered" } });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const call = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/discussions/list"));
    const url = new URL(String(call?.[0]), "http://localhost");
    expect(url.searchParams.get("answered")).toBe("unanswered");
  });

  it("the answered/unanswered filter is ABSENT for a non-answerable category", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-ideas")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("discussions-panel-category-ideas"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-ideas")).toHaveClass("discussions-panel__category-button--active"));
    expect(screen.queryByTestId("discussions-panel-answered-select")).not.toBeInTheDocument();
  });

  it("the answered/unanswered filter is ABSENT for 'All categories'", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-category-all")).toBeInTheDocument());
    expect(screen.queryByTestId("discussions-panel-answered-select")).not.toBeInTheDocument();
  });

  it("a zero-result list shows the empty state", async () => {
    vi.stubGlobal("fetch", mockFetch({ list: () => ({ ok: true, repo: "acme/widgets", items: [], query: "repo:acme/widgets sort:updated" }) }));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-empty")).toBeInTheDocument());
  });

  it("renders the not-authenticated/permission error message without leaking the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, authenticated: false, error: "GitHub PM is not authenticated. Configure gh CLI, GITHUB_TOKEN, or a plugin PAT.", code: "not_authenticated" }, 401)),
    );
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussions-panel-categories-error")).toBeInTheDocument());
    expect(screen.getByTestId("discussions-panel-categories-error")).toHaveTextContent(/not authenticated/i);
    expect(screen.queryByText(/ghp_|super-secret/i)).not.toBeInTheDocument();
  });

  it("renders an unanswered badge (not a dangling shell) for a discussion with no answer", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<DiscussionsPanel repo="acme/widgets" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("discussion-answered-badge-1")).toBeInTheDocument());
    expect(screen.getByTestId("discussion-answered-badge-1")).toHaveTextContent("Unanswered");
  });
});

describe("DiscussionsPanel gating (KB-005, reuses FUSI-009's existing tab gating)", () => {
  function mockViewFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/repo-config")) return jsonResponse({ ok: true, selectedRepo: "acme/widgets" });
      if (url.includes("/repo/capabilities")) {
        return jsonResponse({
          ok: true,
          repo: "acme/widgets",
          authenticated: true,
          tabs: {
            issues: { available: true },
            labels: { available: true },
            milestones: { available: true },
            discussions: { available: false, reason: "feature-disabled", message: "Discussions are not enabled for this repository." },
            projects: { available: true },
            triage: { available: true },
          },
        });
      }
      if (url.includes("/status")) return jsonResponse({ ok: true, configured: true, autonomy: "approve-all", defaultRepo: "acme/widgets" });
      return jsonResponse({ ok: false, error: "unexpected route" }, 404);
    });
  }

  it("renders TabCapabilityNotice and NOT the DiscussionsPanel body when the discussions tab is gated off", async () => {
    vi.stubGlobal("fetch", mockViewFetch());
    render(<GitHubPmView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("GitHub PM configured");

    fireEvent.click(screen.getByRole("tab", { name: /discussions/i }));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(screen.getByTestId("tab-capability-notice")).toBeInTheDocument());
    expect(screen.queryByTestId("discussions-panel")).not.toBeInTheDocument();
    expect(screen.getByText(/Discussions are not enabled for this repository\./i)).toBeInTheDocument();
  });
});
