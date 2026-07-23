import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IssueDetailView } from "../IssueDetailView.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_ISSUE = {
  number: 42,
  title: "Distinctive-Fixture bug",
  state: "open" as const,
  bodyMarkdown: "Body with a task list:\n\n- [x] done\n- [ ] todo\n\n```js\nconst x = 1;\n```\n\n![alt](https://example.com/img.png)",
  htmlUrl: "https://github.com/acme/widgets/issues/42",
  author: { login: "octocat" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  labels: [{ name: "bug", color: "ff0000" }],
  assignees: [{ login: "hubot" }],
  milestone: { title: "v1", state: "open", dueOn: "2026-02-01T00:00:00Z" },
  commentCount: 1,
};

const BASE_COMMENT = { id: 1, author: { login: "octocat" }, bodyMarkdown: "first comment", createdAt: "2026-01-01T00:00:00Z" };

function stubDetailFetch(overrides: Partial<typeof BASE_ISSUE> = {}, extra: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async () => jsonResponse({
    ok: true,
    repo: "acme/widgets",
    issue: { ...BASE_ISSUE, ...overrides },
    timeline: [],
    comments: [BASE_COMMENT],
    commentsNextPage: null,
    ...extra,
  }));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("IssueDetailView", () => {
  it("renders markdown body: code block, image, and task-list checkbox", async () => {
    stubDetailFetch();
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-view");
    const body = screen.getByTestId("issue-detail-body");
    expect(body.querySelector("code")).toBeInTheDocument();
    expect(body.querySelector("img")).toBeInTheDocument();
    expect(body.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("renders 'No description provided.' for an empty body", async () => {
    stubDetailFetch({ bodyMarkdown: "" });
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    expect(await screen.findByTestId("issue-detail-empty-body")).toHaveTextContent("No description provided.");
  });

  it("sidebar shows labels/assignees/milestone and omits empty sections", async () => {
    stubDetailFetch();
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-sidebar");
    expect(screen.getByTestId("issue-detail-sidebar-labels")).toHaveTextContent("bug");
    expect(screen.getByTestId("issue-detail-sidebar-assignees")).toHaveTextContent("hubot");
    expect(screen.getByTestId("issue-detail-sidebar-milestone")).toHaveTextContent("v1");
  });

  it("omits labels/assignees/milestone sidebar sections when empty (no shells)", async () => {
    stubDetailFetch({ labels: [], assignees: [], milestone: null });
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-sidebar");
    expect(screen.queryByTestId("issue-detail-sidebar-labels")).not.toBeInTheDocument();
    expect(screen.queryByTestId("issue-detail-sidebar-assignees")).not.toBeInTheDocument();
    expect(screen.queryByTestId("issue-detail-sidebar-milestone")).not.toBeInTheDocument();
  });

  it("renders no 'Load more' shell for a zero-comment issue", async () => {
    stubDetailFetch({}, { comments: [], commentsNextPage: null });
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-no-comments");
    expect(screen.queryByTestId("issue-detail-load-more")).not.toBeInTheDocument();
  });

  it("paginates comments: clicking Load more appends the next page and the button disappears once nextPage is null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/issues/comments")) {
        return jsonResponse({ ok: true, comments: [{ id: 2, author: { login: "hubot" }, bodyMarkdown: "second comment" }], nextPage: null });
      }
      return jsonResponse({
        ok: true,
        repo: "acme/widgets",
        issue: BASE_ISSUE,
        timeline: [],
        comments: [BASE_COMMENT],
        commentsNextPage: 2,
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    const loadMore = await screen.findByTestId("issue-detail-load-more");
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByTestId("issue-detail-comment-2")).toBeInTheDocument());
    expect(screen.queryByTestId("issue-detail-load-more")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-detail-comment-1")).toBeInTheDocument();
  });

  it("renders an error state using only the server's already-redacted message (never a raw token)", async () => {
    // The route layer redacts token values before they ever reach the client (see
    // issue-routes.test.ts's "never echoes the token value" coverage); this asserts
    // the view renders that redacted text verbatim and never independently surfaces
    // any credential-shaped value of its own.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, error: "The resolved GitHub token was rejected (401). token-[redacted]" }, 401)));
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    const errorNode = await screen.findByTestId("issue-detail-error");
    expect(errorNode).toBeInTheDocument();
    expect(errorNode.textContent).toContain("rejected");
    expect(errorNode.textContent).not.toMatch(/ghp_[A-Za-z0-9]/);
  });

  it("shows a back affordance only when onBack is provided", async () => {
    stubDetailFetch();
    const onBack = vi.fn();
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} onBack={onBack} />);

    const back = await screen.findByTestId("issue-detail-back");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });

  it("does not render a back affordance when onBack is omitted", async () => {
    stubDetailFetch();
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-view");
    expect(screen.queryByTestId("issue-detail-back")).not.toBeInTheDocument();
  });

  it("renders closed-vs-open state badges correctly", async () => {
    stubDetailFetch({ state: "closed" });
    render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-view");
    expect(screen.getAllByTestId("issue-detail-state-badge")[0]).toHaveTextContent("Closed");
  });

  it("uses the mobile-reflow container structure (body-layout grid + sidebar) present at any width", async () => {
    stubDetailFetch();
    const { container } = render(<IssueDetailView repo="acme/widgets" issueNumber={42} />);

    await screen.findByTestId("issue-detail-view");
    expect(container.querySelector(".issue-detail__body-layout")).toBeInTheDocument();
    expect(container.querySelector(".issue-detail__sidebar")).toBeInTheDocument();
  });
});
