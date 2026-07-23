import { useEffect, useRef, useState } from "react";
import { AlertCircle, Clock, Github, Loader2, Search, X } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { normalizeRepoKey } from "./repo-config.js";
import "./RepoPicker.css";

/*
FNXC:GitHubPmRepoPicker 2026-07-24-07:45:
FUSI-007's sole UI surface: mounts into FUSI-008's `.github-pm-view__repo-picker-slot`
header seam (per GitHubPmView.tsx's RepoContextHeader) via `{ onSelect, context }`. A single
toggle button opens a compact popover with three sections: a debounced search box (results
render only while a query is typed), a recents list (shown only when the query is empty), and
a manual owner/repo entry field. All three converge on the SAME `POST /repo-picker/select`
call -- there is no separate "confirm" step for search/recents vs manual entry -- so
not-found/no-access errors render identically regardless of which path picked the repo.
Selecting closes the popover and calls `onSelect(repo)` so the header's already-rendered
selected-repo value updates without this component owning that display itself (no duplicate
"currently selected" affordance is introduced here).
*/

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";
const SEARCH_DEBOUNCE_MS = 350;

interface RepoSearchItem {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
}

interface RepoSearchResponse {
  ok?: boolean;
  error?: string;
  items?: RepoSearchItem[];
  totalCount?: number;
}

interface RecentRepoEntry {
  repo: string;
  lastUsedAt: string;
}

interface RecentsResponse {
  ok?: boolean;
  error?: string;
  recents?: RecentRepoEntry[];
}

interface SelectResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  selectedRepo?: string;
}

type SearchState = "idle" | "loading" | "ready" | "error";

function projectQuery(context?: PluginDashboardViewContext): URLSearchParams {
  return new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
}

async function fetchSearch(context: PluginDashboardViewContext | undefined, query: string): Promise<RepoSearchResponse> {
  const params = projectQuery(context);
  params.set("q", query);
  const res = await fetch(`${PLUGIN_BASE}/repo-picker/search?${params.toString()}`);
  const json = (await res.json().catch(() => ({}))) as RepoSearchResponse;
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `Repository search failed with status ${res.status}.`);
  return json;
}

async function fetchRecents(context: PluginDashboardViewContext | undefined): Promise<RecentsResponse> {
  const res = await fetch(`${PLUGIN_BASE}/repo-picker/recents${projectQuery(context).toString() ? `?${projectQuery(context).toString()}` : ""}`);
  const json = (await res.json().catch(() => ({}))) as RecentsResponse;
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `Recent repositories fetch failed with status ${res.status}.`);
  return json;
}

async function postSelect(context: PluginDashboardViewContext | undefined, repo: string): Promise<SelectResponse> {
  const params = projectQuery(context);
  const res = await fetch(`${PLUGIN_BASE}/repo-picker/select${params.toString() ? `?${params.toString()}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo }),
  });
  const json = (await res.json().catch(() => ({}))) as SelectResponse;
  if (!res.ok || json.ok === false) {
    const error = new Error(json.error ?? `Selecting repository failed with status ${res.status}.`) as Error & { code?: string };
    error.code = json.code;
    throw error;
  }
  return json;
}

export function RepoPicker({ onSelect, context }: { onSelect?: (repo: string) => void; context?: PluginDashboardViewContext }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchState, setSearchState] = useState<SearchState>("idle");
  const [searchError, setSearchError] = useState<string>();
  const [results, setResults] = useState<RepoSearchItem[]>([]);
  const [recents, setRecents] = useState<RecentRepoEntry[]>([]);
  const [manualEntry, setManualEntry] = useState("");
  const [manualError, setManualError] = useState<string>();
  const [selecting, setSelecting] = useState<string>();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Load recents once the popover opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchRecents(context)
      .then((result) => {
        if (!cancelled) setRecents(result.recents ?? []);
      })
      .catch(() => {
        if (!cancelled) setRecents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, context?.projectId]);

  // Debounced search: an empty query clears results (recents render instead) without a request.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchState("idle");
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSearchState("loading");
      fetchSearch(context, trimmed)
        .then((result) => {
          setResults(result.items ?? []);
          setSearchState("ready");
        })
        .catch((error) => {
          setSearchError(error instanceof Error ? error.message : "Repository search failed.");
          setSearchState("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, context?.projectId]);

  async function selectRepo(repo: string) {
    setSelecting(repo);
    setManualError(undefined);
    try {
      const result = await postSelect(context, repo);
      const selected = result.selectedRepo ?? repo;
      onSelect?.(selected);
      setOpen(false);
      setQuery("");
      setManualEntry("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to select repository.";
      setManualError(message);
    } finally {
      setSelecting(undefined);
    }
  }

  function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = normalizeRepoKey(manualEntry);
    if (!normalized) {
      setManualError("Enter a repository as owner/repo.");
      return;
    }
    void selectRepo(normalized);
  }

  return (
    <div className="repo-picker" data-testid="repo-picker">
      <button
        type="button"
        className="btn btn-secondary repo-picker__toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        data-testid="repo-picker-toggle"
      >
        <Github aria-hidden="true" /> {open ? "Close" : "Change repository"}
      </button>

      {open ? (
        <div className="repo-picker__popover" role="dialog" aria-label="Select a repository" data-testid="repo-picker-popover">
          <button type="button" className="btn btn-icon repo-picker__close" aria-label="Close repository picker" onClick={() => setOpen(false)}>
            <X aria-hidden="true" />
          </button>

          <label className="repo-picker__field">
            <span className="repo-picker__field-label">Search</span>
            <span className="repo-picker__search-input-wrap">
              <Search aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder="Search repositories…"
                onChange={(event) => setQuery(event.target.value)}
                data-testid="repo-picker-search-input"
              />
            </span>
          </label>

          {query.trim() ? (
            <div className="repo-picker__section" data-testid="repo-picker-results">
              {searchState === "loading" ? (
                <p className="repo-picker__status" role="status" data-testid="repo-picker-search-loading">
                  <Loader2 aria-hidden="true" className="repo-picker__spinner" /> Searching…
                </p>
              ) : searchState === "error" ? (
                <p className="repo-picker__status repo-picker__status--error" role="alert" data-testid="repo-picker-search-error">
                  <AlertCircle aria-hidden="true" /> {searchError ?? "Repository search failed."}
                </p>
              ) : results.length === 0 ? (
                <p className="repo-picker__empty-state" data-testid="repo-picker-search-empty">No repositories match "{query.trim()}".</p>
              ) : (
                <ul className="repo-picker__list" data-testid="repo-picker-search-list">
                  {results.map((item) => (
                    <li key={item.fullName}>
                      <button
                        type="button"
                        className="repo-picker__result"
                        onClick={() => selectRepo(item.fullName)}
                        disabled={Boolean(selecting)}
                        data-testid={`repo-picker-result-${item.fullName}`}
                      >
                        <span className="repo-picker__result-name">{item.fullName}</span>
                        {item.private ? <span className="repo-picker__result-badge">Private</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="repo-picker__section" data-testid="repo-picker-recents">
              <span className="repo-picker__section-label">
                <Clock aria-hidden="true" /> Recent
              </span>
              {recents.length === 0 ? (
                <p className="repo-picker__empty-state" data-testid="repo-picker-recents-empty">No recently used repositories yet.</p>
              ) : (
                <ul className="repo-picker__list" data-testid="repo-picker-recents-list">
                  {recents.map((entry) => (
                    <li key={entry.repo}>
                      <button
                        type="button"
                        className="repo-picker__result"
                        onClick={() => selectRepo(entry.repo)}
                        disabled={Boolean(selecting)}
                        data-testid={`repo-picker-recent-${entry.repo}`}
                      >
                        <span className="repo-picker__result-name">{entry.repo}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <form className="repo-picker__manual" onSubmit={handleManualSubmit}>
            <label className="repo-picker__field">
              <span className="repo-picker__field-label">Manual entry</span>
              <input
                type="text"
                value={manualEntry}
                placeholder="owner/repo"
                onChange={(event) => setManualEntry(event.target.value)}
                data-testid="repo-picker-manual-input"
              />
            </label>
            <button type="submit" className="btn btn-primary repo-picker__manual-submit" disabled={Boolean(selecting)} data-testid="repo-picker-manual-submit">
              {selecting ? <Loader2 aria-hidden="true" className="repo-picker__spinner" /> : "Use repository"}
            </button>
          </form>

          {manualError ? (
            <p className="repo-picker__status repo-picker__status--error" role="alert" data-testid="repo-picker-manual-error">
              <AlertCircle aria-hidden="true" /> {manualError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default RepoPicker;
