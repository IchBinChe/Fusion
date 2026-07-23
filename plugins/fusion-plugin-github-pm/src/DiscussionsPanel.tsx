import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2, MessageCircle, Search, ThumbsUp } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import "./DiscussionsPanel.css";

/*
FNXC:GithubPmDiscussions 2026-07-25-12:00:
KB-005's sole discussion-browser surface: mounted into GitHubPmView.tsx's `discussions`
tabpanel with `{ repo, context }` -- read-only, so it does NOT take a `confirmWrites` prop
(mirrors IssuesPanel's read-only shape, not IssueWritePanel/LabelsPanel's write-gated shape).
This is the ONLY component that renders a discussion category rail or discussion list; the
taxonomy panel (TaxonomyProposalPanel.tsx) summarizes categories for AI proposal generation but
never browses discussions -- do not fork this UI into a second place.

CAPABILITY-GATING CONTRACT (acceptance-critical): this panel never re-checks whether
Discussions are enabled for the repo. FUSI-009's `resolveRepoCapabilities` already greys the
`discussions` tab and `GitHubPmTabPanelBody` renders `TabCapabilityNotice` INSTEAD of this
panel when the tab is gated off -- this component only ever mounts when discussions are usable.

SEARCH-QUERY-FIDELITY CONTRACT (acceptance-critical): every filter change (category/search/
sort/answered) re-fetches `GET /discussions/list` with the corresponding query param; the
server-side `buildDiscussionSearchQuery` (github-client.ts) is the single source of truth for
the assembled GitHub search-qualifier string -- this panel never re-derives or duplicates that
string, it only supplies the raw filter values.

Q&A-ONLY ANSWERED-FILTER CONTRACT (acceptance-critical): the answered/unanswered control
renders ONLY when the currently selected category's `isAnswerable === true`. It is absent for
"All categories" and for any non-answerable category -- never merely disabled, never shown
then hidden after a flash.
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";
const SEARCH_DEBOUNCE_MS = 350;

export interface DiscussionCategoryRow {
  id: string;
  name: string;
  slug: string;
  emoji: string;
  emojiHTML: string;
  isAnswerable: boolean;
  description?: string;
}

interface DiscussionCategoriesResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  categories?: DiscussionCategoryRow[];
}

export interface DiscussionRow {
  number: number;
  title: string;
  url: string;
  categoryName: string | null;
  categoryEmoji: string | null;
  upvoteCount: number;
  commentCount: number;
  isAnswered: boolean;
  authorLogin: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface DiscussionsListResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  items?: DiscussionRow[];
  query?: string | null;
}

type SortMode = "activity" | "newest";
type AnsweredFilter = "" | "answered" | "unanswered";
type PanelDataState = "loading" | "ready" | "error";

function projectQuery(context?: PluginDashboardViewContext): URLSearchParams {
  return new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
}

async function fetchDiscussionCategories(context: PluginDashboardViewContext | undefined, repo: string): Promise<DiscussionCategoriesResponse> {
  const params = projectQuery(context);
  params.set("repo", repo);
  const res = await fetch(`${PLUGIN_BASE}/discussions/categories?${params.toString()}`);
  const json = (await res.json().catch(() => ({}))) as DiscussionCategoriesResponse;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `Discussion categories request failed with status ${res.status}.`);
  }
  return json;
}

function buildListUrl(context: PluginDashboardViewContext | undefined, repo: string, filters: { category: string; search: string; sort: SortMode; answered: AnsweredFilter }): string {
  const params = projectQuery(context);
  params.set("repo", repo);
  if (filters.category) params.set("category", filters.category);
  if (filters.search.trim()) params.set("search", filters.search.trim());
  params.set("sort", filters.sort);
  if (filters.answered) params.set("answered", filters.answered);
  return `${PLUGIN_BASE}/discussions/list?${params.toString()}`;
}

async function fetchDiscussionsList(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  filters: { category: string; search: string; sort: SortMode; answered: AnsweredFilter },
): Promise<DiscussionsListResponse> {
  const res = await fetch(buildListUrl(context, repo, filters));
  const json = (await res.json().catch(() => ({}))) as DiscussionsListResponse;
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `Discussion list request failed with status ${res.status}.`);
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

/** True when the discussion row's own category (looked up by name, since "All categories" mixes rows from many categories) is answerable -- the answered/unanswered BADGE follows the ROW's category, independent of which category the rail currently has selected. Falls back to `item.isAnswered` when the category lookup can't resolve (e.g. categories still loading), so an already-answered row is never hidden. */
function isDiscussionInAnswerableCategory(item: DiscussionRow, categories: DiscussionCategoryRow[]): boolean {
  const category = item.categoryName ? categories.find((candidate) => candidate.name === item.categoryName) : undefined;
  if (category) return category.isAnswerable;
  return item.isAnswered;
}

/** Renders a category's emoji as safe glyph/shortcode TEXT -- never `emojiHTML` via dangerouslySetInnerHTML. */
function CategoryEmoji({ emoji }: { emoji: string }) {
  if (!emoji) return null;
  return (
    <span className="discussions-panel__category-emoji" aria-hidden="true">
      {emoji}
    </span>
  );
}

/*
FNXC:GithubPmDiscussions 2026-07-25-15:20:
KB-006 adds an OPTIONAL `onSelectDiscussion` callback, mirroring IssuesPanel's
`onSelectIssue` seam exactly: when supplied, a discussion row's title renders as a button
that invokes the callback with the discussion's number (driving DiscussionDetailView
selection in GitHubPmView.tsx) instead of an external GitHub link; when omitted, the row
title stays an external link, same fallback shape IssuesPanel uses.
*/
export function DiscussionsPanel({ repo, context, onSelectDiscussion }: { repo: string | null; context?: PluginDashboardViewContext; onSelectDiscussion?: (discussionNumber: number) => void }) {
  const [categories, setCategories] = useState<DiscussionCategoryRow[]>([]);
  const [categoriesState, setCategoriesState] = useState<PanelDataState>("loading");
  const [categoriesError, setCategoriesError] = useState<string>();

  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("activity");
  const [answered, setAnswered] = useState<AnsweredFilter>("");

  const [items, setItems] = useState<DiscussionRow[]>([]);
  const [itemsState, setItemsState] = useState<PanelDataState>("loading");
  const [itemsError, setItemsError] = useState<string>();

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load the category rail whenever the repo changes.
  useEffect(() => {
    if (!repo) {
      setCategories([]);
      setCategoriesState("ready");
      return;
    }
    let cancelled = false;
    setCategoriesState("loading");
    fetchDiscussionCategories(context, repo)
      .then((result) => {
        if (cancelled) return;
        setCategories(result.categories ?? []);
        setCategoriesState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setCategoriesError(error instanceof Error ? error.message : "Failed to load discussion categories");
        setCategoriesState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId]);

  // Reset category-scoped filter state whenever the repo changes.
  useEffect(() => {
    setSelectedCategory("");
    setSearchInput("");
    setSearch("");
    setSort("activity");
    setAnswered("");
  }, [repo]);

  // Debounce the free-text search input.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearch((prev) => (prev === searchInput ? prev : searchInput));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchInput]);

  const selectedCategoryRow = categories.find((category) => category.name === selectedCategory);
  const answeredFilterAvailable = Boolean(selectedCategoryRow?.isAnswerable);

  // Clear an answered filter that no longer applies (switched away from a Q&A category).
  useEffect(() => {
    if (!answeredFilterAvailable && answered) setAnswered("");
  }, [answeredFilterAvailable, answered]);

  const loadList = useCallback(() => {
    if (!repo) {
      setItems([]);
      setItemsState("ready");
      return undefined;
    }
    let cancelled = false;
    setItemsState("loading");
    fetchDiscussionsList(context, repo, { category: selectedCategory, search, sort, answered: answeredFilterAvailable ? answered : "" })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items ?? []);
        setItemsState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setItemsError(error instanceof Error ? error.message : "Failed to load discussions");
        setItemsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId, selectedCategory, search, sort, answered, answeredFilterAvailable]);

  useEffect(() => {
    const cleanup = loadList();
    return cleanup;
  }, [loadList]);

  if (!repo) {
    return (
      <div className="discussions-panel" data-testid="discussions-panel">
        <p className="discussions-panel__empty-state" data-testid="discussions-panel-no-repo">
          Select a repository to view its discussions.
        </p>
      </div>
    );
  }

  return (
    <div className="discussions-panel" data-testid="discussions-panel">
      <div className="discussions-panel__layout">
        <nav className="discussions-panel__rail" aria-label="Discussion categories" data-testid="discussions-panel-rail">
          {categoriesState === "loading" ? (
            <p className="discussions-panel__status" role="status" data-testid="discussions-panel-categories-loading">
              <Loader2 aria-hidden="true" className="discussions-panel__spinner" /> Loading categories…
            </p>
          ) : categoriesState === "error" ? (
            <p className="discussions-panel__status discussions-panel__status--error" role="alert" data-testid="discussions-panel-categories-error">
              <AlertCircle aria-hidden="true" /> {categoriesError ?? "Failed to load discussion categories."}
            </p>
          ) : (
            <>
              <button
                type="button"
                className={`discussions-panel__category-button${selectedCategory === "" ? " discussions-panel__category-button--active" : ""}`}
                aria-pressed={selectedCategory === ""}
                onClick={() => setSelectedCategory("")}
                data-testid="discussions-panel-category-all"
              >
                All categories
              </button>
              {categories.length === 0 ? (
                <p className="discussions-panel__empty-state" data-testid="discussions-panel-categories-empty">No discussion categories.</p>
              ) : (
                categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className={`discussions-panel__category-button${selectedCategory === category.name ? " discussions-panel__category-button--active" : ""}`}
                    aria-pressed={selectedCategory === category.name}
                    onClick={() => setSelectedCategory(category.name)}
                    data-testid={`discussions-panel-category-${category.slug || category.id}`}
                  >
                    <CategoryEmoji emoji={category.emoji} />
                    <span>{category.name}</span>
                  </button>
                ))
              )}
            </>
          )}
        </nav>

        <div className="discussions-panel__main">
          <form className="discussions-panel__filter-bar" role="search" aria-label="Filter discussions" onSubmit={(event) => event.preventDefault()}>
            <label className="discussions-panel__field discussions-panel__field--search">
              <span className="discussions-panel__field-label">Search</span>
              <span className="discussions-panel__search-input-wrap">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  value={searchInput}
                  placeholder="Search discussions…"
                  onChange={(event) => setSearchInput(event.target.value)}
                  data-testid="discussions-panel-search-input"
                />
              </span>
            </label>

            <label className="discussions-panel__field">
              <span className="discussions-panel__field-label">Sort</span>
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                data-testid="discussions-panel-sort-select"
              >
                <option value="activity">Latest activity</option>
                <option value="newest">Newest</option>
              </select>
            </label>

            {answeredFilterAvailable ? (
              <label className="discussions-panel__field">
                <span className="discussions-panel__field-label">Answered</span>
                <select
                  value={answered}
                  onChange={(event) => setAnswered(event.target.value as AnsweredFilter)}
                  data-testid="discussions-panel-answered-select"
                >
                  <option value="">Any</option>
                  <option value="answered">Answered</option>
                  <option value="unanswered">Unanswered</option>
                </select>
              </label>
            ) : null}
          </form>

          {itemsState === "loading" ? (
            <p className="discussions-panel__status" role="status" data-testid="discussions-panel-loading">
              <Loader2 aria-hidden="true" className="discussions-panel__spinner" /> Loading discussions…
            </p>
          ) : itemsState === "error" ? (
            <p className="discussions-panel__status discussions-panel__status--error" role="alert" aria-live="assertive" data-testid="discussions-panel-error">
              <AlertCircle aria-hidden="true" /> {itemsError ?? "Failed to load discussions."}
            </p>
          ) : items.length === 0 ? (
            <p className="discussions-panel__empty-state" aria-live="polite" data-testid="discussions-panel-empty">
              No discussions match these filters.
            </p>
          ) : (
            <ul className="discussions-panel__list" aria-live="polite" data-testid="discussions-panel-list">
              {items.map((item) => (
                <li key={item.number} className="discussions-panel__row" data-testid={`discussion-row-${item.number}`}>
                  {onSelectDiscussion ? (
                    <button
                      type="button"
                      className="discussions-panel__row-title"
                      onClick={() => onSelectDiscussion(item.number)}
                      data-testid={`discussion-row-select-${item.number}`}
                    >
                      {item.title}
                    </button>
                  ) : (
                    <a className="discussions-panel__row-title" href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.title}
                    </a>
                  )}
                  <div className="discussions-panel__row-meta">
                    {item.categoryName ? (
                      <span className="discussions-panel__category-chip">
                        <CategoryEmoji emoji={item.categoryEmoji ?? ""} />
                        {item.categoryName}
                      </span>
                    ) : null}
                    {isDiscussionInAnswerableCategory(item, categories) ? (
                      <span
                        className={`discussions-panel__answered-badge${item.isAnswered ? " discussions-panel__answered-badge--answered" : ""}`}
                        data-testid={`discussion-answered-badge-${item.number}`}
                      >
                        {item.isAnswered ? <CheckCircle2 aria-hidden="true" /> : <HelpCircle aria-hidden="true" />}
                        {item.isAnswered ? "Answered" : "Unanswered"}
                      </span>
                    ) : null}
                    <span className="discussions-panel__row-stat">
                      <MessageCircle aria-hidden="true" /> {item.commentCount}
                    </span>
                    <span className="discussions-panel__row-stat">
                      <ThumbsUp aria-hidden="true" /> {item.upvoteCount}
                    </span>
                    {item.authorLogin ? <span className="discussions-panel__row-author">{item.authorLogin}</span> : null}
                    <span className="discussions-panel__row-updated">{formatRelativeTime(item.updatedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default DiscussionsPanel;
