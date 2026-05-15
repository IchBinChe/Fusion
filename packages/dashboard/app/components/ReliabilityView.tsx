import { useCallback, useEffect, useMemo, useState } from "react";
import "./ReliabilityView.css";

type ReliabilityResponse = {
  windowDays: number;
  generatedAt: string;
  resetAt: string | null;
  headline: { inReviewFailureRate7d: number | null; reason?: string };
  perDay: Array<{
    date: string;
    tasksEnteredInReview: number;
    tasksBouncedToInProgress: number;
    postMergeAuditFailures: { block: number; warn: number; off: number } | null;
    fileScopeInvariantFailures: number | null;
    recoverAlreadyMergedReviewTasksRecoveries: number | null;
    hasSamples?: boolean;
  }>;
  duration: { p50Ms: number | null; p95Ms: number | null; sampleCount: number; reason?: string };
  mergeAttempts: { mean: number | null; max: number | null; histogram: Record<string, number>; reason?: string };
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const minutes = value / 60_000;
  return `${minutes.toFixed(1)}m`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

export function ReliabilityView() {
  const [data, setData] = useState<ReliabilityResponse | null>(null);
  const [showEmptyDays, setShowEmptyDays] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/health/reliability");
    if (!response.ok) {
      throw new Error(`Failed to load reliability metrics (${response.status})`);
    }
    const payload = (await response.json()) as ReliabilityResponse;
    setData(payload);
  }, []);

  useEffect(() => {
    void load();
    const pollInterval = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(pollInterval);
  }, [load]);

  const headlineColorVar = useMemo(() => {
    const rate = data?.headline.inReviewFailureRate7d;
    if (rate === null || rate === undefined) {
      return "var(--text-muted)";
    }
    if (rate < 0.05) {
      return "var(--color-success)";
    }
    if (rate < 0.1) {
      return "var(--color-warning)";
    }
    return "var(--color-error)";
  }, [data]);

  const totalEntered = useMemo(
    () => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksEnteredInReview, 0),
    [data?.perDay],
  );
  const totalBounced = useMemo(
    () => (data?.perDay ?? []).reduce((sum, row) => sum + row.tasksBouncedToInProgress, 0),
    [data?.perDay],
  );

  const perDayRows = useMemo(() => {
    if (!data?.perDay) {
      return [];
    }
    if (showEmptyDays) {
      return data.perDay;
    }
    return data.perDay.filter((row) => row.hasSamples !== false);
  }, [data?.perDay, showEmptyDays]);

  const mergeAttemptTaskCount = useMemo(
    () => Object.values(data?.mergeAttempts.histogram ?? {}).reduce((sum, count) => sum + count, 0),
    [data?.mergeAttempts.histogram],
  );

  return (
    <section className="reliability-view">
      <div className="card reliability-card reliability-headline-card">
        <h2>Reliability</h2>
        <div className="reliability-headline" style={{ color: headlineColorVar }}>
          {data?.headline.inReviewFailureRate7d === null || data?.headline.inReviewFailureRate7d === undefined
            ? `Insufficient data — ${data?.headline.reason ?? "unknown"}`
            : formatPercent(data.headline.inReviewFailureRate7d)}
        </div>
        <details className="reliability-details">
          <summary>Details</summary>
          <div className="reliability-details-content">
            <div>{`${totalBounced} bounced / ${totalEntered} entered (last ${data?.windowDays ?? 7}d)`}</div>
            <div>{`Window: ${data ? formatDateTime(data.resetAt ?? new Date(Date.parse(data.generatedAt) - data.windowDays * 86_400_000).toISOString()) : "—"} → ${formatDateTime(data?.generatedAt)}`}</div>
            {data?.resetAt ? <div>{`Reset baseline: ${formatDateTime(data.resetAt)}`}</div> : null}
            {data?.headline.reason ? <div>{`Reason: ${data.headline.reason}`}</div> : null}
          </div>
        </details>
      </div>

      <div className="reliability-grid">
        <div className="card reliability-card">
          <div className="reliability-section-header">
            <h3>In-review flow</h3>
            <button className="btn btn-sm" onClick={() => setShowEmptyDays((value) => !value)}>
              {showEmptyDays ? "Hide empty days" : "Show empty days"}
            </button>
          </div>
          <table className="reliability-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Entered</th>
                <th>Bounced</th>
              </tr>
            </thead>
            <tbody>
              {perDayRows.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>{row.tasksEnteredInReview}</td>
                  <td>{row.tasksBouncedToInProgress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card reliability-card">
          <h3>Duration</h3>
          <div className="reliability-stat-row"><span>P50</span><strong>{formatDuration(data?.duration.p50Ms ?? null)}</strong></div>
          <div className="reliability-stat-row"><span>P95</span><strong>{formatDuration(data?.duration.p95Ms ?? null)}</strong></div>
          <div className="reliability-muted">Samples: {data?.duration.sampleCount ?? 0}</div>
          <details className="reliability-details">
            <summary>More stats</summary>
            <div className="reliability-details-content">
              <div>{`P50 raw: ${data?.duration.p50Ms ?? "—"} ms`}</div>
              <div>{`P95 raw: ${data?.duration.p95Ms ?? "—"} ms`}</div>
              <div>{`Sample count: ${data?.duration.sampleCount ?? 0}`}</div>
              {data?.duration.reason ? <div>{`Reason: ${data.duration.reason}`}</div> : null}
            </div>
          </details>
        </div>

        <div className="card reliability-card">
          <h3>Merge attempts</h3>
          <div className="reliability-stat-row"><span>Mean</span><strong>{data?.mergeAttempts.mean?.toFixed(2) ?? "—"}</strong></div>
          <div className="reliability-stat-row"><span>Max</span><strong>{data?.mergeAttempts.max ?? "—"}</strong></div>
          <ul className="reliability-histogram">
            {Object.entries(data?.mergeAttempts.histogram ?? {}).map(([bucket, count]) => (
              <li key={bucket}>
                <span>{bucket}</span>
                <div className="reliability-histogram-bar-wrap"><div className="reliability-histogram-bar" style={{ width: `${Math.min(count * 20, 100)}%` }} /></div>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
          <details className="reliability-details">
            <summary>More stats</summary>
            <div className="reliability-details-content">
              <div>{`Tasks counted: ${mergeAttemptTaskCount}`}</div>
              <div>{`Histogram total: ${mergeAttemptTaskCount}`}</div>
              {data?.mergeAttempts.reason ? <div>{`Reason: ${data.mergeAttempts.reason}`}</div> : null}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
