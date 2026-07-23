import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Pencil, PlusCircle, Tag, Trash2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useConfirm } from "@fusion/dashboard/app/hooks/useConfirm";
import { normalizeGitHubLabelColor } from "./github-client.js";
import "./LabelsPanel.css";

/*
FNXC:GithubPmLabels 2026-07-24-11:00:
KB-002's sole label-MANAGEMENT surface. Mounted once in GitHubPmView.tsx (the `labels`
tabpanel, replacing its `TabPlaceholderPanel`) -- this is the ONLY component that renders
label create/edit/delete controls or the color picker; the taxonomy proposal panel proposes
labels but never manages repo labels and must not be forked into a second editor.

Three acceptance-criterion contracts this component must never violate:
1. Color validity: the color picker (below) only ever calls back with a value that passes
   `normalizeGitHubLabelColor` (the SAME validator github-client.ts's createLabel/updateLabel
   use) -- an invalid free-hex entry shows an inline error and is never propagated to state.
2. Rename preserves associations: an edit submit sends `newName` ONLY when the name actually
   changed, exactly matching label-routes.ts's PUT /labels/update contract (GitHub's new_name,
   never delete+recreate).
3. Delete warns with usage count: the delete control opens a confirm dialog (the SAME
   `useConfirm` primitive IssueWritePanel.tsx uses) whose message states the label's open-issue
   usage count before any mutation is dispatched; Cancel performs zero mutations.

Optimistic-update contract (mirrors IssueWritePanel.tsx): each write snapshots the prior label
list, applies the change immediately, then calls the plugin route. On success the optimistic
row is reconciled to GitHub's authoritative returned object and the list is re-fetched (so
usage counts refresh). On failure the snapshot is restored verbatim and an aria-live error
banner renders the route's message. Controls are disabled while their own write is pending.
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

/** GitHub's own default label palette (subset), offered as one-click swatches alongside the free hex input. */
const DEFAULT_PALETTE = ["b60205", "d93f0b", "fbca04", "0e8a16", "006b75", "1d76db", "0052cc", "5319e7", "e99695", "c2e0c6"];

interface LabelRow {
  name: string;
  color: string;
  description?: string | null;
  usageCount: number | null;
}

interface LabelsListResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  labels?: LabelRow[];
}

interface LabelWriteResponse {
  ok?: boolean;
  error?: string;
  label?: { name: string; color: string; description?: string | null };
}

interface LabelDeleteResponse {
  ok?: boolean;
  error?: string;
  deleted?: string;
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

async function fetchLabels(context: PluginDashboardViewContext | undefined, repo: string): Promise<LabelRow[]> {
  const result = await fetchJson<LabelsListResponse>(`${PLUGIN_BASE}/labels/list${projectQuery(context, { repo })}`);
  return result.labels ?? [];
}

async function createLabelRequest(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  input: { name: string; color: string; description?: string },
  confirmed: boolean,
): Promise<{ name: string; color: string; description?: string | null }> {
  const result = await fetchJson<LabelWriteResponse>(`${PLUGIN_BASE}/labels/create${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, ...input, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.label) throw new Error("Label creation failed unexpectedly.");
  return result.label;
}

async function updateLabelRequest(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  name: string,
  patch: { newName?: string; color?: string; description?: string },
  confirmed: boolean,
): Promise<{ name: string; color: string; description?: string | null }> {
  const result = await fetchJson<LabelWriteResponse>(`${PLUGIN_BASE}/labels/update${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, name, ...patch, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.label) throw new Error("Label update failed unexpectedly.");
  return result.label;
}

async function deleteLabelRequest(context: PluginDashboardViewContext | undefined, repo: string, name: string, confirmed: boolean): Promise<void> {
  const result = await fetchJson<LabelDeleteResponse>(`${PLUGIN_BASE}/labels/delete${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, name, ...(confirmed ? { confirmed: true } : {}) }),
  });
  if (!result.deleted) throw new Error("Label deletion failed unexpectedly.");
}

function ErrorBanner({ message, testId }: { message: string; testId: string }) {
  return (
    <p className="labels-panel__error" role="alert" aria-live="assertive" data-testid={testId}>
      <AlertTriangle aria-hidden="true" /> {message}
    </p>
  );
}

/*
FNXC:GithubPmLabels 2026-07-24-11:00:
Shared color-picker sub-component (create + edit use the SAME one, per the task's explicit
"the color picker is the same component as the create form" requirement). Offers GitHub's
default palette as one-click swatches plus a free hex input with a live preview swatch.
`onChange` is invoked ONLY when the current input value passes `normalizeGitHubLabelColor` --
an invalid entry renders an inline error and never propagates, so the parent's color state is
always a valid 6-hex-digit value (the acceptance-criterion contract).
*/
function ColorPicker({ value, onChange, disabled, testIdPrefix }: { value: string; onChange: (color: string) => void; disabled?: boolean; testIdPrefix: string }) {
  const [inputValue, setInputValue] = useState(value);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  const normalized = normalizeGitHubLabelColor(inputValue);

  return (
    <div className="labels-panel__color-picker" data-testid={`${testIdPrefix}-picker`}>
      <span className="labels-panel__color-picker-label">Color</span>
      <div className="labels-panel__color-swatches">
        {DEFAULT_PALETTE.map((paletteColor) => (
          <button
            key={paletteColor}
            type="button"
            className={`labels-panel__color-swatch-button${value === paletteColor ? " labels-panel__color-swatch-button--active" : ""}`}
            style={{ background: `#${paletteColor}` }}
            onClick={() => {
              setInputValue(paletteColor);
              onChange(paletteColor);
            }}
            disabled={disabled}
            aria-label={`Use color #${paletteColor}`}
            data-testid={`${testIdPrefix}-swatch-${paletteColor}`}
          />
        ))}
      </div>
      <input
        type="text"
        value={inputValue}
        onChange={(event) => {
          const next = event.target.value;
          setInputValue(next);
          const valid = normalizeGitHubLabelColor(next);
          if (valid) onChange(valid);
        }}
        disabled={disabled}
        placeholder="d73a4a"
        aria-label="Custom hex color"
        data-testid={`${testIdPrefix}-input`}
      />
      <span className="labels-panel__color-preview" style={normalized ? { background: `#${normalized}` } : undefined} data-testid={`${testIdPrefix}-preview`} />
      {!normalized && inputValue ? (
        <span className="labels-panel__color-error" role="alert" data-testid={`${testIdPrefix}-error`}>
          Enter six hex digits, e.g. d73a4a.
        </span>
      ) : null}
    </div>
  );
}

export function LabelsPanel({ context, repo, confirmWrites }: { context?: PluginDashboardViewContext; repo: string | null; confirmWrites?: boolean }) {
  const gateWrites = confirmWrites !== false;
  const { confirm } = useConfirm();

  const [dataState, setDataState] = useState<"loading" | "ready" | "error">("loading");
  const [labels, setLabels] = useState<LabelRow[]>([]);
  const [loadError, setLoadError] = useState<string>();

  const [createName, setCreateName] = useState("");
  const [createColor, setCreateColor] = useState(DEFAULT_PALETTE[0]);
  const [createDescription, setCreateDescription] = useState("");
  const [createPending, setCreatePending] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const [editingName, setEditingName] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string>();

  const [deletePendingName, setDeletePendingName] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string>();

  const loadLabels = useCallback(() => {
    if (!repo) return undefined;
    let cancelled = false;
    setDataState("loading");
    fetchLabels(context, repo)
      .then((result) => {
        if (cancelled) return;
        setLabels(result);
        setDataState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Failed to load labels");
        setDataState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId]);

  useEffect(() => {
    const cleanup = loadLabels();
    return cleanup;
  }, [loadLabels]);

  useEffect(() => {
    setEditingName(null);
  }, [repo]);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!repo) return;
      const name = createName.trim();
      const normalizedColor = normalizeGitHubLabelColor(createColor);
      if (!name) {
        setCreateError("Enter a label name.");
        return;
      }
      if (!normalizedColor) {
        setCreateError("Enter a valid six-hex-digit color.");
        return;
      }
      if (gateWrites) {
        const proceed = await confirm({
          title: "Create label?",
          message: `Create label "${name}" on ${repo}?`,
          confirmLabel: "Create label",
          cancelLabel: "Cancel",
        });
        if (!proceed) return;
      }
      setCreatePending(true);
      setCreateError(undefined);
      const snapshot = labels;
      const description = createDescription.trim() || null;
      setLabels([...snapshot, { name, color: normalizedColor, description, usageCount: 0 }]);
      try {
        const created = await createLabelRequest(context, repo, { name, color: normalizedColor, description: description ?? undefined }, gateWrites);
        setCreateName("");
        setCreateDescription("");
        setCreateColor(DEFAULT_PALETTE[0]);
        void created;
        loadLabels();
      } catch (error) {
        setLabels(snapshot);
        setCreateError(error instanceof Error ? error.message : "Failed to create the label.");
      } finally {
        setCreatePending(false);
      }
    },
    [repo, createName, createColor, createDescription, labels, gateWrites, confirm, context, loadLabels],
  );

  const startEdit = useCallback((label: LabelRow) => {
    setEditingName(label.name);
    setEditName(label.name);
    setEditColor(label.color);
    setEditDescription(label.description ?? "");
    setEditError(undefined);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingName(null);
    setEditError(undefined);
  }, []);

  const handleEditSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!repo || editingName === null) return;
      const normalizedColor = normalizeGitHubLabelColor(editColor);
      if (!normalizedColor) {
        setEditError("Enter a valid six-hex-digit color.");
        return;
      }
      const trimmedName = editName.trim();
      if (!trimmedName) {
        setEditError("Enter a label name.");
        return;
      }
      // KB-002 rename-preserves-associations: newName is sent ONLY when the name actually changed.
      const newName = trimmedName !== editingName ? trimmedName : undefined;
      if (gateWrites) {
        const proceed = await confirm({
          title: "Save label edit?",
          message: `Save changes to label "${editingName}" on ${repo}?`,
          confirmLabel: "Save",
          cancelLabel: "Cancel",
        });
        if (!proceed) return;
      }
      setEditPending(true);
      setEditError(undefined);
      const snapshot = labels;
      const description = editDescription.trim() || null;
      setLabels((prev) => prev.map((label) => (label.name === editingName ? { ...label, name: newName ?? label.name, color: normalizedColor, description } : label)));
      try {
        await updateLabelRequest(context, repo, editingName, { newName, color: normalizedColor, description: description ?? undefined }, gateWrites);
        setEditingName(null);
        loadLabels();
      } catch (error) {
        setLabels(snapshot);
        setEditError(error instanceof Error ? error.message : "Failed to update the label.");
      } finally {
        setEditPending(false);
      }
    },
    [repo, editingName, editName, editColor, editDescription, labels, gateWrites, confirm, context, loadLabels],
  );

  const handleDelete = useCallback(
    async (label: LabelRow) => {
      if (!repo) return;
      // KB-002 delete-warns-with-usage-count acceptance criterion: the confirm dialog message
      // states the label's open-issue usage count BEFORE any mutation is dispatched. Cancel
      // (proceed === false) returns here with ZERO state mutation and ZERO network call.
      const usageText = label.usageCount === null ? "an unknown number of" : String(label.usageCount);
      const proceed = await confirm({
        title: "Delete label?",
        message: `This label is used by ${usageText} open issue${label.usageCount === 1 ? "" : "s"}. Deleting it removes it from those issues. Delete "${label.name}"?`,
        confirmLabel: "Delete label",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!proceed) return;
      setDeletePendingName(label.name);
      setDeleteError(undefined);
      const snapshot = labels;
      setLabels((prev) => prev.filter((existing) => existing.name !== label.name));
      try {
        await deleteLabelRequest(context, repo, label.name, gateWrites);
        loadLabels();
      } catch (error) {
        setLabels(snapshot);
        setDeleteError(error instanceof Error ? error.message : "Failed to delete the label.");
      } finally {
        setDeletePendingName(null);
      }
    },
    [repo, labels, gateWrites, confirm, context, loadLabels],
  );

  if (!repo) {
    return (
      <div className="labels-panel" data-testid="labels-panel">
        <p className="labels-panel__empty-state" data-testid="labels-panel-no-repo">
          Select a repository to view and manage its labels.
        </p>
      </div>
    );
  }

  return (
    <div className="labels-panel" data-testid="labels-panel">
      <section className="labels-panel__section" aria-labelledby="labels-create-heading">
        <h3 id="labels-create-heading" className="labels-panel__section-title">
          <PlusCircle aria-hidden="true" /> New label
        </h3>
        <form onSubmit={handleCreate} className="labels-panel__form">
          <label className="labels-panel__field">
            <span>Name</span>
            <input type="text" value={createName} onChange={(event) => setCreateName(event.target.value)} disabled={createPending} data-testid="labels-create-name" />
          </label>
          <label className="labels-panel__field">
            <span>Description</span>
            <input type="text" value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} disabled={createPending} data-testid="labels-create-description" />
          </label>
          <ColorPicker value={createColor} onChange={setCreateColor} disabled={createPending} testIdPrefix="labels-create-color" />
          <button type="submit" className="btn btn-primary" disabled={createPending || !createName.trim()} data-testid="labels-create-submit">
            {createPending ? <Loader2 aria-hidden="true" className="labels-panel__spinner" /> : <PlusCircle aria-hidden="true" />}
            {createPending ? "Creating…" : "Create label"}
          </button>
        </form>
        {createError ? <ErrorBanner message={createError} testId="labels-create-error" /> : null}
      </section>

      <section className="labels-panel__section" aria-labelledby="labels-table-heading">
        <h3 id="labels-table-heading" className="labels-panel__section-title">
          <Tag aria-hidden="true" /> Labels
        </h3>
        {dataState === "loading" ? (
          <p className="labels-panel__status" role="status" data-testid="labels-panel-loading">
            <Loader2 aria-hidden="true" className="labels-panel__spinner" /> Loading labels…
          </p>
        ) : dataState === "error" ? (
          <p className="labels-panel__status labels-panel__status--error" role="alert" data-testid="labels-panel-error">
            <AlertTriangle aria-hidden="true" /> {loadError ?? "Failed to load labels."}
          </p>
        ) : labels.length === 0 ? (
          <p className="labels-panel__empty-state" data-testid="labels-panel-empty">This repository has no labels yet.</p>
        ) : (
          <table className="labels-panel__table" data-testid="labels-panel-table">
            <thead>
              <tr>
                <th scope="col">Color</th>
                <th scope="col">Name</th>
                <th scope="col">Description</th>
                <th scope="col">Open issues</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {labels.map((label) =>
                editingName === label.name ? (
                  <tr key={label.name} data-testid={`labels-row-edit-${label.name}`}>
                    <td colSpan={5}>
                      <form onSubmit={handleEditSubmit} className="labels-panel__form labels-panel__form--inline">
                        <label className="labels-panel__field">
                          <span>Name</span>
                          <input type="text" value={editName} onChange={(event) => setEditName(event.target.value)} disabled={editPending} data-testid="labels-edit-name" />
                        </label>
                        <label className="labels-panel__field">
                          <span>Description</span>
                          <input type="text" value={editDescription} onChange={(event) => setEditDescription(event.target.value)} disabled={editPending} data-testid="labels-edit-description" />
                        </label>
                        <ColorPicker value={editColor} onChange={setEditColor} disabled={editPending} testIdPrefix="labels-edit-color" />
                        <div className="labels-panel__row-actions">
                          <button type="submit" className="btn btn-primary" disabled={editPending} data-testid="labels-edit-submit">
                            {editPending ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className="btn" onClick={cancelEdit} disabled={editPending} data-testid="labels-edit-cancel">
                            Cancel
                          </button>
                        </div>
                      </form>
                      {editError ? <ErrorBanner message={editError} testId="labels-edit-error" /> : null}
                    </td>
                  </tr>
                ) : (
                  <tr key={label.name} data-testid={`labels-row-${label.name}`}>
                    <td>
                      <span className="labels-panel__swatch" style={{ background: `#${label.color}` }} data-testid={`labels-swatch-${label.name}`} />
                    </td>
                    <td>{label.name}</td>
                    <td className="labels-panel__description-cell">{label.description || ""}</td>
                    <td data-testid={`labels-usage-${label.name}`}>{label.usageCount === null ? "—" : label.usageCount}</td>
                    <td className="labels-panel__row-actions">
                      <button type="button" className="btn btn-icon" onClick={() => startEdit(label)} aria-label={`Edit ${label.name}`} data-testid={`labels-edit-${label.name}`}>
                        <Pencil aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn btn-icon"
                        onClick={() => handleDelete(label)}
                        disabled={deletePendingName === label.name}
                        aria-label={`Delete ${label.name}`}
                        data-testid={`labels-delete-${label.name}`}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
        {deleteError ? <ErrorBanner message={deleteError} testId="labels-delete-error" /> : null}
      </section>
    </div>
  );
}

export default LabelsPanel;
