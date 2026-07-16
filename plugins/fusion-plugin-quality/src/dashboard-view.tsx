import "./dashboard-view.css";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Play, RefreshCw, ShieldCheck } from "lucide-react";
import { ViewHeader } from "@fusion/dashboard/app/components/ViewHeader";

/*
FNXC:Quality 2026-07-14-21:45:
Quality hub dashboard view — project-wide run history and preset catalog.
Host registers this via registerBundledPluginViews (static registry).

FNXC:Quality 2026-07-15-23:30:
Layout matches native main-content views: shared ViewHeader (ShieldCheck + title),
flex column root, tokenized body inset, card + table for run history, btn-sm header
actions. Removes ad-hoc padding/h2/inline table styles that made Quality look unlike
Insights / Compound Engineering / Goals.
*/

export interface QualityDashboardViewContext {
  projectId?: string;
}

interface RunRow {
  id: string;
  status: string;
  command: string;
  durationMs?: number;
  presetId?: string;
  createdAt: string;
  taskId?: string;
}

async function fetchRuns(projectId: string): Promise<RunRow[]> {
  /*
  FNXC:Quality 2026-07-15-23:17:
  Surface HTTP failures (including the experimental gate) instead of silently
  rendering an empty history that looks like "no runs yet".
  */
  const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error.trim()) {
        message = parsed.error;
      }
    } catch {
      // keep text body
    }
    throw new Error(message);
  }
  const data = (await res.json()) as { runs?: RunRow[] };
  return data.runs ?? [];
}

function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(durationMs?: number): string {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}

function StatusPill({ status }: { status: string }): ReactElement {
  const normalized = status.toLowerCase().replace(/\s+/g, "_");
  return (
    <span className={`quality-status quality-status--${normalized}`} data-status={normalized}>
      {status}
    </span>
  );
}

export function QualityDashboardView({
  context,
}: {
  context?: QualityDashboardViewContext;
}): ReactElement {
  const projectId = context?.projectId;
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPreset, setBusyPreset] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchRuns(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startPreset = async (preset: string, confirmFullSuite = false) => {
    if (!projectId) return;
    setBusyPreset(preset);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, preset, source: "hub", confirmFullSuite }),
      });
      if (!res.ok) {
        /*
        FNXC:Quality 2026-07-15-23:17:
        Surface structured plugin route errors (e.g. experimental gate) without dumping raw JSON.
        */
        const text = await res.text();
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.trim()) {
            setError(parsed.error);
            return;
          }
        } catch {
          // fall through
        }
        setError(text || res.statusText);
        return;
      }
      await refresh();
    } finally {
      setBusyPreset(null);
    }
  };

  const actions = projectId ? (
    <>
      <span className="quality-header-count" data-testid="quality-run-count">
        {runs.length} {runs.length === 1 ? "run" : "runs"}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("verify-fast")}
        data-testid="quality-run-verify-fast"
      >
        <Play size={14} aria-hidden="true" />
        verify:fast
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("test-gate")}
        data-testid="quality-run-test-gate"
      >
        <Play size={14} aria-hidden="true" />
        test:gate
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("project-test")}
        data-testid="quality-run-project-test"
      >
        <Play size={14} aria-hidden="true" />
        project test
      </button>
      <button
        type="button"
        className="btn btn-icon btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void refresh()}
        aria-label="Refresh Quality runs"
        title="Refresh"
        data-testid="quality-refresh"
      >
        <RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />
      </button>
    </>
  ) : null;

  return (
    <div className="quality-view" data-testid="quality-hub">
      <ViewHeader icon={ShieldCheck} title="Quality" actions={actions} titleId="quality-view-title" />
      <div className="quality-view-body">
        <p className="quality-view-lede">
          Project-wide test runs. Advisory only — does not change merge eligibility. Prefer Task QA for
          worktree-scoped preview, screenshots, and suggested cases.
        </p>

        {!projectId ? (
          <p className="quality-view-empty-project">Select a project to view Quality data.</p>
        ) : (
          <>
            {error ? (
              <p className="quality-view-error" role="alert">
                {error}
              </p>
            ) : null}

            <section className="quality-runs-card card" data-testid="quality-runs-card">
              <header className="quality-runs-card__header">
                <h3>Run history</h3>
                <span className="quality-runs-card__count">
                  {loading && runs.length === 0 ? "Loading…" : `${runs.length} total`}
                </span>
              </header>
              <div className="quality-runs-table-wrap">
                <table className="quality-runs-table">
                  <thead>
                    <tr>
                      <th scope="col">Status</th>
                      <th scope="col">Preset</th>
                      <th scope="col">Command</th>
                      <th scope="col">Duration</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="quality-runs-table__empty">
                          {loading ? "Loading runs…" : "No runs yet. Start a preset from the header."}
                        </td>
                      </tr>
                    ) : (
                      runs.map((run) => (
                        <tr key={run.id} data-testid="quality-run-row">
                          <td>
                            <StatusPill status={run.status} />
                          </td>
                          <td>{run.presetId ?? "—"}</td>
                          <td className="quality-runs-table__command">{run.command}</td>
                          <td>{formatDuration(run.durationMs)}</td>
                          <td>{formatWhen(run.createdAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default QualityDashboardView;
