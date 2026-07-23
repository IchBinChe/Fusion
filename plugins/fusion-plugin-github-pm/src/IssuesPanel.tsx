import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, CircleDot, CircleSlash, Loader2, Search } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { subscribeIssuesChanged } from "./issues-events.js";
import "./IssuesPanel.css";

/*
FNXC:GithubPmIssues 2026-07-24-03:30:
FUSI-012's sole issue-list surface: mounts into FUSI-008's `issues` tabpanel via
`{ repo, context, onSelectIssue }`. Pagination is strictly PAGE-BASED -- every filter/sort/page
change issues a fresh, page-scoped `GET /issues/list` request; pages are never accumulated
client-side, so a repo with 10k+ issues never loads more than one page's rows into the DOM.
Live updates: subscribes to `subscribeIssuesChanged` (issues-events.ts) and, on a matching-repo
mutation, re-fetches the CURRENT page rather than remounting -- this is the seam FUSI-013/014/015
(issue detail + write ops, not yet built) will call `notifyIssuesChanged` into.
*/

type IssueStateFilter = "open" | "closed" | "all";
type IssueSort = "created" | "updated" | "comments";
type IssueDirection = "asc" | "desc";

interface FilterOptionsLabel {
  id: string;
  name: string;
  color: string;
}

interface FilterOptionsMilestone {
  number: number;
  title: string;
  state: string;
}

interface IssueRowLabel {
  name: string;
  color: string;
}

interface IssueRowAssignee {
  login: string;
  avatarUrl?: string;
}

interface IssueRow {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  labels: IssueRowLabel[];
  assignees: IssueRowAssignee[];
  milestoneTitle?: string | null;
  commentsCount: number;
  updatedAt?: string;
}

interface IssuesListResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  mode?: "list" | "search";
  items?: IssueRow[];
  page?: number;
  hasNextPage?: boolean;
  nextPage?: number;
  totalCount?: number;
  incompleteResults?: boolean;
  cappedAtLimit?: boolean;
}

interface FilterOptionsResponse {
  ok?: boolean;
  error?: string;
  labels?: FilterOptionsLabel[];
  milestones?: FilterOptionsMilestone[];
}

type PanelDataState = "loading" | "ready" | "error";

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";
const PER_PAGE = 25;
const SEARCH_DEBOUNCE_MS = 350;

interface IssueFilters {
  state: IssueStateFilter;
  labels: string[];
  assignee: string;
  milestone: string;
  search: string;
  sort: IssueSort;
  direction: IssueDirection;
}

const DEFAULT_FILTERS: IssueFilters = {
  state: "open",
  labels: [],
  assignee: "",
  milestone: "",
  search: "",
  sort: "created",
  direction: "desc",
};

function projectQuery(context?: PluginDashboardViewContext): URLSearchParams {
  return new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
}

function buildListUrl(context: PluginDashboardViewContext | undefined, repo: string, filters: IssueFilters, page: number): string {
  const params = projectQuery(context);
  params.set("repo", repo);
  params.set("state", filters.state);
  if (filters.labels.length > 0) params.set("labels", filters.labels.join(","));
  if (filters.assignee.trim()) params.set("assignee", filters.assignee.trim());
  if (filters.milestone) params.set("milestone", filters.milestone);
  if (filters.search.trim()) params.set("search", filters.search.trim());
  params.set("sort", filters.sort);
  params.set("direction", filters.direction);
  params.set("page", String(page));
  params.set("perPage", String(PER_PAGE));
  return `${PLUGIN_BASE}/issues/list?${params.toString()}`;
}

async function fetchIssuesList(context: PluginDashboardViewContext | undefined, repo: string, filters: IssueFilters, page: number): Promise<IssuesListResponse> {
  const res = await fetch(buildListUrl(context, repo, filters, page));
  const json = (await res.json().catch(() => ({}))) as IssuesListResponse;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `Issue list request failed with status ${res.status}.`);
  }
  return json;
}

async function fetchFilterOptions(context: PluginDashboardViewContext | undefined, repo: string): Promise<FilterOptionsResponse> {
  const params = projectQuery(context);
  params.set("repo", repo);
  const res = await fetch(`${PLUGIN_BASE}/issues/filter-options?${params.toString()}`);
  const json = (await res.json().catch(() => ({}))) as FilterOptionsResponse;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `Filter options request failed with status ${res.status}.`);
  }
  return json;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSeconds = Math.round((Date.now() - then) / 1000);
  const units: Array<[string, number]> = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [label, seconds] of units) {
    const value = Math.floor(diffSeconds / seconds);
    if (value >= 1) return `${value} ${label}${value === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function IssueStateBadge({ state }: { state: string }) {
  const isOpen = state === "open";
  const Icon = isOpen ? CircleDot : CircleSlash;
  return (
    <span className={`issues-panel__state-badge issues-panel__state-badge--${isOpen ? "open" : "closed"}`} data-testid="issue-row-state">
      <Icon aria-hidden="true" />
      {isOpen ? "Open" : "Closed"}
    </span>
  );
}

export function IssuesPanel({ repo, context, onSelectIssue }: { repo: string | null; context?: PluginDashboardViewContext; onSelectIssue?: (issueNumber: number) => void }) {
  const [filters, setFilters] = useState<IssueFilters>(DEFAULT_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [dataState, setDataState] = useState<PanelDataState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [listResult, setListResult] = useState<IssuesListResponse>();
  const [filterOptions, setFilterOptions] = useState<FilterOptionsResponse>();

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce the free-text search input into `filters.search`, resetting to page 1.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setFilters((prev) => (prev.search === searchInput ? prev : { ...prev, search: searchInput }));
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput]);

  const loadCurrentPage = useCallback(() => {
    if (!repo) return;
    let cancelled = false;
    setDataState("loading");
    fetchIssuesList(context, repo, filters, page)
      .then((result) => {
        if (cancelled) return;
        setListResult(result);
        setDataState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "Failed to load issues");
        setDataState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId, filters, page]);

  useEffect(() => {
    const cleanup = loadCurrentPage();
    return cleanup;
  }, [loadCurrentPage]);

  // Once per mount/repo change: populate the label/milestone filter dropdowns.
  useEffect(() => {
    if (!repo) {
      setFilterOptions(undefined);
      return;
    }
    let cancelled = false;
    fetchFilterOptions(context, repo)
      .then((result) => {
        if (!cancelled) setFilterOptions(result);
      })
      .catch(() => {
        if (!cancelled) setFilterOptions({ ok: true, labels: [], milestones: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId]);

  // Live-update seam: re-fetch the current page (not a full remount) on a matching-repo mutation.
  useEffect(() => {
    if (!repo) return undefined;
    return subscribeIssuesChanged((detail) => {
      if (detail.repo.toLowerCase() !== repo.toLowerCase()) return;
      loadCurrentPage();
    });
  }, [repo, loadCurrentPage]);

  function updateFilter<K extends keyof IssueFilters>(key: K, value: IssueFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  }

  function toggleLabelFilter(labelName: string) {
    setFilters((prev) => {
      const has = prev.labels.includes(labelName);
      return { ...prev, labels: has ? prev.labels.filter((name) => name !== labelName) : [...prev.labels, labelName] };
    });
    setPage(1);
  }

  if (!repo) {
    return (
      <div className="issues-panel" data-testid="issues-panel">
        <p className="issues-panel__empty-state" data-testid="issues-panel-no-repo">Select a repository to view its issues.</p>
      </div>
    );
  }

  const labels = filterOptions?.labels ?? [];
  const milestones = filterOptions?.milestones ?? [];
  const items = listResult?.items ?? [];
  const mode = listResult?.mode ?? "list";
  const hasNextPage = listResult?.hasNextPage ?? false;
  const showCappedNotice = mode === "search" && listResult?.cappedAtLimit === true;

  return (
    <div className="issues-panel" data-testid="issues-panel">
      <form className="issues-panel__filter-bar" role="search" aria-label="Filter issues" onSubmit={(event) => event.preventDefault()}>
        <label className="issues-panel__field">
          <span className="issues-panel__field-label">State</span>
          <select value={filters.state} onChange={(event) => updateFilter("state", event.target.value as IssueStateFilter)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </label>

        <label className="issues-panel__field">
          <span className="issues-panel__field-label">Assignee</span>
          <input
            type="text"
            value={filters.assignee}
            placeholder="Any"
            onChange={(event) => updateFilter("assignee", event.target.value)}
            data-testid="issues-panel-assignee-input"
          />
        </label>

        <label className="issues-panel__field">
          <span className="issues-panel__field-label">Milestone</span>
          <select value={filters.milestone} onChange={(event) => updateFilter("milestone", event.target.value)} data-testid="issues-panel-milestone-select">
            <option value="">Any</option>
            {milestones.map((milestone) => (
              <option key={milestone.number} value={String(milestone.number)}>{milestone.title}</option>
            ))}
          </select>
        </label>

        <label className="issues-panel__field issues-panel__field--search">
          <span className="issues-panel__field-label">Search</span>
          <span className="issues-panel__search-input-wrap">
            <Search aria-hidden="true" />
            <input
              type="search"
              value={searchInput}
              placeholder="Search issues…"
              onChange={(event) => setSearchInput(event.target.value)}
              data-testid="issues-panel-search-input"
            />
          </span>
        </label>

        <label className="issues-panel__field">
          <span className="issues-panel__field-label">Sort</span>
          <select value={filters.sort} onChange={(event) => updateFilter("sort", event.target.value as IssueSort)}>
            <option value="created">Created</option>
            <option value="updated">Updated</option>
            <option value="comments">Comments</option>
          </select>
        </label>

        <button
          type="button"
          className="btn btn-icon issues-panel__direction-toggle"
          aria-label={filters.direction === "desc" ? "Sort ascending" : "Sort descending"}
          onClick={() => updateFilter("direction", filters.direction === "desc" ? "asc" : "desc")}
          data-testid="issues-panel-direction-toggle"
        >
          {filters.direction === "desc" ? "↓" : "↑"}
        </button>

        {labels.length > 0 ? (
          <div className="issues-panel__label-filters" data-testid="issues-panel-label-filters">
            {labels.map((label) => (
              <button
                key={label.id}
                type="button"
                className={`issues-panel__label-chip${filters.labels.includes(label.name) ? " issues-panel__label-chip--active" : ""}`}
                style={{ ["--issues-panel-label-color" as string]: `#${label.color}` }}
                onClick={() => toggleLabelFilter(label.name)}
                aria-pressed={filters.labels.includes(label.name)}
              >
                {label.name}
              </button>
            ))}
          </div>
        ) : null}
      </form>

      {dataState === "loading" ? (
        <p className="issues-panel__status" role="status" data-testid="issues-panel-loading">
          <Loader2 aria-hidden="true" className="issues-panel__spinner" /> Loading issues…
        </p>
      ) : dataState === "error" ? (
        <p className="issues-panel__status issues-panel__status--error" role="alert" data-testid="issues-panel-error">
          <AlertCircle aria-hidden="true" /> {errorMessage ?? "Failed to load issues."}
        </p>
      ) : items.length === 0 ? (
        <p className="issues-panel__empty-state" data-testid="issues-panel-empty">No issues match these filters.</p>
      ) : (
        <ul className="issues-panel__list" data-testid="issues-panel-list">
          {items.map((issue) => (
            <li key={issue.number} className="issues-panel__row" data-testid={`issue-row-${issue.number}`}>
              <IssueStateBadge state={issue.state} />
              <span className="issues-panel__row-number">#{issue.number}</span>
              {onSelectIssue ? (
                <button type="button" className="issues-panel__row-title" onClick={() => onSelectIssue(issue.number)}>
                  {issue.title}
                </button>
              ) : (
                <a className="issues-panel__row-title" href={issue.htmlUrl} target="_blank" rel="noreferrer">
                  {issue.title}
                </a>
              )}
              <span className="issues-panel__row-labels">
                {issue.labels.map((label) => (
                  <span key={label.name} className="issues-panel__row-label-chip" style={{ ["--issues-panel-label-color" as string]: `#${label.color}` }}>
                    {label.name}
                  </span>
                ))}
              </span>
              <span className="issues-panel__row-assignees">
                {issue.assignees.map((assignee) => assignee.login).join(", ")}
              </span>
              <span className="issues-panel__row-comments">{issue.commentsCount}</span>
              <span className="issues-panel__row-updated">{formatRelativeTime(issue.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}

      {showCappedNotice ? (
        <p className="issues-panel__capped-notice" data-testid="issues-panel-capped-notice">
          Showing the first ~1,000 matching results. Refine your search to see more.
        </p>
      ) : null}

      <div className="issues-panel__pagination">
        <button
          type="button"
          className="btn btn-icon"
          disabled={page <= 1}
          onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          aria-label="Previous page"
          data-testid="issues-panel-prev"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <span className="issues-panel__page-indicator" data-testid="issues-panel-page">Page {page}</span>
        <button
          type="button"
          className="btn btn-icon"
          disabled={!hasNextPage}
          onClick={() => setPage((prev) => prev + 1)}
          aria-label="Next page"
          data-testid="issues-panel-next"
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default IssuesPanel;
