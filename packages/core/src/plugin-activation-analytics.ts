import type { Database } from "./db.js";

/**
 * Plugin activation analytics over the project-scoped `plugin_activations` table.
 *
 * Fusion records one row when a plugin or workflow extension genuinely activates
 * through `PluginLoader.loadPlugin` or `reloadPlugin`. The Command Center
 * Ecosystem card may show a count only when at least one in-range row exists.
 * Empty ranges return `unavailable: true` and `activations: 0` as a transport
 * shape, but UI callers must keep the honest unavailable sentinel — never render
 * `0` as if missing historical capture meant zero activations.
 *
 * Inclusivity: `from`/`to` bounds are inclusive and filter `activatedAt`.
 *
 * FNXC:CommandCenterEcosystem 2026-06-19-08:05:
 * Plugin activation analytics are project-scoped event aggregates. Absence of rows means the metric is unavailable for the selected range, not that Fusion observed zero activations.
 */

export interface PluginActivationAnalyticsQuery {
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

/** Activation count for a single plugin id. */
export interface PluginActivationPluginCount {
  pluginId: string;
  count: number;
}

export interface PluginActivationAnalytics {
  from: string | null;
  to: string | null;
  /** Real activation rows in range. */
  activations: number;
  /** Activation rows grouped by plugin id, descending by count. */
  byPlugin: PluginActivationPluginCount[];
  /** True when no in-range activation rows exist; UI should render the sentinel, not 0. */
  unavailable: boolean;
}

interface CountRow {
  count: number;
}

interface PluginCountRow {
  pluginId: string;
  count: number;
}

function rangeWhere(query: PluginActivationAnalyticsQuery): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (query.from !== undefined) {
    clauses.push("activatedAt >= ?");
    params.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push("activatedAt <= ?");
    params.push(query.to);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Aggregate plugin activations over a date range.
 *
 * Empty range yields `{ activations: 0, byPlugin: [], unavailable: true }` so
 * callers can preserve the Command Center unavailable sentinel rather than
 * fabricating a zero-valued metric.
 */
export function aggregatePluginActivations(
  db: Database,
  query: PluginActivationAnalyticsQuery = {},
): PluginActivationAnalytics {
  const { where, params } = rangeWhere(query);

  const activations = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM plugin_activations ${where}`)
      .get(...params) as CountRow
  ).count;

  const byPlugin = db
    .prepare(
      `SELECT pluginId, COUNT(*) AS count
       FROM plugin_activations ${where}
       GROUP BY pluginId
       ORDER BY count DESC, pluginId ASC`,
    )
    .all(...params) as PluginCountRow[];

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    activations,
    byPlugin,
    unavailable: activations === 0,
  };
}
