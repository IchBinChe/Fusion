import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Github, Loader2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { AuthDiagnosticsPanel } from "./AuthDiagnosticsPanel.js";
import { TaxonomyProposalPanel } from "./TaxonomyProposalPanel.js";
import { GITHUB_PM_TABS, GitHubPmTabs, githubPmTabButtonId, githubPmTabPanelId, type GitHubPmTab, type GitHubPmTabId } from "./GitHubPmTabs.js";
import { IssuesPanel } from "./IssuesPanel.js";
import { IssueWritePanel } from "./IssueWritePanel.js";
import { LabelsPanel } from "./LabelsPanel.js";
import { MilestonesPanel } from "./MilestonesPanel.js";
import { DiscussionsPanel } from "./DiscussionsPanel.js";
import { DiscussionDetailView } from "./DiscussionDetailView.js";
import { useRepoCapabilities } from "./useRepoCapabilities.js";
import { mapRepoCapabilitiesToTabs, type TabGating } from "./tab-capabilities.js";
import { TabCapabilityNotice } from "./TabCapabilityNotice.js";
import "./GitHubPmView.css";

type StatusState = "loading" | "configured" | "unconfigured" | "error";

interface StatusResponse {
  ok?: boolean;
  error?: string;
  configured?: boolean;
  autonomy?: string;
  defaultRepo?: string | null;
  /** FUSI-017: resolved confirmWrites gate flag; see GitHubPmView's confirmWrites state comment. */
  confirmWrites?: boolean;
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
  // FNXC:GithubPmLabels 2026-07-24-11:20: KB-002 fills the `labels` tabpanel with LabelsPanel below;
  // this entry is left in place (unused) for rollback/symmetry, same convention FUSI-012 used for `issues`.
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

FNXC:GithubPmIssues 2026-07-24-03:35:
FUSI-012 fills the `issues` tabpanel with the real `IssuesPanel` (list + filters + search +
sort + pagination), replacing its `TabPlaceholderPanel`. This is the ONLY structural change
FUSI-012 makes here: the other five tabs (labels/milestones/discussions/projects/triage) kept
their placeholder body at the time (KB-003 later fills `milestones` too -- see its own FNXC
note below), `TAB_PLACEHOLDER_COPY` stays intact (including its now-unused `issues`
entry, left in place for symmetry/rollback rather than deleted), and the tablist/repo-context
header/repo-picker slot/status badge/AuthDiagnosticsPanel are untouched. `IssuesPanel` renders
inside the SAME `github-pm-view__panel card` tabpanel div -- no second card wrapper.
*/
function TabPlaceholderPanel({ tabId }: { tabId: GitHubPmTabId }) {
  return <p className="github-pm-view__tab-placeholder-copy">{TAB_PLACEHOLDER_COPY[tabId]}</p>;
}

/*
FNXC:GithubPmIssues 2026-07-24-05:30:
FUSI-014 mounts `IssueWritePanel` directly beneath `IssuesPanel` inside the SAME `issues`
tabpanel body -- the write surface lives with the list it keeps live, per the task's mount
guidance. No second card wrapper: `IssueWritePanel` renders its own internal sections and
sits inside the existing `github-pm-view__panel card` tabpanel div.
*/
/*
FNXC:GithubPmCapabilities 2026-07-24-09:30:
FUSI-009 Step 5: when a tab is gated OFF (disabled: true), its panel renders
`TabCapabilityNotice` (the reason + fix path) INSTEAD of the tab's real feature/placeholder --
never a blank pane. A tab that stays enabled with an informational "unknown" note (e.g.
Projects on a fine-grained token) still renders its normal feature body; the note is only
surfaced through the tab's title/aria-disabled affordance in that case, matching "never
falsely block a tab" while still communicating the caveat. Panels stay mounted-but-hidden
regardless of gating state (existing FUSI-008 invariant) -- gating only changes what a panel
renders, never whether it stays mounted.
*/
function GitHubPmTabPanelBody({
  tabId,
  repo,
  context,
  confirmWrites,
  gating,
  selectedDiscussionNumber,
  onSelectDiscussion,
  onBackFromDiscussion,
}: {
  tabId: GitHubPmTabId;
  repo: string | null;
  context?: PluginDashboardViewContext;
  confirmWrites: boolean;
  gating?: TabGating;
  selectedDiscussionNumber: number | null;
  onSelectDiscussion: (discussionNumber: number) => void;
  onBackFromDiscussion: () => void;
}) {
  if (gating?.disabled) {
    return <TabCapabilityNotice message={gating.message} fix={gating.fix} reason={gating.reason} />;
  }
  if (tabId === "issues") {
    return (
      <>
        <IssuesPanel repo={repo} context={context} />
        <IssueWritePanel repo={repo} context={context} confirmWrites={confirmWrites} />
      </>
    );
  }
  /*
  FNXC:GithubPmLabels 2026-07-24-11:20:
  KB-002 fills the `labels` tabpanel with the real LabelsPanel (table + create/edit forms +
  delete-confirmation dialog), replacing its TabPlaceholderPanel -- the ONLY structural change
  this task makes here. The other four tabs (milestones/discussions/projects/triage) keep their
  placeholder body untouched, and LabelsPanel renders inside the SAME `github-pm-view__panel
  card` tabpanel div -- no second card wrapper.

  FNXC:GithubPmMilestones 2026-07-25-01:45:
  KB-003 fills the `milestones` tabpanel with the real `MilestonesPanel` (list + progress bars
  + overdue flags + create/edit/close/reopen/delete + the close-with-open-issues prompt),
  replacing its `TabPlaceholderPanel`. This is the ONLY structural change KB-003 makes here:
  the other four tabs (labels/discussions/projects/triage) keep their placeholder body,
  `TAB_PLACEHOLDER_COPY` stays intact (including its now-unused `milestones` entry, left in
  place for symmetry/rollback rather than deleted), and the tablist/repo-context header/status
  badge/AuthDiagnosticsPanel are untouched.
  */
  if (tabId === "labels") {
    return <LabelsPanel repo={repo} context={context} confirmWrites={confirmWrites} />;
  }
  if (tabId === "milestones") {
    return <MilestonesPanel repo={repo} context={context} confirmWrites={confirmWrites} />;
  }
  /*
  FNXC:GithubPmDiscussions 2026-07-25-12:20:
  KB-005 fills the `discussions` tabpanel with the real `DiscussionsPanel` (category rail +
  search/sort/answered filters + result list), replacing its `TabPlaceholderPanel`. This is
  the ONLY structural change KB-005 makes here: the other three tabs (projects/triage, and
  issues/labels/milestones already filled by earlier tasks) keep their existing body,
  `TAB_PLACEHOLDER_COPY` stays intact (including its now-unused `discussions` entry, left in
  place for symmetry/rollback rather than deleted), and the tablist/repo-context header/status
  badge/AuthDiagnosticsPanel are untouched. `DiscussionsPanel` is READ-ONLY (no write route,
  no `confirmWrites` prop) and renders inside the SAME `github-pm-view__panel card` tabpanel
  div -- no second card wrapper.
  */
  /*
  FNXC:GithubPmDiscussions 2026-07-25-15:30:
  KB-006 mounts `DiscussionDetailView` from the SAME `discussions` tabpanel, toggling between
  the browse panel and the detail view via `selectedDiscussionNumber` -- exactly the
  panel<->detail toggle FUSI-014's issues tab uses (mount once, no forked second surface). The
  `DiscussionsPanel`'s `onSelectDiscussion` callback drives `selectedDiscussionNumber` in the
  parent (`GitHubPmView`); `DiscussionDetailView`'s `onBack` clears it, returning to the browse
  panel. Both stay mounted-but-hidden semantics do NOT apply here (this is an internal toggle
  within an already-hidden-or-visible tabpanel, not the outer FUSI-008 tab mount contract).
  */
  if (tabId === "discussions") {
    if (repo && selectedDiscussionNumber !== null) {
      return (
        <DiscussionDetailView
          key={selectedDiscussionNumber}
          context={context}
          repo={repo}
          discussionNumber={selectedDiscussionNumber}
          confirmWrites={confirmWrites}
          onBack={onBackFromDiscussion}
        />
      );
    }
    return <DiscussionsPanel repo={repo} context={context} onSelectDiscussion={onSelectDiscussion} />;
  }
  return <TabPlaceholderPanel tabId={tabId} />;
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
  /*
  FNXC:GithubPmWriteGate 2026-07-24-06:30:
  FUSI-017: default true (ON) so a /status fetch that hasn't resolved yet (or ever fails to
  resolve) never leaves the write UI un-gated. Overwritten to the server-resolved value once
  /status responds; an absent `confirmWrites` field on the response (e.g. a stale server) is
  treated as ON via the `?? true` fallback below, not as OFF.
  */
  const [confirmWrites, setConfirmWrites] = useState<boolean>(true);
  /*
  FNXC:GithubPmDiscussions 2026-07-25-15:30:
  KB-006 selection state for the discussions tab's panel<->detail toggle. Reset to null
  whenever the repo context changes so a stale discussion number from a previous repo never
  leaks into a newly-selected repo's discussions tab.
  */
  const [selectedDiscussionNumber, setSelectedDiscussionNumber] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getStatus(context)
      .then((result) => {
        if (cancelled) return;
        setAutonomy(result.autonomy);
        setDefaultRepo(result.defaultRepo ?? null);
        setConfirmWrites(result.confirmWrites ?? true);
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

  useEffect(() => {
    setSelectedDiscussionNumber(null);
  }, [repoContextValue]);

  /*
  FNXC:GithubPmCapabilities 2026-07-24-09:35:
  FUSI-009 Step 5 wiring: the SINGLE capability fetch for the currently-selected repo, and the
  pure mapper turning its response into an ordered per-tab gating array. Every tab/panel below
  reads from this one `tabGating` map -- no component independently re-checks scope/feature
  state. `useRepoCapabilities` degrades a fetch failure to an all-tabs-available payload, so a
  probe outage never hard-blocks the whole shell.
  */
  const { capabilities: repoCapabilities } = useRepoCapabilities(repoContextValue, context);
  const tabGatingList = mapRepoCapabilitiesToTabs(repoCapabilities);
  const tabGatingById = new Map<GitHubPmTabId, TabGating>(tabGatingList.map((gating) => [gating.id, gating]));
  const gatedTabs: GitHubPmTab[] = GITHUB_PM_TABS.map((tab) => {
    const gating = tabGatingById.get(tab.id);
    return { ...tab, disabled: gating?.disabled ?? false, disabledReason: gating?.disabled ? gating.message : undefined };
  });

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

      <GitHubPmTabs tabs={gatedTabs} activeTab={activeTab} onChange={setActiveTab} />

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
            <GitHubPmTabPanelBody
              tabId={tab.id}
              repo={repoContextValue}
              context={context}
              confirmWrites={confirmWrites}
              gating={tabGatingById.get(tab.id)}
              selectedDiscussionNumber={selectedDiscussionNumber}
              onSelectDiscussion={setSelectedDiscussionNumber}
              onBackFromDiscussion={() => setSelectedDiscussionNumber(null)}
            />
          </div>
        ))}
      </div>

      <AuthDiagnosticsPanel context={context} />
      <TaxonomyProposalPanel context={context} repo={repoContextValue} />
    </section>
  );
}

export default GitHubPmView;
