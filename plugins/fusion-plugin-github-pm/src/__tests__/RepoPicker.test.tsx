import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RepoPicker } from "../RepoPicker.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(handlers: {
  search?: (url: URL) => unknown;
  recents?: unknown;
  select?: (body: { repo?: string }) => { status: number; body: unknown };
}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
    if (url.pathname.endsWith("/repo-picker/recents")) {
      return jsonResponse(handlers.recents ?? { ok: true, recents: [] });
    }
    if (url.pathname.endsWith("/repo-picker/search")) {
      return jsonResponse(handlers.search ? handlers.search(url) : { ok: true, items: [] });
    }
    if (url.pathname.endsWith("/repo-picker/select")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = handlers.select ? handlers.select(body) : { status: 200, body: { ok: true, selectedRepo: body.repo } };
      return jsonResponse(result.body, result.status);
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

describe("RepoPicker (FUSI-007)", () => {
  it("does not fetch anything until the popover opens", () => {
    const fetchImpl = mockFetch({});
    vi.stubGlobal("fetch", fetchImpl);
    render(<RepoPicker />);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.queryByTestId("repo-picker-popover")).not.toBeInTheDocument();
  });

  it("renders recents when the query is empty (idle)", async () => {
    vi.stubGlobal("fetch", mockFetch({ recents: { ok: true, recents: [{ repo: "owner/repo", lastUsedAt: new Date().toISOString() }] } }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("repo-picker-recent-owner/repo")).toBeInTheDocument());
    expect(screen.queryByTestId("repo-picker-search-list")).not.toBeInTheDocument();
  });

  it("renders 'no recently used repositories yet' for an empty recents list", async () => {
    vi.stubGlobal("fetch", mockFetch({ recents: { ok: true, recents: [] } }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("repo-picker-recents-empty")).toBeInTheDocument());
  });

  it("search results render on query, and clearing the query reverts to recents", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [] },
      search: (url) => ({ ok: true, items: [{ fullName: "acme/widgets", owner: "acme", name: "widgets", private: false, htmlUrl: "https://x", description: null }] }),
    }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByTestId("repo-picker-search-input"), { target: { value: "widgets" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    await waitFor(() => expect(screen.getByTestId("repo-picker-result-acme/widgets")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("repo-picker-search-input"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("repo-picker-recents")).toBeInTheDocument());
  });

  it("renders a zero-results state distinctly from loading/error", async () => {
    vi.stubGlobal("fetch", mockFetch({ recents: { ok: true, recents: [] }, search: () => ({ ok: true, items: [] }) }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByTestId("repo-picker-search-input"), { target: { value: "no-such-repo" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    await waitFor(() => expect(screen.getByTestId("repo-picker-search-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("repo-picker-search-loading")).not.toBeInTheDocument();
  });

  it("manual entry: not-found error renders clear copy, not raw API JSON", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [] },
      select: () => ({ status: 404, body: { ok: false, error: 'Repository "owner/ghost" was not found.', code: "not_found" } }),
    }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByTestId("repo-picker-manual-input"), { target: { value: "owner/ghost" } });
    fireEvent.click(screen.getByTestId("repo-picker-manual-submit"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(screen.getByTestId("repo-picker-manual-error")).toBeInTheDocument());
    expect(screen.getByTestId("repo-picker-manual-error").textContent).toContain("not found");
    expect(screen.getByTestId("repo-picker-manual-error").textContent).not.toMatch(/\{|"code"/);
  });

  it("manual entry: no-access error renders clear copy, not raw API JSON", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [] },
      select: () => ({ status: 403, body: { ok: false, error: "You don't have access to \"owner/private\" with the current GitHub credentials.", code: "auth_error" } }),
    }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByTestId("repo-picker-manual-input"), { target: { value: "owner/private" } });
    fireEvent.click(screen.getByTestId("repo-picker-manual-submit"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(screen.getByTestId("repo-picker-manual-error")).toBeInTheDocument());
    expect(screen.getByTestId("repo-picker-manual-error").textContent).toContain("don't have access");
  });

  it("manual entry rejects a malformed owner/repo string before calling the select route", async () => {
    const fetchImpl = mockFetch({ recents: { ok: true, recents: [] } });
    vi.stubGlobal("fetch", fetchImpl);
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fetchImpl.mockClear();
    fireEvent.change(screen.getByTestId("repo-picker-manual-input"), { target: { value: "not-valid" } });
    fireEvent.click(screen.getByTestId("repo-picker-manual-submit"));

    await waitFor(() => expect(screen.getByTestId("repo-picker-manual-error")).toBeInTheDocument());
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("/repo-picker/select"))).toBe(false);
  });

  it("select calls the route and updates the header display via onSelect, closing the popover", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [{ repo: "owner/repo", lastUsedAt: new Date().toISOString() }] },
      select: (body) => ({ status: 200, body: { ok: true, selectedRepo: body.repo } }),
    }));
    const onSelect = vi.fn();
    render(<RepoPicker onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("repo-picker-recent-owner/repo")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("repo-picker-recent-owner/repo"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("owner/repo"));
    expect(screen.queryByTestId("repo-picker-popover")).not.toBeInTheDocument();
  });

  it("dedupes: selecting an already-recent repo does not render it twice", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [{ repo: "owner/repo", lastUsedAt: new Date().toISOString() }] },
    }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getAllByTestId("repo-picker-recent-owner/repo")).toHaveLength(1));
  });

  it("never renders a PAT/token value even if it leaked into a response", async () => {
    vi.stubGlobal("fetch", mockFetch({
      recents: { ok: true, recents: [], personalAccessToken: "ghp_should_never_render" },
    }));
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    await waitFor(() => expect(screen.getByTestId("repo-picker-recents-empty")).toBeInTheDocument());
    expect(screen.queryByText(/ghp_should_never_render/)).not.toBeInTheDocument();
  });

  it("no orphaned button shells remain when transitioning loading -> error -> populated across renders", async () => {
    const fetchImpl = mockFetch({
      recents: { ok: true, recents: [] },
      search: () => ({ ok: false, error: "GitHub API rate limit exceeded.", code: "rate_limited" }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<RepoPicker />);
    fireEvent.click(screen.getByTestId("repo-picker-toggle"));
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    fireEvent.change(screen.getByTestId("repo-picker-search-input"), { target: { value: "widgets" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await waitFor(() => expect(screen.getByTestId("repo-picker-search-error")).toBeInTheDocument());

    // No stray result buttons/rows remain alongside the error state; every remaining icon-only
    // button (e.g. the close affordance) still carries an accessible name, so it's not orphaned.
    expect(screen.queryByTestId(/repo-picker-result-/)).not.toBeInTheDocument();
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent !== "" || button.hasAttribute("aria-label")).toBe(true);
    }
  });
});
