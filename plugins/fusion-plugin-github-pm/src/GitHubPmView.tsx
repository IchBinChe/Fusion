import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Github, Loader2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { AuthDiagnosticsPanel } from "./AuthDiagnosticsPanel.js";
import { TaxonomyProposalPanel } from "./TaxonomyProposalPanel.js";
import { GITHUB_PM_TABS, GitHubPmTabs, githubPmTabButtonId, githubPmTabPanelId, type GitHubPmTabId } from "./GitHubPmTabs.js";
import "./GitHubPmView.css";

type StatusState = "loading" | "configured" | "unconfigured" | "error";

interface StatusResponse {
  ok?: boolean;
  error?: string;
  configured?: boolean;
  autonomy?: string;
  defaultRepo?: string | null;
}

interface RepoConfigResponse {
  ok?: boolean;
  error?: string;
  selectedRepo?: string | null;
}

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

function projectQuery(context?: PluginDashboardViewContext): string {
  const params = new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function getStatus(context?: PluginDashboardViewContext): Promise<StatusResponse> {
  const response = await fetch(`${PLUGIN_BASE}/status${projectQuery(context)}`);
  const json = (await response.json().catch(() => ({}))) as StatusResponse;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `GitHub PM status failed with status ${response.status}.`);
  }
  return json;
}

/*
FNXC:GithubPmTaxonomy 2026-07-24-00:30:
FUSI-005: the taxonomy panel operates on "the currently selected repo" (FUSI-004's
selectedRepo, falling back to the plugin's configured defaultRepo when nothing has
been explicitly selected yet -- there is no repo-picker UI in this view yet, so this
is the best available signal of "the repo the operator means"). Read-only: this view
never writes repo selection, it only reads it via GET /repo-config.

FNXC:GitHubPm 2026-07-24-02:00:
FUSI-008 seam: the repo-context header sources its value from GET
/repo-config's `selectedRepo` field, which is itself built server-side by
FUSI-004's `resolveSelectedRepo(settings)` -- this view never reimplements
selection persistence. A failed/errored repo-config fetch degrades quietly to
"no repository selected" (falls back to /status's `defaultRepo` when present)
rather than surfacing a second error banner; the /status error path already
covers the plugin-configuration-broken case.
*/
async function getSelectedRepo(context?: PluginDashboardViewContext): Promise<string | null> {
  const response = await fetch(`${PLUGIN_BASE}/repo-config${projectQuery(context)}`);
  const json = (await response.json().catch(() => ({}))) as RepoConfigResponse;
  if (!response.ok || json.ok === false) return null;
  return json.selectedRepo ?? null;
}

function StatusBadge({ state, message }: { state: StatusState; message?: string }) {
  const className = state === "configured" ? "auth" : state === "unconfigured" ? "warning" : state === "error" ? "error" : "info";
  const Icon = state === "configured" ? CheckCircle2 : state === "loading" ? Loader2 : AlertCircle;
  return (
    <span className={`github-pm-view__status github-pm-view__status--${className}`} aria-live="polite">
      <Icon aria-hidden="true" />
      {message ?? (state === "configured" ? "Configured" : state === "loading" ? "Checking status" : state === "unconfigured" ? "Not configured" : "Status unavailable")}
    </span>
  );
}

/*
FNXC:GitHubPm 2026-07-24-02:10:
Repo-context header (FUSI-008). Shows the currently-selected repo, sourced via
getSelectedRepo() above, or a "No repository selected" affordance. The empty
`github-pm-view__repo-picker-slot` div is a deliberate, currently-unfilled
mount point: FUSI-007's repo-picker UI attaches here without this shell being
re-architected. Do not delete this slot even though it renders nothing today.
*/
function RepoContextHeader({ selectedRepo, loading }: { selectedRepo: string | null; loading: boolean }) {
  return (
    <div className="github-pm-view__repo-context" data-testid="github-pm-repo-context">
      <span className="github-pm-view__repo-context-label">Repository</span>
      {loading ? (
        <span className="github-pm-view__repo-context-value github-pm-view__repo-context-value--loading">
          <Loader2 aria-hidden="true" /> Loading…
        </span>
      ) : selectedRepo ? (
        <span className="github-pm-view__repo-context-value" data-testid="github-pm-repo-context-selected">
          {selectedRepo}
        </span>
      ) : (
        <span className="github-pm-view__repo-context-value github-pm-view__repo-context-value--empty" data-testid="github-pm-repo-context-empty">
          No repository selected
        </span>
      )}
      {/* Seam for FUSI-007's repo picker (search/recents/manual owner/repo entry). Intentionally empty. */}
      <div className="github-pm-view__repo-picker-slot" data-testid="github-pm-repo-picker-slot" />
    </div>
  );
}

const TAB_PLACEHOLDER_COPY: Record<GitHubPmTabId, string> = {
  issues: "Issue list, detail, create/edit, comments, labels, and assignment arrive in the Issues Core milestone.",
  labels: "Label management arrives alongside Issues Core.",
  milestones: "Milestone management arrives alongside Issues Core.",
  discussions: "Discussion browsing and reply management arrive in a later Foundation-milestone surface.",
  projects: "Projects v2 board management arrives in a later Foundation-milestone surface.",
  triage: "AI-assisted taxonomy proposal and classification review arrive in the AI Structure-Generation & Classification milestone.",
};

/*
FNXC:GitHubPm 2026-07-24-02:15:
Each tab panel stays MOUNTED at all times; only the `hidden` attribute toggles
visibility. This is required so per-tab local state (inputs, scroll position,
in-flight local UI state) survives a switch-away-and-back -- conditionally
unmounting an inactive panel would destroy that state, which the FUSI-008
acceptance criteria explicitly forbid.
*/
function TabPlaceholderPanel({ tabId }: { tabId: GitHubPmTabId }) {
  return <p className="github-pm-view__tab-placeholder-copy">{TAB_PLACEHOLDER_COPY[tabId]}</p>;
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
Placeholder view for FUSI-001. Renders a status badge from the plugin-owned
/status route (settings-presence only, no live GitHub call) and explains that
the repo picker + issue management surfaces land in later Foundation-milestone
tasks (FUSI-002/003/004). Never renders the raw personalAccessToken value.

FNXC:GithubPmAuth 2026-07-24-00:35:
FUSI-002 mounts the layered-auth diagnostics panel (source + per-capability
scope support, with an actionable 'project' scope warning) directly below the
settings-presence status badge above. This is the ONLY place
AuthDiagnosticsPanel is rendered -- the repo picker/issues/discussions/Projects
v2 surfaces in later FUSI tasks reuse this same view rather than duplicating
the panel.

FNXC:GitHubPm 2026-07-24-02:20:
FUSI-008 turns this scaffold into the durable view SHELL every later
Foundation surface plugs into: a repo-context header (reading the persisted
selection via GET /repo-config, which wraps FUSI-004's resolveSelectedRepo)
plus an accessible, token-styled tablist for the six declared surfaces
(Issues, Labels, Milestones, Discussions, Projects, Triage). Two seams are
deliberately left unfilled for downstream tasks rather than re-architected
later: (1) `.github-pm-view__repo-picker-slot` in RepoContextHeader is
FUSI-007's mount point for the real repo picker; (2) `GitHubPmTab.disabled` /
`disabledReason` (see GitHubPmTabs.tsx) is FUSI-009's capability-gating seam
to grey out a tab with a reason once repo/scope context makes a surface
unusable. Tab panels stay mounted-but-hidden (never conditionally unmounted)
so per-tab local state survives a tab round-trip. The status badge and
AuthDiagnosticsPanel keep rendering unchanged, just relocated into the shell.
*/
export function GitHubPmView({ context }: { context?: PluginDashboardViewContext }) {
  const [status, setStatus] = useState<StatusState>("loading");
  const [statusMessage, setStatusMessage] = useState<string>();
  const [autonomy, setAutonomy] = useState<string>();
  const [defaultRepo, setDefaultRepo] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedRepoLoading, setSelectedRepoLoading] = useState<boolean>(true);
  const [activeTab, setActiveTab] = useState<GitHubPmTabId>(GITHUB_PM_TABS[0].id);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getStatus(context)
      .then((result) => {
        if (cancelled) return;
        setAutonomy(result.autonomy);
        setDefaultRepo(result.defaultRepo ?? null);
        if (result.configured) {
          setStatus("configured");
          setStatusMessage("GitHub PM configured");
        } else {
          setStatus("unconfigured");
          setStatusMessage("Not configured");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : "GitHub PM status check failed");
      });
    return () => {
      cancelled = true;
    };
  }, [context?.projectId]);

  useEffect(() => {
    let cancelled = false;
    setSelectedRepoLoading(true);
    getSelectedRepo(context)
      .then((repo) => {
        if (cancelled) return;
        setSelectedRepo(repo);
      })
      .catch(() => {
        if (cancelled) return;
        setSelectedRepo(null);
      })
      .finally(() => {
        if (cancelled) return;
        setSelectedRepoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [context?.projectId]);

  const repoContextValue = selectedRepo ?? defaultRepo;

  return (
    <section className="github-pm-view" aria-labelledby="github-pm-heading">
      <header className="github-pm-view__header">
        <div>
          <p className="github-pm-view__eyebrow">Bundled plugin</p>
          <h1 id="github-pm-heading" className="github-pm-view__title">
            <Github aria-hidden="true" /> GitHub PM
          </h1>
          <p className="github-pm-view__subtitle">GitHub-native project management for any repository, without leaving Fusion.</p>
        </div>
        <StatusBadge state={status} message={statusMessage} />
      </header>

      <RepoContextHeader selectedRepo={repoContextValue} loading={selectedRepoLoading} />

      {status === "unconfigured" ? (
        <p className="github-pm-view__meta" data-testid="github-pm-unconfigured-hint">
          Add a default repository or personal access token in Plugin Manager settings to get started.
        </p>
      ) : null}
      {autonomy ? <p className="github-pm-view__meta">Default triage autonomy: {autonomy}</p> : null}

      <GitHubPmTabs activeTab={activeTab} onChange={setActiveTab} />

      <div className="github-pm-view__panels">
        {GITHUB_PM_TABS.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={githubPmTabPanelId(tab.id)}
            aria-labelledby={githubPmTabButtonId(tab.id)}
            className="github-pm-view__panel card"
            data-testid={`github-pm-panel-${tab.id}`}
            hidden={tab.id !== activeTab}
          >
            <TabPlaceholderPanel tabId={tab.id} />
          </div>
        ))}
      </div>

      <AuthDiagnosticsPanel context={context} />
      <TaxonomyProposalPanel context={context} repo={repoContextValue} />
    </section>
  );
}

export default GitHubPmView;
