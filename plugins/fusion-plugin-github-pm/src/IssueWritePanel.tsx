import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, MessageSquarePlus, PenLine, PlusCircle, XCircle } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useConfirm } from "@fusion/dashboard/app/hooks/useConfirm";
import { IssueDetailView } from "./IssueDetailView.js";
import { notifyIssuesChanged } from "./issues-events.js";
import "./IssueWritePanel.css";

/*
FNXC:GithubPmIssues 2026-07-24-05:30:
FUSI-014's sole issue-WRITE surface. Mounted once in GitHubPmView.tsx (inside the issues
tabpanel, alongside IssuesPanel). Self-contained: the operator either fills the "New issue"
form or types an issue number into the selector -- there is no dependency on list-to-detail
selection wiring from IssuesPanel/IssueDetailView (that integration is a later task).

Two hard requirements this component must never skip (see PROMPT.md "Do NOT"):
1. REUSE IssueDetailView to render the selected issue's full state/comments/timeline --
   never fork a second issue-loading/rendering UI. `detailRefreshNonce` is bumped after
   every successful write so IssueDetailView remounts (via `key`) and reloads GitHub's
   authoritative post-write state.
2. Emit `notifyIssuesChanged({ repo, issueNumber, kind })` after EVERY successful write
   (never on failure, never from anywhere but here) so the already-mounted, already-
   subscribed IssuesPanel re-fetches its current page instead of going stale.

Optimistic-update contract: each write snapshots prior local state, applies the optimistic
change immediately, then calls the plugin route. On success the optimistic value is replaced
by GitHub's authoritative returned object. On failure the snapshot is restored verbatim and
an aria-live error banner renders the route's message -- notifyIssuesChanged is NOT called
on failure. Controls are disabled while their own write is pending.
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

interface WriteIssue {
  number: number;
  title: string;
  bodyMarkdown: string;
  state: "open" | "closed";
}

interface IssueDetailRouteResponse {
  ok?: boolean;
  error?: string;
  issue?: { number: number; title: string; state: "open" | "closed"; bodyMarkdown: string };
}

interface IssueWriteResponse {
  ok?: boolean;
  error?: string;
  issue?: { number: number; title: string; state: "open" | "closed"; bodyMarkdown: string };
}

interface CommentWriteResponse {
  ok?: boolean;
  error?: string;
  comment?: { id: number; bodyMarkdown: string };
}

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

async function loadIssueForEdit(context: PluginDashboardViewContext | undefined, repo: string, number: number): Promise<WriteIssue> {
  const result = await fetchJson<IssueDetailRouteResponse>(`${PLUGIN_BASE}/issues/detail${projectQuery(context, { repo, number: String(number) })}`);
  if (!result.issue) throw new Error("Issue not found.");
  return { number: result.issue.number, title: result.issue.title, bodyMarkdown: result.issue.bodyMarkdown, state: result.issue.state };
}

/*
FNXC:GithubPmWriteGate 2026-07-24-06:30:
FUSI-017: each write dispatcher below accepts an explicit `confirmed` boolean, forwarded into
the request body only when true. The CALLER (the component below) decides whether to await
the confirm dialog before invoking these -- these functions never show a dialog themselves,
keeping the confirm-vs-dispatch decision and the actual network call cleanly separated.
*/
async function createIssue(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  input: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number },
  confirmed: boolean,
): Promise<WriteIssue> {
  const result = await fetchJson<IssueWriteResponse>(`${PLUGIN_BASE}/issues/create${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, ...input, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.issue) throw new Error("Issue creation failed unexpectedly.");
  return { number: result.issue.number, title: result.issue.title, bodyMarkdown: result.issue.bodyMarkdown, state: result.issue.state };
}

async function updateIssue(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  number: number,
  patch: { title?: string; body?: string },
  confirmed: boolean,
): Promise<WriteIssue> {
  const result = await fetchJson<IssueWriteResponse>(`${PLUGIN_BASE}/issues/update${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, ...patch, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.issue) throw new Error("Issue update failed unexpectedly.");
  return { number: result.issue.number, title: result.issue.title, bodyMarkdown: result.issue.bodyMarkdown, state: result.issue.state };
}

async function setIssueState(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  number: number,
  state: "open" | "closed",
  stateReason: "completed" | "not_planned" | undefined,
  confirmed: boolean,
): Promise<WriteIssue> {
  const result = await fetchJson<IssueWriteResponse>(`${PLUGIN_BASE}/issues/state${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, state, stateReason, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.issue) throw new Error("Issue state change failed unexpectedly.");
  return { number: result.issue.number, title: result.issue.title, bodyMarkdown: result.issue.bodyMarkdown, state: result.issue.state };
}

async function createComment(context: PluginDashboardViewContext | undefined, repo: string, number: number, body: string, confirmed: boolean): Promise<void> {
  const result = await fetchJson<CommentWriteResponse>(`${PLUGIN_BASE}/issues/comments${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, body, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.comment) throw new Error("Comment creation failed unexpectedly.");
}

function splitCsv(value: string): string[] | undefined {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p className="issue-write-panel__error" role="alert" aria-live="assertive" data-testid="issue-write-error">
      <AlertTriangle aria-hidden="true" /> {message}
    </p>
  );
}

/*
FNXC:GithubPmWriteGate 2026-07-24-06:30:
FUSI-017: `confirmWrites` defaults to `true` (ON) when the prop is omitted/undefined, so a
parent that fails to thread the /status flag (stale server, network hiccup) never silently
un-gates the UI. The parent (GitHubPmView.tsx) reads the resolved value from GET /status and
passes it down explicitly once loaded.
*/
export function IssueWritePanel({ context, repo, confirmWrites }: { context?: PluginDashboardViewContext; repo: string | null; confirmWrites?: boolean }) {
  const gateWrites = confirmWrites !== false;
  const { confirm } = useConfirm();
  // "New issue" form state.
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createLabels, setCreateLabels] = useState("");
  const [createAssignees, setCreateAssignees] = useState("");
  const [createMilestone, setCreateMilestone] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string>();
  // Optimistic session-local record of issues created from this panel, so the create flow is
  // independently verifiable (append -> reconcile -> rollback) without depending on IssuesPanel.
  const [createdIssues, setCreatedIssues] = useState<WriteIssue[]>([]);

  // Issue selector + edit/comment/state surfaces.
  const [numberInput, setNumberInput] = useState("");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<WriteIssue | null>(null);
  const [selectLoading, setSelectLoading] = useState(false);
  const [selectError, setSelectError] = useState<string>();

  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string>();

  const [commentBody, setCommentBody] = useState("");
  const [commentPending, setCommentPending] = useState(false);
  const [commentError, setCommentError] = useState<string>();

  const [closeReason, setCloseReason] = useState<"completed" | "not_planned">("completed");
  const [statePending, setStatePending] = useState(false);
  const [stateError, setStateError] = useState<string>();

  const [detailRefreshNonce, setDetailRefreshNonce] = useState(0);

  const loadSelected = useCallback(async (number: number) => {
    if (!repo) return;
    setSelectLoading(true);
    setSelectError(undefined);
    try {
      const issue = await loadIssueForEdit(context, repo, number);
      setSelectedIssue(issue);
      setEditTitle(issue.title);
      setEditBody(issue.bodyMarkdown);
    } catch (error) {
      setSelectedIssue(null);
      setSelectError(error instanceof Error ? error.message : "Failed to load the issue.");
    } finally {
      setSelectLoading(false);
    }
  }, [context, repo]);

  useEffect(() => {
    setSelectedIssue(null);
    setSelectedNumber(null);
    setNumberInput("");
  }, [repo]);

  const handleSelectIssue = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const parsed = Number.parseInt(numberInput, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setSelectError("Enter a positive issue number.");
      return;
    }
    setSelectedNumber(parsed);
    loadSelected(parsed);
  }, [numberInput, loadSelected]);

  const handleCreate = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repo || !createTitle.trim()) return;
    /*
    FNXC:GithubPmWriteGate 2026-07-24-06:30:
    FUSI-017: gate BEFORE any pending/optimistic state change. Cancel returns here with ZERO
    mutations, ZERO optimistic state, and ZERO notifyIssuesChanged -- the snapshot below is
    never touched on cancel.
    */
    if (gateWrites) {
      const proceed = await confirm({
        title: "Create issue?",
        message: `Create a new issue "${createTitle.trim()}" on ${repo}?`,
        confirmLabel: "Create issue",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
    }
    setCreatePending(true);
    setCreateError(undefined);
    const snapshot = createdIssues;
    const tempNumber = -Date.now();
    const optimistic: WriteIssue = { number: tempNumber, title: createTitle.trim(), bodyMarkdown: createBody, state: "open" };
    setCreatedIssues([...snapshot, optimistic]);
    try {
      const created = await createIssue(context, repo, {
        title: createTitle.trim(),
        body: createBody.trim() || undefined,
        labels: splitCsv(createLabels),
        assignees: splitCsv(createAssignees),
        milestone: createMilestone.trim() ? Number.parseInt(createMilestone, 10) : undefined,
      }, gateWrites);
      setCreatedIssues((prev) => prev.map((issue) => (issue.number === tempNumber ? created : issue)));
      notifyIssuesChanged({ repo, issueNumber: created.number, kind: "created" });
      setSelectedNumber(created.number);
      setSelectedIssue(created);
      setEditTitle(created.title);
      setEditBody(created.bodyMarkdown);
      setDetailRefreshNonce((prev) => prev + 1);
      setCreateTitle("");
      setCreateBody("");
      setCreateLabels("");
      setCreateAssignees("");
      setCreateMilestone("");
    } catch (error) {
      setCreatedIssues(snapshot);
      setCreateError(error instanceof Error ? error.message : "Failed to create the issue.");
    } finally {
      setCreatePending(false);
    }
  }, [context, repo, createTitle, createBody, createLabels, createAssignees, createMilestone, createdIssues, gateWrites, confirm]);

  const handleEdit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repo || selectedNumber === null || !selectedIssue) return;
    if (gateWrites) {
      const proceed = await confirm({
        title: "Save issue edit?",
        message: `Save edits to issue #${selectedNumber} on ${repo}?`,
        confirmLabel: "Save edit",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
    }
    setEditPending(true);
    setEditError(undefined);
    const snapshot = selectedIssue;
    setSelectedIssue({ ...snapshot, title: editTitle, bodyMarkdown: editBody });
    try {
      const updated = await updateIssue(context, repo, selectedNumber, { title: editTitle, body: editBody }, gateWrites);
      setSelectedIssue(updated);
      notifyIssuesChanged({ repo, issueNumber: selectedNumber, kind: "updated" });
      setDetailRefreshNonce((prev) => prev + 1);
    } catch (error) {
      setSelectedIssue(snapshot);
      setEditTitle(snapshot.title);
      setEditBody(snapshot.bodyMarkdown);
      setEditError(error instanceof Error ? error.message : "Failed to update the issue.");
    } finally {
      setEditPending(false);
    }
  }, [context, repo, selectedNumber, selectedIssue, editTitle, editBody, gateWrites, confirm]);

  const handleComment = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!repo || selectedNumber === null || !commentBody.trim()) return;
    if (gateWrites) {
      const proceed = await confirm({
        title: "Add comment?",
        message: `Add this comment to issue #${selectedNumber} on ${repo}?`,
        confirmLabel: "Add comment",
        cancelLabel: "Cancel",
      });
      if (!proceed) return;
    }
    setCommentPending(true);
    setCommentError(undefined);
    const snapshot = commentBody;
    setCommentBody("");
    try {
      await createComment(context, repo, selectedNumber, snapshot.trim(), gateWrites);
      notifyIssuesChanged({ repo, issueNumber: selectedNumber, kind: "commented" });
      setDetailRefreshNonce((prev) => prev + 1);
    } catch (error) {
      setCommentBody(snapshot);
      setCommentError(error instanceof Error ? error.message : "Failed to add the comment.");
    } finally {
      setCommentPending(false);
    }
  }, [context, repo, selectedNumber, commentBody, gateWrites, confirm]);

  const handleSetState = useCallback(async (targetState: "open" | "closed") => {
    if (!repo || selectedNumber === null || !selectedIssue) return;
    if (gateWrites) {
      const proceed = await confirm({
        title: targetState === "closed" ? "Close issue?" : "Reopen issue?",
        message: `${targetState === "closed" ? "Close" : "Reopen"} issue #${selectedNumber} on ${repo}?`,
        confirmLabel: targetState === "closed" ? "Close issue" : "Reopen issue",
        cancelLabel: "Cancel",
        danger: targetState === "closed",
      });
      if (!proceed) return;
    }
    setStatePending(true);
    setStateError(undefined);
    const snapshot = selectedIssue;
    setSelectedIssue({ ...snapshot, state: targetState });
    try {
      const updated = await setIssueState(context, repo, selectedNumber, targetState, targetState === "closed" ? closeReason : undefined, gateWrites);
      setSelectedIssue(updated);
      notifyIssuesChanged({ repo, issueNumber: selectedNumber, kind: targetState === "closed" ? "closed" : "reopened" });
      setDetailRefreshNonce((prev) => prev + 1);
    } catch (error) {
      setSelectedIssue(snapshot);
      setStateError(error instanceof Error ? error.message : "Failed to change the issue's state.");
    } finally {
      setStatePending(false);
    }
  }, [context, repo, selectedNumber, selectedIssue, closeReason, gateWrites, confirm]);

  if (!repo) {
    return (
      <div className="issue-write-panel" data-testid="issue-write-panel">
        <p className="issue-write-panel__empty-state" data-testid="issue-write-panel-no-repo">
          Select a repository to create, edit, comment on, or close/reopen issues.
        </p>
      </div>
    );
  }

  return (
    <div className="issue-write-panel" data-testid="issue-write-panel">
      <section className="issue-write-panel__section" aria-labelledby="issue-write-create-heading">
        <h3 id="issue-write-create-heading" className="issue-write-panel__section-title">
          <PlusCircle aria-hidden="true" /> New issue
        </h3>
        <form onSubmit={handleCreate} className="issue-write-panel__form">
          <label className="issue-write-panel__field">
            <span>Title</span>
            <input
              type="text"
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              required
              disabled={createPending}
              data-testid="issue-write-create-title"
            />
          </label>
          <label className="issue-write-panel__field">
            <span>Body</span>
            <textarea value={createBody} onChange={(event) => setCreateBody(event.target.value)} disabled={createPending} data-testid="issue-write-create-body" />
          </label>
          <label className="issue-write-panel__field">
            <span>Labels (comma-separated)</span>
            <input type="text" value={createLabels} onChange={(event) => setCreateLabels(event.target.value)} disabled={createPending} />
          </label>
          <label className="issue-write-panel__field">
            <span>Assignees (comma-separated)</span>
            <input type="text" value={createAssignees} onChange={(event) => setCreateAssignees(event.target.value)} disabled={createPending} />
          </label>
          <label className="issue-write-panel__field">
            <span>Milestone number</span>
            <input type="number" value={createMilestone} onChange={(event) => setCreateMilestone(event.target.value)} disabled={createPending} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={createPending || !createTitle.trim()} data-testid="issue-write-create-submit">
            {createPending ? <Loader2 aria-hidden="true" className="issue-write-panel__spinner" /> : <PlusCircle aria-hidden="true" />}
            {createPending ? "Creating…" : "Create issue"}
          </button>
        </form>
        {createError ? <ErrorBanner message={createError} /> : null}
        {createdIssues.length > 0 ? (
          <ul className="issue-write-panel__created-list" data-testid="issue-write-created-list">
            {createdIssues.map((issue) => (
              <li key={issue.number} data-testid={`issue-write-created-${issue.number}`}>
                {issue.number < 0 ? <Loader2 aria-hidden="true" className="issue-write-panel__spinner" /> : <CheckCircle2 aria-hidden="true" />}
                {issue.number < 0 ? `Creating "${issue.title}"…` : `#${issue.number} ${issue.title}`}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="issue-write-panel__section" aria-labelledby="issue-write-select-heading">
        <h3 id="issue-write-select-heading" className="issue-write-panel__section-title">
          <PenLine aria-hidden="true" /> Edit / comment / close / reopen
        </h3>
        <form onSubmit={handleSelectIssue} className="issue-write-panel__select-form">
          <label className="issue-write-panel__field">
            <span>Issue number</span>
            <input
              type="number"
              value={numberInput}
              onChange={(event) => setNumberInput(event.target.value)}
              data-testid="issue-write-select-number"
            />
          </label>
          <button type="submit" className="btn" disabled={selectLoading} data-testid="issue-write-select-submit">
            {selectLoading ? "Loading…" : "Load issue"}
          </button>
        </form>
        {selectError ? <ErrorBanner message={selectError} /> : null}

        {selectedIssue && selectedNumber !== null ? (
          <div className="issue-write-panel__selected" data-testid="issue-write-selected">
            <form onSubmit={handleEdit} className="issue-write-panel__form">
              <label className="issue-write-panel__field">
                <span>Title</span>
                <input type="text" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={editPending} data-testid="issue-write-edit-title" />
              </label>
              <label className="issue-write-panel__field">
                <span>Body</span>
                <textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} disabled={editPending} data-testid="issue-write-edit-body" />
              </label>
              <button type="submit" className="btn btn-primary" disabled={editPending} data-testid="issue-write-edit-submit">
                {editPending ? "Saving…" : "Save edit"}
              </button>
            </form>
            {editError ? <ErrorBanner message={editError} /> : null}

            <form onSubmit={handleComment} className="issue-write-panel__form">
              <label className="issue-write-panel__field">
                <span>Comment</span>
                <textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} disabled={commentPending} data-testid="issue-write-comment-body" />
              </label>
              <button type="submit" className="btn" disabled={commentPending || !commentBody.trim()} data-testid="issue-write-comment-submit">
                {commentPending ? "Commenting…" : <><MessageSquarePlus aria-hidden="true" /> Add comment</>}
              </button>
            </form>
            {commentError ? <ErrorBanner message={commentError} /> : null}

            <div className="issue-write-panel__state-controls">
              {selectedIssue.state === "open" ? (
                <>
                  <label className="issue-write-panel__field issue-write-panel__field--inline">
                    <span>Close reason</span>
                    <select value={closeReason} onChange={(event) => setCloseReason(event.target.value as "completed" | "not_planned")} disabled={statePending}>
                      <option value="completed">Completed</option>
                      <option value="not_planned">Not planned</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn issue-write-panel__close-button"
                    onClick={() => handleSetState("closed")}
                    disabled={statePending}
                    data-testid="issue-write-close"
                  >
                    <XCircle aria-hidden="true" /> {statePending ? "Closing…" : "Close issue"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn issue-write-panel__reopen-button"
                  onClick={() => handleSetState("open")}
                  disabled={statePending}
                  data-testid="issue-write-reopen"
                >
                  <CheckCircle2 aria-hidden="true" /> {statePending ? "Reopening…" : "Reopen issue"}
                </button>
              )}
            </div>
            {stateError ? <ErrorBanner message={stateError} /> : null}

            <div className="issue-write-panel__detail-mount" data-testid="issue-write-detail-mount">
              <IssueDetailView key={detailRefreshNonce} context={context} repo={repo} issueNumber={selectedNumber} />
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default IssueWritePanel;
