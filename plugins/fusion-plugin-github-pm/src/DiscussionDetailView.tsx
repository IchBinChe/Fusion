import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowLeft, CheckCircle2, ExternalLink, HelpCircle, Loader2, MessageSquarePlus, ThumbsUp } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useConfirm } from "@fusion/dashboard/app/hooks/useConfirm";
import "./DiscussionDetailView.css";

/*
FNXC:GithubPmDiscussions 2026-07-25-15:00:
KB-006's sole discussion-DETAIL rendering + reply/composer surface. Mount seam: `{ context,
repo, discussionNumber, confirmWrites?, onBack? }` -- mirrors IssueDetailView's mount shape
(fetch-on-mount, ReactMarkdown + remark-gfm body, `onBack` optional). UNLIKE IssueDetailView
(which is read-only comment display, with editing/commenting split into a separate
IssueWritePanel), this component owns BOTH rendering and the write affordances (top-level
comment composer + per-comment reply composer) -- the task's mission explicitly keeps the
composer here as the ONLY discussion reply surface; do not fork a second one.

THREAD-NESTING CONTRACT (acceptance-critical): GitHub Discussions are exactly two levels
deep -- top-level comments, each with its own (non-nested) replies. This component never
renders a reply's own "reply" affordance; only top-level comments get one.

LAZY-PAGINATION / NO-ORPHANED-SHELL CONTRACT (acceptance-critical, mirrors IssueDetailView):
the "Load more comments" button and each comment's "Load more replies" button are REMOVED
(not disabled) once their respective cursor is exhausted (null), and are NEVER rendered when
there is nothing to page (a zero-comment discussion shows no thread and no load-more shell at
all; a comment with zero replies shows no reply-load-more shell). The top-level composer is
the ONLY affordance that always renders regardless of thread state.

CONFIRMATION-GATE CONTRACT: `confirmWrites` defaults to `true` (ON) when the prop is
omitted/undefined -- same fail-safe convention IssueWritePanel/LabelsPanel/MilestonesPanel use
-- and every post (top-level or reply) shows a confirm dialog via `useConfirm` before
dispatching when the gate is on, sending `confirmed:true` in the request body exactly as the
server-side `requireConfirmation` guard expects.
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

interface DiscussionUser {
  login: string;
  avatarUrl?: string;
}

interface DiscussionReply {
  id: string;
  author: DiscussionUser | null;
  bodyMarkdown: string;
  upvoteCount: number;
  createdAt?: string;
}

interface DiscussionComment {
  id: string;
  author: DiscussionUser | null;
  bodyMarkdown: string;
  upvoteCount: number;
  createdAt?: string;
  replies: DiscussionReply[];
  repliesNextCursor: string | null;
}

interface DiscussionDetail {
  id: string;
  number: number;
  title: string;
  bodyMarkdown: string;
  url: string;
  upvoteCount: number;
  categoryName: string | null;
  categoryEmoji: string | null;
  isAnswerable: boolean;
  authorLogin: string | null;
  createdAt?: string;
  updatedAt?: string;
  answerChosenAt: string | null;
  commentCount: number;
  comments: DiscussionComment[];
  commentsNextCursor: string | null;
}

interface DiscussionDetailResponse {
  ok?: boolean;
  error?: string;
  repo?: string;
  discussion?: DiscussionDetail;
}

interface DiscussionCommentsResponse {
  ok?: boolean;
  error?: string;
  comments?: DiscussionComment[];
  nextCursor?: string | null;
}

interface DiscussionRepliesResponse {
  ok?: boolean;
  error?: string;
  replies?: DiscussionReply[];
  nextCursor?: string | null;
}

interface DiscussionCommentPostResponse {
  ok?: boolean;
  error?: string;
  comment?: {
    id: string;
    author: DiscussionUser | null;
    bodyMarkdown: string;
    upvoteCount: number;
    createdAt?: string;
    replyToId: string | null;
  };
}

type ViewState = "loading" | "ready" | "error";

function projectQuery(context: PluginDashboardViewContext | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...(context?.projectId ? { projectId: context.projectId } : {}), ...extra });
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `Request failed with status ${response.status}.`);
  }
  return json;
}

async function loadDiscussionDetail(context: PluginDashboardViewContext | undefined, repo: string, number: number): Promise<DiscussionDetailResponse> {
  return fetchJson<DiscussionDetailResponse>(`${PLUGIN_BASE}/discussions/detail${projectQuery(context, { repo, number: String(number) })}`);
}

async function loadDiscussionCommentsPage(context: PluginDashboardViewContext | undefined, repo: string, number: number, after: string): Promise<DiscussionCommentsResponse> {
  return fetchJson<DiscussionCommentsResponse>(`${PLUGIN_BASE}/discussions/comments${projectQuery(context, { repo, number: String(number), after })}`);
}

async function loadDiscussionRepliesPage(context: PluginDashboardViewContext | undefined, commentId: string, after: string): Promise<DiscussionRepliesResponse> {
  return fetchJson<DiscussionRepliesResponse>(`${PLUGIN_BASE}/discussions/replies${projectQuery(context, { commentId, after })}`);
}

async function postDiscussionCommentRequest(
  context: PluginDashboardViewContext | undefined,
  input: { repo: string; discussionId: string; body: string; replyToId?: string; confirmed: boolean },
): Promise<DiscussionCommentPostResponse> {
  return fetchJson<DiscussionCommentPostResponse>(`${PLUGIN_BASE}/discussions/comments${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repo: input.repo,
      discussionId: input.discussionId,
      body: input.body,
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.confirmed ? { confirmed: true } : {}),
    }),
  });
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function ReplyItem({ reply }: { reply: DiscussionReply }) {
  return (
    <li className="discussion-detail__reply" data-testid={`discussion-detail-reply-${reply.id}`}>
      <div className="discussion-detail__comment-header">
        <span className="discussion-detail__comment-author">{reply.author?.login ?? "Unknown"}</span>
        <span className="discussion-detail__comment-stat">
          <ThumbsUp aria-hidden="true" /> {reply.upvoteCount}
        </span>
        <span className="discussion-detail__comment-time">{formatTimestamp(reply.createdAt)}</span>
      </div>
      <div className="discussion-detail__comment-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{reply.bodyMarkdown || "_No content._"}</ReactMarkdown>
      </div>
    </li>
  );
}

export interface DiscussionDetailViewProps {
  context?: PluginDashboardViewContext;
  repo: string;
  discussionNumber: number;
  confirmWrites?: boolean;
  onBack?: () => void;
}

export function DiscussionDetailView({ context, repo, discussionNumber, confirmWrites, onBack }: DiscussionDetailViewProps) {
  const gateWrites = confirmWrites !== false;
  const { confirm } = useConfirm();

  const [state, setState] = useState<ViewState>("loading");
  const [discussion, setDiscussion] = useState<DiscussionDetail | null>(null);
  const [comments, setComments] = useState<DiscussionComment[]>([]);
  const [commentsNextCursor, setCommentsNextCursor] = useState<string | null>(null);
  const [loadingMoreComments, setLoadingMoreComments] = useState(false);
  const [loadingMoreRepliesFor, setLoadingMoreRepliesFor] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();

  const [newCommentBody, setNewCommentBody] = useState("");
  const [newCommentPending, setNewCommentPending] = useState(false);
  const [newCommentError, setNewCommentError] = useState<string>();

  const [replyingToId, setReplyingToId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyPending, setReplyPending] = useState(false);
  const [replyError, setReplyError] = useState<string>();

  const load = useCallback(async () => {
    setState("loading");
    setErrorMessage(undefined);
    try {
      const result = await loadDiscussionDetail(context, repo, discussionNumber);
      setDiscussion(result.discussion ?? null);
      setComments(result.discussion?.comments ?? []);
      setCommentsNextCursor(result.discussion?.commentsNextCursor ?? null);
      setState("ready");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load the discussion.");
      setState("error");
    }
  }, [context, repo, discussionNumber]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLoadMoreComments = useCallback(async () => {
    if (commentsNextCursor === null) return;
    setLoadingMoreComments(true);
    try {
      const result = await loadDiscussionCommentsPage(context, repo, discussionNumber, commentsNextCursor);
      setComments((prev) => [...prev, ...(result.comments ?? [])]);
      setCommentsNextCursor(result.nextCursor ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load more comments.");
    } finally {
      setLoadingMoreComments(false);
    }
  }, [context, repo, discussionNumber, commentsNextCursor]);

  const handleLoadMoreReplies = useCallback(async (comment: DiscussionComment) => {
    if (comment.repliesNextCursor === null) return;
    setLoadingMoreRepliesFor(comment.id);
    try {
      const result = await loadDiscussionRepliesPage(context, comment.id, comment.repliesNextCursor);
      setComments((prev) =>
        prev.map((candidate) =>
          candidate.id === comment.id
            ? { ...candidate, replies: [...candidate.replies, ...(result.replies ?? [])], repliesNextCursor: result.nextCursor ?? null }
            : candidate,
        ),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load more replies.");
    } finally {
      setLoadingMoreRepliesFor(null);
    }
  }, [context]);

  const handlePostComment = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!discussion || !newCommentBody.trim()) return;
    if (gateWrites) {
      const proceed = await confirm({
        title: "Post comment?",
        message: `Post this comment on "${discussion.title}"?`,
        confirmLabel: "Post comment",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
    }
    setNewCommentPending(true);
    setNewCommentError(undefined);
    const snapshot = newCommentBody;
    try {
      const result = await postDiscussionCommentRequest(context, { repo, discussionId: discussion.id, body: snapshot.trim(), confirmed: gateWrites });
      if (!result.comment) throw new Error("Comment creation failed unexpectedly.");
      setComments((prev) => [...prev, { id: result.comment!.id, author: result.comment!.author, bodyMarkdown: result.comment!.bodyMarkdown, upvoteCount: result.comment!.upvoteCount, createdAt: result.comment!.createdAt, replies: [], repliesNextCursor: null }]);
      setNewCommentBody("");
    } catch (error) {
      setNewCommentError(error instanceof Error ? error.message : "Failed to post the comment.");
    } finally {
      setNewCommentPending(false);
    }
  }, [context, repo, discussion, newCommentBody, gateWrites, confirm]);

  const handlePostReply = useCallback(async (event: React.FormEvent, parentId: string) => {
    event.preventDefault();
    if (!discussion || !replyBody.trim()) return;
    if (gateWrites) {
      const proceed = await confirm({
        title: "Post reply?",
        message: "Post this reply?",
        confirmLabel: "Post reply",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
    }
    setReplyPending(true);
    setReplyError(undefined);
    const snapshot = replyBody;
    try {
      const result = await postDiscussionCommentRequest(context, { repo, discussionId: discussion.id, body: snapshot.trim(), replyToId: parentId, confirmed: gateWrites });
      if (!result.comment) throw new Error("Reply creation failed unexpectedly.");
      const created = result.comment;
      setComments((prev) =>
        prev.map((candidate) =>
          candidate.id === parentId
            ? { ...candidate, replies: [...candidate.replies, { id: created.id, author: created.author, bodyMarkdown: created.bodyMarkdown, upvoteCount: created.upvoteCount, createdAt: created.createdAt }] }
            : candidate,
        ),
      );
      setReplyBody("");
      setReplyingToId(null);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : "Failed to post the reply.");
    } finally {
      setReplyPending(false);
    }
  }, [context, repo, discussion, replyBody, gateWrites, confirm]);

  if (state === "loading") {
    return (
      <div className="discussion-detail discussion-detail--loading" role="status" data-testid="discussion-detail-loading">
        <Loader2 aria-hidden="true" className="discussion-detail__spinner" /> Loading discussion…
      </div>
    );
  }

  if (state === "error" || !discussion) {
    return (
      <div className="discussion-detail discussion-detail--error" role="alert" data-testid="discussion-detail-error">
        <AlertTriangle aria-hidden="true" /> {errorMessage ?? "Failed to load the discussion."}
      </div>
    );
  }

  return (
    <div className="discussion-detail" data-testid="discussion-detail-view">
      <header className="discussion-detail__header">
        {onBack ? (
          <button type="button" className="btn discussion-detail__back" onClick={onBack} data-testid="discussion-detail-back">
            <ArrowLeft aria-hidden="true" /> Back
          </button>
        ) : null}
        <div className="discussion-detail__title-row">
          <h2 className="discussion-detail__title">
            {discussion.title} <span className="discussion-detail__number">#{discussion.number}</span>
          </h2>
          <span className="discussion-detail__stat" data-testid="discussion-detail-upvotes">
            <ThumbsUp aria-hidden="true" /> {discussion.upvoteCount}
          </span>
          {discussion.categoryName ? (
            <span className="discussion-detail__category-chip">
              {discussion.categoryEmoji ? <span aria-hidden="true">{discussion.categoryEmoji}</span> : null}
              {discussion.categoryName}
            </span>
          ) : null}
          {discussion.isAnswerable ? (
            <span
              className={`discussion-detail__answered-badge${discussion.answerChosenAt ? " discussion-detail__answered-badge--answered" : ""}`}
              data-testid="discussion-detail-answered-badge"
            >
              {discussion.answerChosenAt ? <CheckCircle2 aria-hidden="true" /> : <HelpCircle aria-hidden="true" />}
              {discussion.answerChosenAt ? "Answered" : "Unanswered"}
            </span>
          ) : null}
        </div>
        <a href={discussion.url} target="_blank" rel="noreferrer noopener" className="discussion-detail__external-link" data-testid="discussion-detail-external-link">
          <ExternalLink aria-hidden="true" /> View on GitHub
        </a>
      </header>

      {errorMessage ? (
        <p className="discussion-detail__warning" role="alert" data-testid="discussion-detail-inline-error">
          <AlertTriangle aria-hidden="true" /> {errorMessage}
        </p>
      ) : null}

      <section className="discussion-detail__description" data-testid="discussion-detail-body">
        {discussion.bodyMarkdown.trim() ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{discussion.bodyMarkdown}</ReactMarkdown>
          </div>
        ) : (
          <p className="discussion-detail__empty-body" data-testid="discussion-detail-empty-body">No description provided.</p>
        )}
      </section>

      <section className="discussion-detail__comments" aria-labelledby="discussion-detail-comments-heading">
        <h3 id="discussion-detail-comments-heading" className="discussion-detail__section-title">
          Comments ({discussion.commentCount})
        </h3>

        {comments.length > 0 ? (
          <ul className="discussion-detail__comment-list">
            {comments.map((comment) => (
              <li key={comment.id} className="discussion-detail__comment" data-testid={`discussion-detail-comment-${comment.id}`}>
                <div className="discussion-detail__comment-header">
                  <span className="discussion-detail__comment-author">{comment.author?.login ?? "Unknown"}</span>
                  <span className="discussion-detail__comment-stat">
                    <ThumbsUp aria-hidden="true" /> {comment.upvoteCount}
                  </span>
                  <span className="discussion-detail__comment-time">{formatTimestamp(comment.createdAt)}</span>
                </div>
                <div className="discussion-detail__comment-body markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.bodyMarkdown || "_No content._"}</ReactMarkdown>
                </div>

                {comment.replies.length > 0 ? (
                  <ul className="discussion-detail__reply-list" data-testid={`discussion-detail-replies-${comment.id}`}>
                    {comment.replies.map((reply) => (
                      <ReplyItem key={reply.id} reply={reply} />
                    ))}
                  </ul>
                ) : null}

                {comment.repliesNextCursor !== null ? (
                  <button
                    type="button"
                    className="btn discussion-detail__load-more discussion-detail__load-more--replies"
                    onClick={() => handleLoadMoreReplies(comment)}
                    disabled={loadingMoreRepliesFor === comment.id}
                    data-testid={`discussion-detail-load-more-replies-${comment.id}`}
                  >
                    {loadingMoreRepliesFor === comment.id ? <Loader2 aria-hidden="true" className="discussion-detail__spinner" /> : null}
                    {loadingMoreRepliesFor === comment.id ? "Loading…" : "Load more replies"}
                  </button>
                ) : null}

                {replyingToId === comment.id ? (
                  <form onSubmit={(event) => handlePostReply(event, comment.id)} className="discussion-detail__reply-form">
                    <label className="discussion-detail__field">
                      <span>Reply</span>
                      <textarea
                        value={replyBody}
                        onChange={(event) => setReplyBody(event.target.value)}
                        disabled={replyPending}
                        data-testid={`discussion-detail-reply-body-${comment.id}`}
                      />
                    </label>
                    <div className="discussion-detail__reply-form-actions">
                      <button type="submit" className="btn btn-primary" disabled={replyPending || !replyBody.trim()} data-testid={`discussion-detail-reply-submit-${comment.id}`}>
                        {replyPending ? "Posting…" : "Post reply"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setReplyingToId(null);
                          setReplyBody("");
                          setReplyError(undefined);
                        }}
                        disabled={replyPending}
                      >
                        Cancel
                      </button>
                    </div>
                    {replyError ? <p className="discussion-detail__warning" role="alert">{replyError}</p> : null}
                  </form>
                ) : (
                  <button
                    type="button"
                    className="btn discussion-detail__reply-toggle"
                    onClick={() => {
                      setReplyingToId(comment.id);
                      setReplyBody("");
                      setReplyError(undefined);
                    }}
                    data-testid={`discussion-detail-reply-toggle-${comment.id}`}
                  >
                    <MessageSquarePlus aria-hidden="true" /> Reply
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="discussion-detail__guidance" data-testid="discussion-detail-no-comments">No comments yet.</p>
        )}

        {commentsNextCursor !== null ? (
          <button
            type="button"
            className="btn discussion-detail__load-more"
            onClick={handleLoadMoreComments}
            disabled={loadingMoreComments}
            data-testid="discussion-detail-load-more-comments"
          >
            {loadingMoreComments ? <Loader2 aria-hidden="true" className="discussion-detail__spinner" /> : null}
            {loadingMoreComments ? "Loading…" : "Load more comments"}
          </button>
        ) : null}

        <form onSubmit={handlePostComment} className="discussion-detail__composer">
          <label className="discussion-detail__field">
            <span>Add a comment</span>
            <textarea
              value={newCommentBody}
              onChange={(event) => setNewCommentBody(event.target.value)}
              disabled={newCommentPending}
              data-testid="discussion-detail-composer-body"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={newCommentPending || !newCommentBody.trim()} data-testid="discussion-detail-composer-submit">
            {newCommentPending ? "Posting…" : <><MessageSquarePlus aria-hidden="true" /> Post comment</>}
          </button>
          {newCommentError ? <p className="discussion-detail__warning" role="alert" data-testid="discussion-detail-composer-error">{newCommentError}</p> : null}
        </form>
      </section>
    </div>
  );
}

export default DiscussionDetailView;
