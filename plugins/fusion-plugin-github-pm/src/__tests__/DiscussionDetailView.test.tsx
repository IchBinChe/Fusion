import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DiscussionDetailView } from "../DiscussionDetailView.js";

/*
FNXC:GithubPmDiscussions 2026-07-25-15:40:
KB-006 detail-view tests: body + upvotes + two-level thread rendering, the zero-comment
no-shell state, comment/reply lazy pagination to exhaustion (button removed once its cursor
is null, never rendered when there is nothing to page), and the confirm-writes gate sending
confirmed:true on both a top-level post and a reply post. Mirrors IssueDetailView.test.tsx's
fetch-stub conventions and IssueWritePanel.test.tsx's mocked-useConfirm pattern.
*/
const mockConfirm = vi.fn<(options: unknown) => Promise<boolean>>();
vi.mock("@fusion/dashboard/app/hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: mockConfirm }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockConfirm.mockReset();
});

const BASE_DISCUSSION = {
  id: "D_1",
  number: 7,
  title: "How do I configure X?",
  bodyMarkdown: "Please help.\n\n```js\nconst x = 1;\n```",
  url: "https://github.com/acme/widgets/discussions/7",
  upvoteCount: 3,
  categoryName: "Q&A",
  categoryEmoji: "\u2753",
  isAnswerable: true,
  authorLogin: "octocat",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  answerChosenAt: null as string | null,
  commentCount: 1,
};

const BASE_COMMENT = {
  id: "DC_1",
  author: { login: "helper" },
  bodyMarkdown: "Try this.",
  upvoteCount: 2,
  createdAt: "2026-01-01T01:00:00Z",
  replies: [{ id: "DR_1", author: { login: "octocat" }, bodyMarkdown: "Thanks!", upvoteCount: 1, createdAt: "2026-01-01T02:00:00Z" }],
  repliesNextCursor: null as string | null,
};

function stubDetailFetch(discussionOverrides: Record<string, unknown> = {}, comments: unknown[] = [BASE_COMMENT], commentsNextCursor: string | null = null) {
  const fetchImpl = vi.fn(async () => jsonResponse({
    ok: true,
    repo: "acme/widgets",
    discussion: { ...BASE_DISCUSSION, ...discussionOverrides, comments, commentsNextCursor },
  }));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("DiscussionDetailView", () => {
  it("renders the body, upvote count, category, and the two-level thread (comment + its reply)", async () => {
    stubDetailFetch();
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    await screen.findByTestId("discussion-detail-view");
    expect(screen.getByTestId("discussion-detail-body").querySelector("code")).toBeInTheDocument();
    expect(screen.getByTestId("discussion-detail-upvotes")).toHaveTextContent("3");
    expect(screen.getByTestId("discussion-detail-comment-DC_1")).toBeInTheDocument();
    expect(screen.getByTestId("discussion-detail-reply-DR_1")).toBeInTheDocument();
  });

  it("renders an 'Unanswered' badge for a null answerChosenAt and 'Answered' for a present one", async () => {
    stubDetailFetch({ answerChosenAt: null });
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);
    expect(await screen.findByTestId("discussion-detail-answered-badge")).toHaveTextContent("Unanswered");
    cleanup();

    stubDetailFetch({ answerChosenAt: "2026-01-03T00:00:00Z" });
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);
    expect(await screen.findByTestId("discussion-detail-answered-badge")).toHaveTextContent("Answered");
  });

  it("never crashes when isAnswerable is false (no answered badge rendered at all)", async () => {
    stubDetailFetch({ isAnswerable: false });
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);
    await screen.findByTestId("discussion-detail-view");
    expect(screen.queryByTestId("discussion-detail-answered-badge")).not.toBeInTheDocument();
  });

  it("zero-comment discussion: shows the composer, no thread, and no load-more shell", async () => {
    stubDetailFetch({}, [], null);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    await screen.findByTestId("discussion-detail-no-comments");
    expect(screen.getByTestId("discussion-detail-composer-body")).toBeInTheDocument();
    expect(screen.queryByTestId("discussion-detail-load-more-comments")).not.toBeInTheDocument();
  });

  it("a top-level comment with zero replies renders no reply-pagination shell", async () => {
    stubDetailFetch({}, [{ ...BASE_COMMENT, replies: [], repliesNextCursor: null }], null);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    await screen.findByTestId("discussion-detail-comment-DC_1");
    expect(screen.queryByTestId("discussion-detail-load-more-replies-DC_1")).not.toBeInTheDocument();
  });

  it("paginates comments to exhaustion: Load more comments appends the next page and disappears once nextCursor is null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/discussions/comments") && !url.includes("number=7&repo")) {
        // fallthrough
      }
      if (typeof url === "string" && url.includes("/discussions/comments")) {
        return jsonResponse({ ok: true, comments: [{ id: "DC_2", author: { login: "b" }, bodyMarkdown: "page two", upvoteCount: 0, createdAt: "2026-01-01T00:00:00Z", replies: [], repliesNextCursor: null }], nextCursor: null });
      }
      return jsonResponse({ ok: true, repo: "acme/widgets", discussion: { ...BASE_DISCUSSION, comments: [BASE_COMMENT], commentsNextCursor: "cursor-1" } });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    const loadMore = await screen.findByTestId("discussion-detail-load-more-comments");
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByTestId("discussion-detail-comment-DC_2")).toBeInTheDocument());
    expect(screen.queryByTestId("discussion-detail-load-more-comments")).not.toBeInTheDocument();
    expect(screen.getByTestId("discussion-detail-comment-DC_1")).toBeInTheDocument();
  });

  it("paginates a comment's replies to exhaustion: Load more replies appends and disappears once nextCursor is null", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/discussions/replies")) {
        return jsonResponse({ ok: true, replies: [{ id: "DR_2", author: { login: "b" }, bodyMarkdown: "second reply", upvoteCount: 0, createdAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
      }
      return jsonResponse({
        ok: true,
        repo: "acme/widgets",
        discussion: { ...BASE_DISCUSSION, comments: [{ ...BASE_COMMENT, repliesNextCursor: "reply-cursor-1" }], commentsNextCursor: null },
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    const loadMoreReplies = await screen.findByTestId("discussion-detail-load-more-replies-DC_1");
    fireEvent.click(loadMoreReplies);

    await waitFor(() => expect(screen.getByTestId("discussion-detail-reply-DR_2")).toBeInTheDocument());
    expect(screen.queryByTestId("discussion-detail-load-more-replies-DC_1")).not.toBeInTheDocument();
    expect(screen.getByTestId("discussion-detail-reply-DR_1")).toBeInTheDocument();
  });

  it("posts a top-level comment sending confirmed:true when the confirm gate is on and the operator confirms", async () => {
    mockConfirm.mockResolvedValue(true);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/discussions/comments") && init?.method === "POST") {
        const sentBody = JSON.parse(String(init.body));
        expect(sentBody.confirmed).toBe(true);
        expect(sentBody.replyToId).toBeUndefined();
        return jsonResponse({ ok: true, comment: { id: "DC_9", author: { login: "octocat" }, bodyMarkdown: "new comment", upvoteCount: 0, createdAt: "2026-01-01T00:00:00Z", replyToId: null } });
      }
      return jsonResponse({ ok: true, repo: "acme/widgets", discussion: { ...BASE_DISCUSSION, comments: [], commentsNextCursor: null } });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} confirmWrites />);

    const textarea = await screen.findByTestId("discussion-detail-composer-body");
    fireEvent.change(textarea, { target: { value: "new comment" } });
    fireEvent.click(screen.getByTestId("discussion-detail-composer-submit"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("discussion-detail-comment-DC_9")).toBeInTheDocument());
  });

  it("posts a reply carrying the correct parent-reply id", async () => {
    mockConfirm.mockResolvedValue(true);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/discussions/comments") && init?.method === "POST") {
        const sentBody = JSON.parse(String(init.body));
        expect(sentBody.replyToId).toBe("DC_1");
        expect(sentBody.confirmed).toBe(true);
        return jsonResponse({ ok: true, comment: { id: "DC_10", author: { login: "octocat" }, bodyMarkdown: "a reply", upvoteCount: 0, createdAt: "2026-01-01T00:00:00Z", replyToId: "DC_1" } });
      }
      return jsonResponse({ ok: true, repo: "acme/widgets", discussion: { ...BASE_DISCUSSION, comments: [{ ...BASE_COMMENT, replies: [] }], commentsNextCursor: null } });
    });
    vi.stubGlobal("fetch", fetchImpl);
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} confirmWrites />);

    fireEvent.click(await screen.findByTestId("discussion-detail-reply-toggle-DC_1"));
    fireEvent.change(screen.getByTestId("discussion-detail-reply-body-DC_1"), { target: { value: "a reply" } });
    fireEvent.click(screen.getByTestId("discussion-detail-reply-submit-DC_1"));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("discussion-detail-reply-DC_10")).toBeInTheDocument());
  });

  it("shows a back affordance only when onBack is provided", async () => {
    stubDetailFetch();
    const onBack = vi.fn();
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} onBack={onBack} />);

    const back = await screen.findByTestId("discussion-detail-back");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });

  it("does not render a back affordance when onBack is omitted", async () => {
    stubDetailFetch();
    render(<DiscussionDetailView repo="acme/widgets" discussionNumber={7} />);

    await screen.findByTestId("discussion-detail-view");
    expect(screen.queryByTestId("discussion-detail-back")).not.toBeInTheDocument();
  });
});
