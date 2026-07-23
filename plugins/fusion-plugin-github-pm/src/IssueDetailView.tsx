import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, ArrowLeft, ExternalLink, Loader2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import "./IssueDetailView.css";

/*
FNXC:GithubPmIssues 2026-07-24-01:20:
FUSI-013's sole issue-detail rendering surface. Mount seam: `{ context, repo,
issueNumber, onBack? }` -- FUSI-008's tabbed Issues shell and FUSI-012's issue list
will mount this component once issue selection exists; do NOT fork a second detail
panel. `onBack` is optional so this component works both as a standalone route target
and as a panel pushed onto a list (the back affordance only renders when a caller
supplies a callback).

Comment pagination is LAZY: only the first page ships with GET /issues/detail; each
"Load more comments" click issues one GET /issues/comments?page= call and appends the
result. The button is removed (not disabled) once `nextPage` becomes null, and is never
rendered at all for a zero-comment issue -- no orphaned/disabled shell survives either
transition. Sidebar sections (labels/assignees/milestone) are omitted entirely, not
rendered as empty shells, when the corresponding data is absent.
*/

interface IssueUser {
  login: string;
  avatarUrl?: string;
}

interface IssueLabel {
  name: string;
  color: string;
  description?: string | null;
}

interface IssueMilestone {
  title: string;
  state: string;
  dueOn?: string | null;
}

interface IssueDetail {
  number: number;
  title: string;
  state: "open" | "closed";
  bodyMarkdown: string;
  htmlUrl: string;
  author: IssueUser | null;
  createdAt?: string;
  updatedAt?: string;
  labels: IssueLabel[];
  assignees: IssueUser[];
  milestone: IssueMilestone | null;
  commentCount: number;
}

interface IssueComment {
  id: number;
  author: IssueUser | null;
  bodyMarkdown: string;
  createdAt?: string;
  updatedAt?: string;
}

type TimelineEventType = "closed" | "reopened" | "labeled" | "unlabeled" | "referenced" | "cross-referenced";

interface TimelineEvent {
  id: string;
  event: TimelineEventType;
  actor?: IssueUser;
  createdAt?: string;
  label?: { name: string; color: string };
  source?: { issueNumber?: number; htmlUrl?: string };
}

interface IssueDetailResponse {
  ok?: boolean;
  error?: string;
  repo?: string;
  issue?: IssueDetail;
  timeline?: TimelineEvent[];
  comments?: IssueComment[];
  commentsNextPage?: number | null;
}

interface IssueCommentsResponse {
  ok?: boolean;
  error?: string;
  comments?: IssueComment[];
  nextPage?: number | null;
}

type ViewState = "loading" | "ready" | "error";

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

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

async function loadIssueDetail(context: PluginDashboardViewContext | undefined, repo: string, issueNumber: number): Promise<IssueDetailResponse> {
  return fetchJson<IssueDetailResponse>(`${PLUGIN_BASE}/issues/detail${projectQuery(context, { repo, number: String(issueNumber) })}`);
}

async function loadIssueCommentsPage(context: PluginDashboardViewContext | undefined, repo: string, issueNumber: number, page: number): Promise<IssueCommentsResponse> {
  return fetchJson<IssueCommentsResponse>(`${PLUGIN_BASE}/issues/comments${projectQuery(context, { repo, number: String(issueNumber), page: String(page) })}`);
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function StateBadge({ state }: { state: "open" | "closed" }) {
  return (
    <span
      className={`issue-detail__state-badge issue-detail__state-badge--${state}`}
      data-testid="issue-detail-state-badge"
    >
      {state === "open" ? "Open" : "Closed"}
    </span>
  );
}

function LabelChip({ label }: { label: IssueLabel }) {
  const color = label.color ? `#${label.color.replace(/^#/, "")}` : undefined;
  return (
    <span
      className="issue-detail__label-chip"
      style={color ? { borderColor: color, color } : undefined}
      data-testid={`issue-detail-label-${label.name}`}
    >
      {label.name}
    </span>
  );
}

const TIMELINE_EVENT_COPY: Record<TimelineEventType, string> = {
  closed: "closed this issue",
  reopened: "reopened this issue",
  labeled: "added a label",
  unlabeled: "removed a label",
  referenced: "referenced this issue",
  "cross-referenced": "mentioned this issue",
};

function TimelineItem({ event }: { event: TimelineEvent }) {
  const actorLogin = event.actor?.login ?? "Someone";
  const detail = event.event === "labeled" || event.event === "unlabeled"
    ? event.label
      ? ` "${event.label.name}"`
      : ""
    : event.event === "cross-referenced" && event.source?.issueNumber
      ? ` (#${event.source.issueNumber})`
      : "";
  return (
    <li className="issue-detail__timeline-item" data-testid={`issue-detail-timeline-${event.id}`}>
      <span className="issue-detail__timeline-actor">{actorLogin}</span>{" "}
      <span className="issue-detail__timeline-copy">{TIMELINE_EVENT_COPY[event.event]}{detail}</span>{" "}
      <span className="issue-detail__timeline-time">{formatTimestamp(event.createdAt)}</span>
    </li>
  );
}

function CommentItem({ comment }: { comment: IssueComment }) {
  return (
    <li className="issue-detail__comment" data-testid={`issue-detail-comment-${comment.id}`}>
      <div className="issue-detail__comment-header">
        <span className="issue-detail__comment-author">{comment.author?.login ?? "Unknown"}</span>
        <span className="issue-detail__comment-time">{formatTimestamp(comment.createdAt)}</span>
      </div>
      <div className="issue-detail__comment-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{comment.bodyMarkdown || "_No content._"}</ReactMarkdown>
      </div>
    </li>
  );
}

export interface IssueDetailViewProps {
  context?: PluginDashboardViewContext;
  repo: string;
  issueNumber: number;
  onBack?: () => void;
}

export function IssueDetailView({ context, repo, issueNumber, onBack }: IssueDetailViewProps) {
  const [state, setState] = useState<ViewState>("loading");
  const [issue, setIssue] = useState<IssueDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();

  const load = useCallback(async () => {
    setState("loading");
    setErrorMessage(undefined);
    try {
      const result = await loadIssueDetail(context, repo, issueNumber);
      setIssue(result.issue ?? null);
      setTimeline(result.timeline ?? []);
      setComments(result.comments ?? []);
      setNextPage(result.commentsNextPage ?? null);
      setState("ready");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load the issue.");
      setState("error");
    }
  }, [context, repo, issueNumber]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLoadMore = useCallback(async () => {
    if (nextPage === null) return;
    setLoadingMore(true);
    try {
      const result = await loadIssueCommentsPage(context, repo, issueNumber, nextPage);
      setComments((prev) => [...prev, ...(result.comments ?? [])]);
      setNextPage(result.nextPage ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load more comments.");
    } finally {
      setLoadingMore(false);
    }
  }, [context, repo, issueNumber, nextPage]);

  if (state === "loading") {
    return (
      <div className="issue-detail issue-detail--loading" role="status" data-testid="issue-detail-loading">
        <Loader2 aria-hidden="true" className="issue-detail__spinner" /> Loading issue…
      </div>
    );
  }

  if (state === "error" || !issue) {
    return (
      <div className="issue-detail issue-detail--error" role="alert" data-testid="issue-detail-error">
        <AlertTriangle aria-hidden="true" /> {errorMessage ?? "Failed to load the issue."}
      </div>
    );
  }

  return (
    <div className="issue-detail" data-testid="issue-detail-view">
      <header className="issue-detail__header">
        {onBack ? (
          <button type="button" className="btn issue-detail__back" onClick={onBack} data-testid="issue-detail-back">
            <ArrowLeft aria-hidden="true" /> Back
          </button>
        ) : null}
        <div className="issue-detail__title-row">
          <h2 className="issue-detail__title">
            {issue.title} <span className="issue-detail__number">#{issue.number}</span>
          </h2>
          <StateBadge state={issue.state} />
        </div>
        <a
          href={issue.htmlUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="issue-detail__external-link"
          data-testid="issue-detail-external-link"
        >
          <ExternalLink aria-hidden="true" /> View on GitHub
        </a>
      </header>

      {errorMessage ? (
        <p className="issue-detail__warning" role="alert" data-testid="issue-detail-inline-error">
          <AlertTriangle aria-hidden="true" /> {errorMessage}
        </p>
      ) : null}

      <div className="issue-detail__body-layout">
        <div className="issue-detail__main">
          <section className="issue-detail__description" data-testid="issue-detail-body">
            {issue.bodyMarkdown.trim() ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{issue.bodyMarkdown}</ReactMarkdown>
              </div>
            ) : (
              <p className="issue-detail__empty-body" data-testid="issue-detail-empty-body">No description provided.</p>
            )}
          </section>

          <section className="issue-detail__comments" aria-labelledby="issue-detail-comments-heading">
            <h3 id="issue-detail-comments-heading" className="issue-detail__section-title">
              Comments ({issue.commentCount})
            </h3>
            {comments.length > 0 ? (
              <ul className="issue-detail__comment-list">
                {comments.map((comment) => (
                  <CommentItem key={comment.id} comment={comment} />
                ))}
              </ul>
            ) : (
              <p className="issue-detail__guidance" data-testid="issue-detail-no-comments">No comments yet.</p>
            )}
            {nextPage !== null ? (
              <button
                type="button"
                className="btn issue-detail__load-more"
                onClick={handleLoadMore}
                disabled={loadingMore}
                data-testid="issue-detail-load-more"
              >
                {loadingMore ? <Loader2 aria-hidden="true" className="issue-detail__spinner" /> : null}
                {loadingMore ? "Loading…" : "Load more comments"}
              </button>
            ) : null}
          </section>

          {timeline.length > 0 ? (
            <section className="issue-detail__timeline" aria-labelledby="issue-detail-timeline-heading">
              <h3 id="issue-detail-timeline-heading" className="issue-detail__section-title">Timeline</h3>
              <ul className="issue-detail__timeline-list">
                {timeline.map((event) => (
                  <TimelineItem key={event.id} event={event} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <aside className="issue-detail__sidebar" data-testid="issue-detail-sidebar">
          <div className="issue-detail__sidebar-section">
            <h4 className="issue-detail__sidebar-heading">State</h4>
            <StateBadge state={issue.state} />
          </div>

          {issue.author ? (
            <div className="issue-detail__sidebar-section" data-testid="issue-detail-sidebar-author">
              <h4 className="issue-detail__sidebar-heading">Author</h4>
              <p className="issue-detail__sidebar-value">{issue.author.login}</p>
            </div>
          ) : null}

          {issue.labels.length > 0 ? (
            <div className="issue-detail__sidebar-section" data-testid="issue-detail-sidebar-labels">
              <h4 className="issue-detail__sidebar-heading">Labels</h4>
              <div className="issue-detail__label-list">
                {issue.labels.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))}
              </div>
            </div>
          ) : null}

          {issue.assignees.length > 0 ? (
            <div className="issue-detail__sidebar-section" data-testid="issue-detail-sidebar-assignees">
              <h4 className="issue-detail__sidebar-heading">Assignees</h4>
              <p className="issue-detail__sidebar-value">{issue.assignees.map((assignee) => assignee.login).join(", ")}</p>
            </div>
          ) : null}

          {issue.milestone ? (
            <div className="issue-detail__sidebar-section" data-testid="issue-detail-sidebar-milestone">
              <h4 className="issue-detail__sidebar-heading">Milestone</h4>
              <p className="issue-detail__sidebar-value">
                {issue.milestone.title} ({issue.milestone.state})
                {issue.milestone.dueOn ? ` — due ${formatTimestamp(issue.milestone.dueOn)}` : ""}
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

export default IssueDetailView;
