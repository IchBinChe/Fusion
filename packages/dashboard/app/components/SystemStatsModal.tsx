import { useCallback, useEffect, useMemo, useState } from "react";
import { Monitor, RefreshCw, X } from "lucide-react";
import { fetchSystemStats, type SystemStatsResponse } from "../api";
import "./SystemStatsModal.css";

interface SystemStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function toPercent(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "—";
  return `${((used / total) * 100).toFixed(1)}%`;
}

type Severity = "normal" | "warning" | "critical";

function heapSeverity(used: number, limit: number): Severity {
  if (limit <= 0) return "normal";
  const pct = used / limit;
  if (pct >= 0.85) return "critical";
  if (pct >= 0.65) return "warning";
  return "normal";
}

function rssSeverity(rss: number, totalSystemMem: number): Severity {
  if (totalSystemMem <= 0) return "normal";
  const pct = rss / totalSystemMem;
  if (pct >= 0.5) return "critical";
  if (pct >= 0.25) return "warning";
  return "normal";
}

function systemMemSeverity(used: number, total: number): Severity {
  if (total <= 0) return "normal";
  const pct = used / total;
  if (pct >= 0.9) return "critical";
  if (pct >= 0.75) return "warning";
  return "normal";
}

function severityClassName(severity: Severity): string {
  if (severity === "critical") return "system-stats-modal__value--critical";
  if (severity === "warning") return "system-stats-modal__value--warning";
  return "";
}

/**
 * SystemStatsModal groups dashboard runtime telemetry into five sections:
 * process memory metrics, CPU/load information, host memory usage, task counts
 * by column, and agent state counts.
 */
export function SystemStatsModal({ isOpen, onClose, projectId }: SystemStatsModalProps) {
  const [stats, setStats] = useState<SystemStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchSystemStats(projectId);
      setStats(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load system stats");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!isOpen) return;
    void loadStats();

    const timer = window.setInterval(() => {
      void loadStats();
    }, 5_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isOpen, loadStats]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [isOpen, onClose]);

  const processRows = useMemo(() => {
    if (!stats) return [];
    const system = stats.systemStats;
    const heapClassName = severityClassName(heapSeverity(system.heapUsed, system.heapLimit));
    const rssClassName = severityClassName(rssSeverity(system.rss, system.systemTotalMem));
    return [
      { label: "RSS", value: formatBytes(system.rss), detail: toPercent(system.rss, system.systemTotalMem), className: rssClassName },
      { label: "Heap Used", value: formatBytes(system.heapUsed), detail: `of ${formatBytes(system.heapTotal)}`, className: heapClassName },
      { label: "Heap Limit", value: formatBytes(system.heapLimit), detail: "V8 limit" },
      { label: "External", value: formatBytes(system.external) },
      { label: "Array Buffers", value: formatBytes(system.arrayBuffers) },
    ];
  }, [stats]);

  if (!isOpen) return null;

  const system = stats?.systemStats;
  const taskStats = stats?.taskStats;
  const usedSystemMem = system ? system.systemTotalMem - system.systemFreeMem : 0;
  const usedSystemClassName = system
    ? severityClassName(systemMemSeverity(usedSystemMem, system.systemTotalMem))
    : "";

  return (
    <div
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="system-stats-modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      data-testid="system-stats-modal-overlay"
    >
      <div className="modal modal-lg system-stats-modal" data-testid="system-stats-modal">
        <div className="modal-header system-stats-modal__header">
          <h2 id="system-stats-modal-title" className="system-stats-modal__title">
            <Monitor />
            <span>System Stats</span>
          </h2>
          <div className="system-stats-modal__header-actions">
            <button
              type="button"
              className="btn btn-icon"
              onClick={() => void loadStats()}
              title="Refresh"
              aria-label="Refresh system stats"
            >
              <RefreshCw />
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </div>
        </div>

        {loading && !stats && <div className="system-stats-modal__state">Loading system stats…</div>}

        {error && !stats && (
          <div className="system-stats-modal__state system-stats-modal__state--error" role="alert">
            {error}
          </div>
        )}

        {stats && (
          <div className="system-stats-modal__content">
            <section className="system-stats-modal__section" aria-label="Process stats">
              <h3 className="system-stats-modal__section-title">Process</h3>
              <dl className="system-stats-modal__grid">
                {processRows.map((row) => (
                  <div key={row.label} className="system-stats-modal__row">
                    <dt>{row.label}</dt>
                    <dd>
                      <span className={`system-stats-modal__value ${row.className}`.trim()}>{row.value}</span>
                      {row.detail ? <span className="system-stats-modal__detail">{row.detail}</span> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="CPU and load stats">
              <h3 className="system-stats-modal__section-title">CPU &amp; Load</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>Load Avg</dt>
                  <dd>{system?.loadAvg.map((value) => value.toFixed(2)).join(" ") ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Cores</dt>
                  <dd>{system?.cpuCount ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Platform</dt>
                  <dd>{system?.platform ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Node</dt>
                  <dd>{system?.nodeVersion ?? "—"}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>PID</dt>
                  <dd>{system?.pid ?? "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="System memory stats">
              <h3 className="system-stats-modal__section-title">System</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>Memory Used</dt>
                  <dd>
                    <span className={`system-stats-modal__value ${usedSystemClassName}`.trim()}>
                      {system ? formatBytes(usedSystemMem) : "—"}
                    </span>
                    <span className="system-stats-modal__detail">
                      {system ? `${toPercent(usedSystemMem, system.systemTotalMem)} of ${formatBytes(system.systemTotalMem)}` : ""}
                    </span>
                  </dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>Memory Free</dt>
                  <dd>{system ? formatBytes(system.systemFreeMem) : "—"}</dd>
                </div>
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="Task stats">
              <h3 className="system-stats-modal__section-title">Tasks</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>Total</dt>
                  <dd>{taskStats?.total ?? 0}</dd>
                </div>
                {Object.entries(taskStats?.byColumn ?? {}).map(([column, count]) => (
                  <div key={column} className="system-stats-modal__row">
                    <dt>{column}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="system-stats-modal__section" aria-label="Agent stats">
              <h3 className="system-stats-modal__section-title">Agents</h3>
              <dl className="system-stats-modal__grid">
                <div className="system-stats-modal__row">
                  <dt>idle</dt>
                  <dd>{taskStats?.agents.idle ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>active</dt>
                  <dd>{taskStats?.agents.active ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>running</dt>
                  <dd>{taskStats?.agents.running ?? 0}</dd>
                </div>
                <div className="system-stats-modal__row">
                  <dt>error</dt>
                  <dd>{taskStats?.agents.error ?? 0}</dd>
                </div>
              </dl>
            </section>
          </div>
        )}

        {error && stats && <div className="system-stats-modal__footer-error">Latest refresh failed: {error}</div>}
      </div>
    </div>
  );
}
