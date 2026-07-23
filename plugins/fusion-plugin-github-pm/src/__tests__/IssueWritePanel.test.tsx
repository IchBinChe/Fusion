import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IssueWritePanel } from "../IssueWritePanel.js";
import { subscribeIssuesChanged } from "../issues-events.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function detailPayload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    repo: "acme/widgets",
    issue: { number: 5, title: "Existing issue", state: "open", bodyMarkdown: "Existing body", htmlUrl: "https://x", author: null, labels: [], assignees: [], milestone: null, commentCount: 0, ...overrides },
    timeline: [],
    comments: [],
    commentsNextPage: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IssueWritePanel (FUSI-014)", () => {
  it("renders a 'select a repository' affordance and fires no fetch when repo is null", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssueWritePanel repo={null} />);
    expect(screen.getByTestId("issue-write-panel-no-repo")).toBeInTheDocument();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a successful create appends optimistically, reconciles to the server object, and fires notifyIssuesChanged", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/create")) return jsonResponse({ ok: true, repo: "acme/widgets", issue: { number: 9, title: "New bug", state: "open", bodyMarkdown: "" } });
      if (url.includes("/issues/detail")) return jsonResponse(detailPayload({ number: 9, title: "New bug" }));
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-create-title"), { target: { value: "New bug" } });
    fireEvent.click(screen.getByTestId("issue-write-create-submit"));

    // Optimistic append happens synchronously before the fetch resolves.
    expect(screen.getByTestId("issue-write-created-list")).toHaveTextContent(/Creating "New bug"/);

    await waitFor(() => expect(screen.getByTestId("issue-write-created-9")).toBeInTheDocument());
    expect(screen.getByTestId("issue-write-created-9")).toHaveTextContent("#9 New bug");

    expect(listener).toHaveBeenCalledWith({ repo: "acme/widgets", issueNumber: 9, kind: "created" });
    unsubscribe();
  });

  it("a FAILED create rolls back the optimistic append, shows the error banner, and does NOT fire notifyIssuesChanged", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/create")) return jsonResponse({ ok: false, error: "You do not have permission to create issues." }, 403);
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-create-title"), { target: { value: "Doomed issue" } });
    fireEvent.click(screen.getByTestId("issue-write-create-submit"));

    await waitFor(() => expect(screen.getByTestId("issue-write-error")).toBeInTheDocument());
    expect(screen.getByTestId("issue-write-error")).toHaveTextContent("You do not have permission to create issues.");
    expect(screen.queryByTestId("issue-write-created-list")).not.toBeInTheDocument();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("loading an issue seeds the edit form and mounts IssueDetailView (reused, not forked)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/detail")) return jsonResponse(detailPayload());
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-select-number"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("issue-write-select-submit"));

    await waitFor(() => expect(screen.getByTestId("issue-write-edit-title")).toHaveValue("Existing issue"));
    expect(screen.getByTestId("issue-write-edit-body")).toHaveValue("Existing body");
    await waitFor(() => expect(screen.getByTestId("issue-detail-view")).toBeInTheDocument());
  });

  it("a successful close fires notifyIssuesChanged with kind 'closed' and bumps the IssueDetailView refresh", async () => {
    let detailCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/state")) return jsonResponse({ ok: true, repo: "acme/widgets", issue: { number: 5, title: "Existing issue", state: "closed", bodyMarkdown: "Existing body" } });
      if (url.includes("/issues/detail")) {
        detailCalls += 1;
        return jsonResponse(detailPayload({ state: detailCalls > 1 ? "closed" : "open" }));
      }
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-select-number"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("issue-write-select-submit"));
    await waitFor(() => expect(screen.getByTestId("issue-write-close")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("issue-write-close"));

    await waitFor(() => expect(listener).toHaveBeenCalledWith({ repo: "acme/widgets", issueNumber: 5, kind: "closed" }));
    await waitFor(() => expect(screen.getByTestId("issue-write-reopen")).toBeInTheDocument());
    // detailRefreshNonce bump remounts IssueDetailView -> a second /issues/detail fetch beyond the initial load.
    await waitFor(() => expect(detailCalls).toBeGreaterThan(1));
    unsubscribe();
  });

  it("a FAILED close reverts the optimistic state toggle and does not fire notifyIssuesChanged for it", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/state")) return jsonResponse({ ok: false, error: "Not permitted to close this issue." }, 403);
      if (url.includes("/issues/detail")) return jsonResponse(detailPayload());
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-select-number"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("issue-write-select-submit"));
    await waitFor(() => expect(screen.getByTestId("issue-write-close")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("issue-write-close"));

    await waitFor(() => expect(screen.getByTestId("issue-write-error")).toHaveTextContent("Not permitted to close this issue."));
    // Rolled back: the close button (open-state affordance) is still present, not the reopen button.
    expect(screen.getByTestId("issue-write-close")).toBeInTheDocument();
    expect(screen.queryByTestId("issue-write-reopen")).not.toBeInTheDocument();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("a successful reopen fires notifyIssuesChanged with kind 'reopened'", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/state")) return jsonResponse({ ok: true, repo: "acme/widgets", issue: { number: 5, title: "Existing issue", state: "open", bodyMarkdown: "Existing body" } });
      if (url.includes("/issues/detail")) return jsonResponse(detailPayload({ state: "closed" }));
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-select-number"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("issue-write-select-submit"));
    await waitFor(() => expect(screen.getByTestId("issue-write-reopen")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("issue-write-reopen"));

    await waitFor(() => expect(listener).toHaveBeenCalledWith({ repo: "acme/widgets", issueNumber: 5, kind: "reopened" }));
    unsubscribe();
  });

  it("a successful comment fires notifyIssuesChanged with kind 'commented'", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues/comments")) return jsonResponse({ ok: true, repo: "acme/widgets", issueNumber: 5, comment: { id: 1, bodyMarkdown: "hi" } });
      if (url.includes("/issues/detail")) return jsonResponse(detailPayload());
      return jsonResponse({ ok: false, error: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    const listener = vi.fn();
    const unsubscribe = subscribeIssuesChanged(listener);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-select-number"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("issue-write-select-submit"));
    await waitFor(() => expect(screen.getByTestId("issue-write-comment-body")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("issue-write-comment-body"), { target: { value: "hi" } });
    fireEvent.click(screen.getByTestId("issue-write-comment-submit"));

    await waitFor(() => expect(listener).toHaveBeenCalledWith({ repo: "acme/widgets", issueNumber: 5, kind: "commented" }));
    unsubscribe();
  });

  it("the unauthenticated/permission error message is rendered verbatim from the route", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "GitHub PM is not authenticated. Add a PAT in Plugin Manager settings, set GITHUB_TOKEN, or run 'gh auth login'.", code: "not_authenticated" }, 401));
    vi.stubGlobal("fetch", fetchImpl);

    render(<IssueWritePanel repo="acme/widgets" />);
    fireEvent.change(screen.getByTestId("issue-write-create-title"), { target: { value: "X" } });
    fireEvent.click(screen.getByTestId("issue-write-create-submit"));

    await waitFor(() => expect(screen.getByTestId("issue-write-error")).toHaveTextContent(
      "GitHub PM is not authenticated. Add a PAT in Plugin Manager settings, set GITHUB_TOKEN, or run 'gh auth login'.",
    ));
  });
});
