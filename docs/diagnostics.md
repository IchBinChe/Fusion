# Diagnostics

## Insight run sweeper (`[insight-sweeper]`)

The dashboard insight router runs stale-run recovery sweeps for `project_insight_runs` rows stuck in `pending`/`running` without a live controller owner.

- Recovery writes `terminalCause: "orphaned_active_run_recovered"` and lifecycle failure metadata (`failureClass: "non_retryable"`, `retryable: false`).
- Recovery appends both `warning` and `status_changed` events on `project_insight_run_events` with `metadata.recovery = "orphaned_active_run"`.
- `metadata.recoverySource` indicates where recovery occurred: `startup`, `periodic`, `drive_by`, or `manual`.

## Dependency-blocked Todo backlog health (`[dependency-blocked-todo]`)

Self-healing now runs `surface-dependency-blocked-todos` during both startup recovery and periodic maintenance.

- Normal path emits a workflow insight titled `Backlog health: dependency-blocked todos YYYY-MM-DD`.
- Fallback path (insight store unavailable) writes a per-task log entry prefixed with `[dependency-blocked-todo]` against the top blocker task.
- Reporter summary warnings include group count, total blocked Todo count, and top blocker IDs.

Operator interpretation:
- `ageBucket: "fresh"` → expected dependency queueing.
- `ageBucket: "aging"` → review blocker progress.
- `ageBucket: "stale"` → emerging stall; escalate/unblock blocker.

## Self-healing surfacing passes (`[self-healing]`)

- `surface-in-review-stalls`
  - Log prefix: `In-review stall surfaced [`
  - Purpose: reason-driven in-review stall detector (`merge-blocker`, retry exhaustion, no-worktree, transient merge-status orphaning).
- `surface-in-review-stalled`
  - Log prefix: `In-review stalled surfaced [in-review-stalled]: quiet ...`
  - Purpose: time-quiet detector for unpaused in-review tasks beyond `inReviewStalledThresholdMs`.
  - Non-overlap: skipped when reason-driven `In-review stall surfaced [` is fresh, and skipped for paused tasks (owned by stale-paused-review).
- `surface-stale-paused-reviews`
  - Log prefix: `Stale paused review surfaced [stale-paused-review]: paused ...`
  - Purpose: paused in-review backlog-health detector gated by `stalePausedReviewThresholdMs`.
