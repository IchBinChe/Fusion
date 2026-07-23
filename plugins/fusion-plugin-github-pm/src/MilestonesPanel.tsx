import { useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, PenLine, PlusCircle, Trash2, XCircle } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useConfirm } from "@fusion/dashboard/app/hooks/useConfirm";
import "./MilestonesPanel.css";

/*
FNXC:GithubPmMilestones 2026-07-25-01:20:
KB-003's sole milestones-management surface: mounted into GitHubPmView.tsx's `milestones`
tabpanel with `{ repo, context, confirmWrites }`, mirroring IssuesPanel/IssueWritePanel's props
shape. Fetches the full open+closed milestone list on repo change via `GET /milestones/list`
and re-fetches after every successful write (mirrors IssueWritePanel's re-fetch-on-success
contract; there is no separate live-update pub/sub for milestones the way issues has
`notifyIssuesChanged`, since milestones only change from within this panel today).

PROGRESS-RATIO CONTRACT (acceptance-critical): each milestone's progress percentage MUST equal
exactly `closedIssues / (openIssues + closedIssues)` -- the same ratio GitHub's own milestone
page renders -- rounded for display only. A milestone with zero issues renders a DEFINED "No
issues" / 0% state, never `NaN%`.

OVERDUE-FLAG CONTRACT (acceptance-critical): a milestone is flagged overdue if and only if it
is OPEN, has a due date, and that due date is in the past. Closed milestones and milestones
with no due date are NEVER flagged overdue, regardless of the date.

CLOSE-WITH-OPEN-ISSUES CONTRACT (acceptance-critical): closing a milestone that still has open
issues never closes silently. It surfaces an inline prompt naming the open-issue count and
offering (a) close and leave the open issues assigned (the default), (b) clear the milestone
from those open issues, or (c) move them to another selected milestone -- (b)/(c) dispatch
`POST /milestones/reassign-open-issues` before the close PATCH. A milestone with zero open
issues closes directly, without the prompt.
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

interface MilestoneRow {
  number: number;
  title: string;
  state: string;
  description?: string | null;
  openIssues: number;
  closedIssues: number;
  dueOn?: string | null;
  htmlUrl?: string;
}

interface MilestonesListResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  items?: MilestoneRow[];
}

interface MilestoneWriteResponse {
  ok?: boolean;
  error?: string;
  milestone?: MilestoneRow;
}

interface MilestoneDeleteResponse {
  ok?: boolean;
  error?: string;
  number?: number;
}

interface MilestoneReassignResponse {
  ok?: boolean;
  error?: string;
  reassignedCount?: number;
}

type PanelDataState = "loading" | "ready" | "error";
type ReassignMode = "keep" | "clear" | "move";

function projectQuery(context: PluginDashboardViewContext | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...(context?.projectId ? { projectId: context.projectId } : {}), ...extra });
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `Request failed with status ${res.status}.`);
  }
  return json;
}

async function fetchMilestonesList(context: PluginDashboardViewContext | undefined, repo: string): Promise<MilestonesListResponse> {
  return fetchJson<MilestonesListResponse>(`${PLUGIN_BASE}/milestones/list${projectQuery(context, { repo, state: "all" })}`);
}

async function postCreateMilestone(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  input: { title: string; description?: string; dueOn?: string },
  confirmed: boolean,
): Promise<MilestoneRow> {
  const result = await fetchJson<MilestoneWriteResponse>(`${PLUGIN_BASE}/milestones/create${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, ...input, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.milestone) throw new Error("Milestone creation failed unexpectedly.");
  return result.milestone;
}

async function putUpdateMilestone(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  number: number,
  patch: { title?: string; description?: string; dueOn?: string | null },
  confirmed: boolean,
): Promise<MilestoneRow> {
  const result = await fetchJson<MilestoneWriteResponse>(`${PLUGIN_BASE}/milestones/update${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, ...patch, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.milestone) throw new Error("Milestone update failed unexpectedly.");
  return result.milestone;
}

async function putMilestoneStateRequest(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  number: number,
  state: "open" | "closed",
  confirmed: boolean,
): Promise<MilestoneRow> {
  const result = await fetchJson<MilestoneWriteResponse>(`${PLUGIN_BASE}/milestones/state${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, state, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.milestone) throw new Error("Milestone state change failed unexpectedly.");
  return result.milestone;
}

async function postDeleteMilestone(context: PluginDashboardViewContext | undefined, repo: string, number: number, confirmed: boolean): Promise<void> {
  const result = await fetchJson<MilestoneDeleteResponse>(`${PLUGIN_BASE}/milestones/delete${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (result.number === undefined) throw new Error("Milestone delete failed unexpectedly.");
}

async function postReassignOpenIssues(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  number: number,
  target: number | null,
  confirmed: boolean,
): Promise<number> {
  const result = await fetchJson<MilestoneReassignResponse>(`${PLUGIN_BASE}/milestones/reassign-open-issues${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, number, target, ...(confirmed ? { confirmed: true } : {}) }),
  });
  return result.reassignedCount ?? 0;
}

/** closed / (open + closed) -- the exact ratio GitHub's milestone page uses. Total 0 is a defined 0%, never NaN. */
function progressPercent(openIssues: number, closedIssues: number): number {
  const total = openIssues + closedIssues;
  if (total <= 0) return 0;
  return Math.round((closedIssues / total) * 100);
}

/** Overdue iff: open AND has a due date AND that due date is in the past. Never true for closed or no-due-date milestones. */
function isOverdue(milestone: MilestoneRow): boolean {
  if (milestone.state !== "open" || !milestone.dueOn) return false;
  const due = new Date(milestone.dueOn).getTime();
  if (Number.isNaN(due)) return false;
  return due < Date.now();
}

function formatDueDate(dueOn?: string | null): string | null {
  if (!dueOn) return null;
  const date = new Date(dueOn);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ErrorBanner({ message, testId }: { message: string; testId?: string }) {
  return (
    <p className="milestones-panel__error" role="alert" aria-live="assertive" data-testid={testId ?? "milestones-panel-error-banner"}>
      <AlertTriangle aria-hidden="true" /> {message}
    </p>
  );
}

function ProgressBar({ milestone }: { milestone: MilestoneRow }) {
  const total = milestone.openIssues + milestone.closedIssues;
  const percent = progressPercent(milestone.openIssues, milestone.closedIssues);
  return (
    <div className="milestones-panel__progress" data-testid={`milestone-progress-${milestone.number}`}>
      <div
        className="milestones-panel__progress-track"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${percent}% complete`}
      >
        <div className="milestones-panel__progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="milestones-panel__progress-label" data-testid={`milestone-progress-label-${milestone.number}`}>
        {total === 0 ? "No issues" : `${percent}% · ${milestone.closedIssues}/${total} closed`}
      </span>
    </div>
  );
}

export function MilestonesPanel({ repo, context, confirmWrites }: { repo: string | null; context?: PluginDashboardViewContext; confirmWrites?: boolean }) {
  const gateWrites = confirmWrites !== false;
  const { confirm } = useConfirm();

  const [dataState, setDataState] = useState<PanelDataState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);

  // Create form.
  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createDueOn, setCreateDueOn] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string>();

  // Inline edit, keyed by milestone number.
  const [editingNumber, setEditingNumber] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueOn, setEditDueOn] = useState("");
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string>();

  // Per-row close/reopen/delete pending + error state.
  const [actionPendingNumber, setActionPendingNumber] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string>();

  /*
  FNXC:GithubPmMilestones 2026-07-25-01:25:
  Close-with-open-issues prompt state. Set only when the operator clicks "Close" on a
  milestone whose `openIssues > 0`; a milestone with zero open issues never touches this
  state and closes directly. `reassignMode` defaults to "keep" (close and leave the open
  issues assigned) -- the least-destructive default, per this task's acceptance criteria.
  */
  const [closePrompt, setClosePrompt] = useState<{ number: number; openIssues: number } | null>(null);
  const [reassignMode, setReassignMode] = useState<ReassignMode>("keep");
  const [reassignTarget, setReassignTarget] = useState("");

  const load = useCallback((): (() => void) | undefined => {
    if (!repo) {
      setMilestones([]);
      setDataState("ready");
      return undefined;
    }
    let cancelled = false;
    setDataState("loading");
    fetchMilestonesList(context, repo)
      .then((result) => {
        if (cancelled) return;
        setMilestones(result.items ?? []);
        setDataState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "Failed to load milestones");
        setDataState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!repo || !createTitle.trim()) return;
      if (gateWrites) {
        const proceed = await confirm({
          title: "Create milestone?",
          message: `Create milestone "${createTitle.trim()}" on ${repo}?`,
          confirmLabel: "Create milestone",
          cancelLabel: "Cancel",
        });
        if (!proceed) return;
      }
      setCreatePending(true);
      setCreateError(undefined);
      try {
        await postCreateMilestone(
          context,
          repo,
          { title: createTitle.trim(), description: createDescription.trim() || undefined, dueOn: createDueOn || undefined },
          gateWrites,
        );
        setCreateTitle("");
        setCreateDescription("");
        setCreateDueOn("");
        load();
      } catch (error) {
        setCreateError(error instanceof Error ? error.message : "Failed to create the milestone.");
      } finally {
        setCreatePending(false);
      }
    },
    [repo, context, createTitle, createDescription, createDueOn, gateWrites, confirm, load],
  );

  const startEdit = useCallback((milestone: MilestoneRow) => {
    setEditingNumber(milestone.number);
    setEditTitle(milestone.title);
    setEditDescription(milestone.description ?? "");
    setEditDueOn(milestone.dueOn ? milestone.dueOn.slice(0, 10) : "");
    setEditError(undefined);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingNumber(null);
    setEditError(undefined);
  }, []);

  const handleSaveEdit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!repo || editingNumber === null) return;
      if (gateWrites) {
        const proceed = await confirm({
          title: "Save milestone edit?",
          message: `Save edits to milestone #${editingNumber} on ${repo}?`,
          confirmLabel: "Save edit",
          cancelLabel: "Cancel",
        });
        if (!proceed) return;
      }
      setEditPending(true);
      setEditError(undefined);
      try {
        await putUpdateMilestone(
          context,
          repo,
          editingNumber,
          { title: editTitle.trim() || undefined, description: editDescription, dueOn: editDueOn ? editDueOn : null },
          gateWrites,
        );
        setEditingNumber(null);
        load();
      } catch (error) {
        setEditError(error instanceof Error ? error.message : "Failed to update the milestone.");
      } finally {
        setEditPending(false);
      }
    },
    [repo, context, editingNumber, editTitle, editDescription, editDueOn, gateWrites, confirm, load],
  );

  const handleReopen = useCallback(
    async (number: number) => {
      if (!repo) return;
      if (gateWrites) {
        const proceed = await confirm({
          title: "Reopen milestone?",
          message: `Reopen milestone #${number} on ${repo}?`,
          confirmLabel: "Reopen milestone",
          cancelLabel: "Cancel",
        });
        if (!proceed) return;
      }
      setActionPendingNumber(number);
      setActionError(undefined);
      try {
        await putMilestoneStateRequest(context, repo, number, "open", gateWrites);
        load();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Failed to reopen the milestone.");
      } finally {
        setActionPendingNumber(null);
      }
    },
    [repo, context, gateWrites, confirm, load],
  );

  const closeMilestoneDirectly = useCallback(
    async (number: number) => {
      if (!repo) return;
      if (gateWrites) {
        const proceed = await confirm({
          title: "Close milestone?",
          message: `Close milestone #${number} on ${repo}?`,
          confirmLabel: "Close milestone",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!proceed) return;
      }
      setActionPendingNumber(number);
      setActionError(undefined);
      try {
        await putMilestoneStateRequest(context, repo, number, "closed", gateWrites);
        load();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Failed to close the milestone.");
      } finally {
        setActionPendingNumber(null);
      }
    },
    [repo, context, gateWrites, confirm, load],
  );

  /*
  FNXC:GithubPmMilestones 2026-07-25-01:30:
  Close-request entry point: with open issues present, this NEVER closes silently -- it opens
  the inline how-to-handle prompt instead of calling the state-change route directly. A
  milestone with zero open issues bypasses the prompt entirely and closes directly (still
  subject to the normal confirm-writes dialog above).
  */
  const requestClose = useCallback(
    (milestone: MilestoneRow) => {
      if (milestone.openIssues > 0) {
        setReassignMode("keep");
        setReassignTarget("");
        setActionError(undefined);
        setClosePrompt({ number: milestone.number, openIssues: milestone.openIssues });
        return;
      }
      closeMilestoneDirectly(milestone.number);
    },
    [closeMilestoneDirectly],
  );

  const cancelClosePrompt = useCallback(() => {
    setClosePrompt(null);
    setActionError(undefined);
  }, []);

  const confirmClosePrompt = useCallback(async () => {
    if (!repo || !closePrompt) return;
    const { number } = closePrompt;
    if (reassignMode === "move" && !reassignTarget.trim()) {
      setActionError("Select a target milestone to move the open issues to.");
      return;
    }
    setActionPendingNumber(number);
    setActionError(undefined);
    try {
      if (reassignMode === "clear") {
        await postReassignOpenIssues(context, repo, number, null, gateWrites);
      } else if (reassignMode === "move") {
        await postReassignOpenIssues(context, repo, number, Number.parseInt(reassignTarget, 10), gateWrites);
      }
      await putMilestoneStateRequest(context, repo, number, "closed", gateWrites);
      setClosePrompt(null);
      load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to close the milestone.");
    } finally {
      setActionPendingNumber(null);
    }
  }, [repo, context, closePrompt, reassignMode, reassignTarget, gateWrites, load]);

  const handleDelete = useCallback(
    async (number: number) => {
      if (!repo) return;
      // FNXC:GithubPmMilestones 2026-07-25-01:35: delete ALWAYS shows an explicit confirm
      // affordance, independent of the confirmWrites setting (per this task's requirement).
      const proceed = await confirm({
        title: "Delete milestone?",
        message: `Delete milestone #${number} from ${repo}? This detaches it from any issues; it does not delete the issues.`,
        confirmLabel: "Delete milestone",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!proceed) return;
      setActionPendingNumber(number);
      setActionError(undefined);
      try {
        await postDeleteMilestone(context, repo, number, gateWrites);
        load();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "Failed to delete the milestone.");
      } finally {
        setActionPendingNumber(null);
      }
    },
    [repo, context, gateWrites, confirm, load],
  );

  if (!repo) {
    return (
      <div className="milestones-panel" data-testid="milestones-panel">
        <p className="milestones-panel__empty-state" data-testid="milestones-panel-no-repo">
          Select a repository to view its milestones.
        </p>
      </div>
    );
  }

  const openMilestones = milestones.filter((m) => m.state === "open");
  const closedMilestones = milestones.filter((m) => m.state !== "open");
  const reassignCandidates = milestones.filter((m) => m.number !== closePrompt?.number);

  return (
    <div className="milestones-panel" data-testid="milestones-panel">
      <section className="milestones-panel__section" aria-labelledby="milestones-create-heading">
        <h3 id="milestones-create-heading" className="milestones-panel__section-title">
          <PlusCircle aria-hidden="true" /> New milestone
        </h3>
        <form onSubmit={handleCreate} className="milestones-panel__form">
          <label className="milestones-panel__field">
            <span>Title</span>
            <input
              type="text"
              value={createTitle}
              onChange={(event) => setCreateTitle(event.target.value)}
              required
              disabled={createPending}
              data-testid="milestones-create-title"
            />
          </label>
          <label className="milestones-panel__field">
            <span>Description</span>
            <textarea
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              disabled={createPending}
              data-testid="milestones-create-description"
            />
          </label>
          <label className="milestones-panel__field">
            <span>Due date</span>
            <input
              type="date"
              value={createDueOn}
              onChange={(event) => setCreateDueOn(event.target.value)}
              disabled={createPending}
              data-testid="milestones-create-due-on"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={createPending || !createTitle.trim()} data-testid="milestones-create-submit">
            {createPending ? <Loader2 aria-hidden="true" className="milestones-panel__spinner" /> : <PlusCircle aria-hidden="true" />}
            {createPending ? "Creating…" : "Create milestone"}
          </button>
        </form>
        {createError ? <ErrorBanner message={createError} testId="milestones-create-error" /> : null}
      </section>

      {dataState === "loading" ? (
        <p className="milestones-panel__status" role="status" data-testid="milestones-panel-loading">
          <Loader2 aria-hidden="true" className="milestones-panel__spinner" /> Loading milestones…
        </p>
      ) : dataState === "error" ? (
        <p className="milestones-panel__status milestones-panel__status--error" role="alert" data-testid="milestones-panel-error">
          <AlertCircle aria-hidden="true" /> {errorMessage ?? "Failed to load milestones."}
        </p>
      ) : milestones.length === 0 ? (
        <p className="milestones-panel__empty-state" data-testid="milestones-panel-empty">
          No milestones yet. Create one above.
        </p>
      ) : (
        <>
          {actionError ? <ErrorBanner message={actionError} testId="milestones-action-error" /> : null}

          {[
            { label: "Open", items: openMilestones, testId: "milestones-open-list" },
            { label: "Closed", items: closedMilestones, testId: "milestones-closed-list" },
          ].map((group) =>
            group.items.length > 0 ? (
              <section key={group.label} className="milestones-panel__group" aria-label={`${group.label} milestones`}>
                <h4 className="milestones-panel__group-title">{group.label}</h4>
                <ul className="milestones-panel__list" data-testid={group.testId}>
                  {group.items.map((milestone) => {
                    const overdue = isOverdue(milestone);
                    const dueLabel = formatDueDate(milestone.dueOn);
                    const isEditing = editingNumber === milestone.number;
                    const rowPending = actionPendingNumber === milestone.number;
                    return (
                      <li key={milestone.number} className="milestones-panel__row" data-testid={`milestone-row-${milestone.number}`}>
                        {isEditing ? (
                          <form onSubmit={handleSaveEdit} className="milestones-panel__form milestones-panel__form--inline">
                            <label className="milestones-panel__field">
                              <span>Title</span>
                              <input type="text" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} disabled={editPending} data-testid={`milestone-edit-title-${milestone.number}`} />
                            </label>
                            <label className="milestones-panel__field">
                              <span>Description</span>
                              <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={editPending} data-testid={`milestone-edit-description-${milestone.number}`} />
                            </label>
                            <label className="milestones-panel__field">
                              <span>Due date</span>
                              <input type="date" value={editDueOn} onChange={(event) => setEditDueOn(event.target.value)} disabled={editPending} data-testid={`milestone-edit-due-on-${milestone.number}`} />
                            </label>
                            <div className="milestones-panel__row-actions">
                              <button type="submit" className="btn btn-primary" disabled={editPending} data-testid={`milestone-edit-save-${milestone.number}`}>
                                {editPending ? "Saving…" : "Save"}
                              </button>
                              <button type="button" className="btn" onClick={cancelEdit} disabled={editPending}>
                                Cancel
                              </button>
                            </div>
                            {editError ? <ErrorBanner message={editError} testId={`milestone-edit-error-${milestone.number}`} /> : null}
                          </form>
                        ) : (
                          <>
                            <div className="milestones-panel__row-header">
                              <span className="milestones-panel__row-number">#{milestone.number}</span>
                              <span className="milestones-panel__row-title">{milestone.title}</span>
                              {overdue ? (
                                <span className="milestones-panel__overdue-badge" role="status" aria-label="Overdue" data-testid={`milestone-overdue-${milestone.number}`}>
                                  <AlertTriangle aria-hidden="true" /> Overdue
                                </span>
                              ) : null}
                            </div>
                            {milestone.description ? <p className="milestones-panel__row-description">{milestone.description}</p> : null}
                            <ProgressBar milestone={milestone} />
                            {dueLabel ? (
                              <span className="milestones-panel__due-date" data-testid={`milestone-due-${milestone.number}`}>
                                Due {dueLabel}
                              </span>
                            ) : (
                              <span className="milestones-panel__due-date milestones-panel__due-date--none">No due date</span>
                            )}
                            <div className="milestones-panel__row-actions">
                              <button type="button" className="btn btn-icon" onClick={() => startEdit(milestone)} disabled={rowPending} aria-label={`Edit milestone #${milestone.number}`}>
                                <PenLine aria-hidden="true" />
                              </button>
                              {milestone.state === "open" ? (
                                <button
                                  type="button"
                                  className="btn milestones-panel__close-button"
                                  onClick={() => requestClose(milestone)}
                                  disabled={rowPending}
                                  data-testid={`milestone-close-${milestone.number}`}
                                >
                                  <XCircle aria-hidden="true" /> {rowPending ? "Closing…" : "Close"}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn milestones-panel__reopen-button"
                                  onClick={() => handleReopen(milestone.number)}
                                  disabled={rowPending}
                                  data-testid={`milestone-reopen-${milestone.number}`}
                                >
                                  <CheckCircle2 aria-hidden="true" /> {rowPending ? "Reopening…" : "Reopen"}
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn milestones-panel__delete-button"
                                onClick={() => handleDelete(milestone.number)}
                                disabled={rowPending}
                                data-testid={`milestone-delete-${milestone.number}`}
                              >
                                <Trash2 aria-hidden="true" /> Delete
                              </button>
                            </div>

                            {closePrompt?.number === milestone.number ? (
                              <div className="milestones-panel__close-prompt" role="dialog" aria-labelledby={`milestone-close-prompt-heading-${milestone.number}`} data-testid={`milestone-close-prompt-${milestone.number}`}>
                                <h5 id={`milestone-close-prompt-heading-${milestone.number}`} className="milestones-panel__close-prompt-heading">
                                  <AlertTriangle aria-hidden="true" /> This milestone has {closePrompt.openIssues} open {closePrompt.openIssues === 1 ? "issue" : "issues"}
                                </h5>
                                <p className="milestones-panel__close-prompt-copy">Choose how those open issues should be handled before closing.</p>
                                <fieldset className="milestones-panel__reassign-options">
                                  <label className="milestones-panel__reassign-option">
                                    <input type="radio" name={`reassign-${milestone.number}`} value="keep" checked={reassignMode === "keep"} onChange={() => setReassignMode("keep")} data-testid={`milestone-reassign-keep-${milestone.number}`} />
                                    Close and keep open issues assigned to this milestone
                                  </label>
                                  <label className="milestones-panel__reassign-option">
                                    <input type="radio" name={`reassign-${milestone.number}`} value="clear" checked={reassignMode === "clear"} onChange={() => setReassignMode("clear")} data-testid={`milestone-reassign-clear-${milestone.number}`} />
                                    Clear the milestone from those open issues
                                  </label>
                                  <label className="milestones-panel__reassign-option">
                                    <input type="radio" name={`reassign-${milestone.number}`} value="move" checked={reassignMode === "move"} onChange={() => setReassignMode("move")} data-testid={`milestone-reassign-move-${milestone.number}`} />
                                    Move them to another milestone
                                  </label>
                                  {reassignMode === "move" ? (
                                    <select
                                      value={reassignTarget}
                                      onChange={(event) => setReassignTarget(event.target.value)}
                                      data-testid={`milestone-reassign-target-${milestone.number}`}
                                    >
                                      <option value="">Select a milestone…</option>
                                      {reassignCandidates.map((candidate) => (
                                        <option key={candidate.number} value={String(candidate.number)}>
                                          {candidate.title}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                </fieldset>
                                <div className="milestones-panel__row-actions">
                                  <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={confirmClosePrompt}
                                    disabled={rowPending}
                                    data-testid={`milestone-close-prompt-confirm-${milestone.number}`}
                                  >
                                    {rowPending ? "Closing…" : "Close milestone"}
                                  </button>
                                  <button type="button" className="btn" onClick={cancelClosePrompt} disabled={rowPending} data-testid={`milestone-close-prompt-cancel-${milestone.number}`}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null,
          )}
        </>
      )}
    </div>
  );
}

export default MilestonesPanel;
