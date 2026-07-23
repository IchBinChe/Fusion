import { definePlugin } from "@fusion/plugin-sdk";
import type { FusionPlugin } from "@fusion/plugin-sdk";
import { githubPmSettingsSchema, GITHUB_PM_PLUGIN_ID } from "./settings.js";
import { githubPmRoutes } from "./routes.js";
import { githubPmTools } from "./tools.js";

const dashboardViews = [
  {
    viewId: "github-pm",
    label: "GitHub PM",
    componentPath: "./dashboard-view",
    icon: "Github",
    placement: "more" as const,
    order: 60,
    description: "Manage any GitHub repository's issues, discussions, Projects v2 boards, labels, and milestones without leaving Fusion.",
  },
];

/*
FNXC:GitHubPm 2026-07-24-00:00:
FUSI-001 scaffolds fusion-plugin-github-pm following the fusion-plugin-linear-import
precedent: plugin-owned settings, routes, tools, and dashboard-view metadata only.
No host-owned /api/github-pm routes and no core GitHub PM settings -- Fusion should
not grow a second, host-side GitHub PM integration surface. Keep this server entry
free of React/CSS imports. Real GitHub API calls, the layered auth resolver, and the
any-repo picker are deliberately deferred to FUSI-002/FUSI-003/FUSI-004.
*/
const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: GITHUB_PM_PLUGIN_ID,
    name: "GitHub PM",
    version: "0.1.0",
    description: "GitHub-native project management for any repository: issues, discussions, Projects v2 boards, labels, and milestones from inside Fusion.",
    author: "Fusion",
    fusionVersion: ">=0.1.0",
    settingsSchema: githubPmSettingsSchema,
  },
  state: "installed",
  hooks: {},
  routes: githubPmRoutes,
  tools: githubPmTools,
  dashboardViews,
});

export default plugin;
export { githubPmSettingsSchema, resolveGitHubPmSettings, hasPersonalAccessToken, GITHUB_PM_PLUGIN_ID } from "./settings.js";
export { githubPmRoutes } from "./routes.js";
export { githubPmTools } from "./tools.js";
export {
  GitHubClient,
  GitHubApiError,
  isGitHubApiError,
  githubErrorToResponse,
  redactSensitiveText,
  parseNextLinkUrl,
  normalizeGitHubLabelColor,
  GITHUB_REST_BASE_URL,
  GITHUB_GRAPHQL_ENDPOINT,
  GITHUB_API_VERSION,
} from "./github-client.js";
export type {
  GitHubApiErrorCode,
  GitHubClientOptions,
  GitHubListPage,
  GitHubPageInfo,
  GitHubGraphQlConnection,
  GitHubIssueListOptions,
  GitHubIssueListItem,
  GitHubLabelListOptions,
  GitHubLabel,
  GitHubTokenScopes,
  GitHubDiscussionListOptions,
  GitHubDiscussionListItem,
  GitHubIssueUser,
  GitHubIssueLabel,
  GitHubIssueMilestone,
  GitHubIssueDetail,
  GitHubIssueComment,
  GitHubIssueCommentsPage,
  GitHubListIssueCommentsOptions,
  GitHubTimelineEventType,
  GitHubTimelineEvent,
  GitHubListIssueTimelineOptions,
  GitHubIssueListPageOptions,
  GitHubIssueLabelSummary,
  GitHubIssueAssigneeSummary,
  GitHubIssueSummary,
  GitHubIssueListPage,
  GitHubIssueSearchOptions,
  GitHubIssueSearchPage,
  GitHubMilestone,
  GitHubRepositoryFeatures,
  GitHubRestLabelSummary,
  CreateLabelInput,
  UpdateLabelInput,
  GitHubLabelWithUsage,
} from "./github-client.js";
export { GITHUB_TIMELINE_KEY_EVENTS } from "./github-client.js";
export {
  aggregateRepoSignal,
  buildProposalSystemPrompt,
  buildProposalUserPrompt,
  parseProposalResponse,
  generateTaxonomyProposal,
} from "./taxonomy-proposal.js";
export type {
  TaxonomyLabel,
  TaxonomyField,
  TaxonomyFieldType,
  TaxonomyCategory,
  TaxonomyProposal,
  TaxonomyProposalContent,
  TaxonomyProposalStatus,
  TaxonomyProposalSourceStats,
  RepoSignal,
  RepoSignalInput,
  LabelFrequency,
  DiscussionCategorySummary,
  ParseProposalResult,
  GenerateTaxonomyProposalOptions,
  GenerateTaxonomyProposalResult,
} from "./taxonomy-proposal.js";
export {
  TAXONOMY_PROPOSAL_STATE_SETTING_ID,
  parseTaxonomyState,
  parseTaxonomyStateFromSettings,
  serializeTaxonomyState,
  getRepoProposals,
  nextProposalVersion,
  appendDraftProposal,
  editDraftProposal,
  setProposalStatus,
  getProposal,
} from "./taxonomy-store.js";
export type { RepoTaxonomyProposals, TaxonomyProposalStateMap } from "./taxonomy-store.js";
export {
  taxonomyRoutes,
  postTaxonomyPropose,
  getTaxonomyProposals,
  putTaxonomyAccept,
  putTaxonomyReject,
  putTaxonomyEdit,
} from "./taxonomy-routes.js";
/*
FNXC:GithubPmAuth 2026-07-24-00:25:
FUSI-003's GitHub client (and any future plugin route/tool) must consume the resolved
token through this single resolver -- never read process.env.GITHUB_TOKEN or shell out
to gh a second time. Re-export the resolver + scope-probe + diagnostics surface here so
those consumers can `import { resolveGitHubAuth, resolveGitHubToken } from "@fusion-plugin-examples/github-pm"`
instead of duplicating auth logic.
*/
export {
  resolveGitHubAuth,
  resolveGitHubToken,
  probeGitHubScopes,
  probeGitHubScopesCached,
  resetScopeProbeCache,
  mapScopesToCapabilities,
  getGitHubAuthDiagnostics,
  fingerprintToken,
  type GitHubAuthSource,
  type GitHubAuthResult,
  type GitHubScopeProbeStatus,
  type GitHubScopeProbeResult,
  type CapabilityState,
  type GitHubCapabilities,
  type GitHubAuthDiagnostics,
} from "./auth.js";
export {
  normalizeRepoKey,
  defaultRepoConfig,
  parseRepoConfigs,
  parseRepoConfigsFromSettings,
  serializeRepoConfigs,
  resolveRepoConfig,
  upsertRepoConfig,
  resolveSelectedRepo,
  SELECTED_REPO_SETTING_ID,
  REPO_CONFIG_STATE_SETTING_ID,
  type RepoAutonomyMode,
  type RepoViewPreferences,
  type RepoConfig,
  type RepoConfigMap,
} from "./repo-config.js";
export { repoConfigRoutes, getRepoConfig, putRepoConfig, selectRepoConfig } from "./repo-config-routes.js";
export { resolveRepoCapabilities } from "./repo-capabilities.js";
export type { RepoCapabilities, RepoCapabilityTabId, TabCapability, TabCapabilityReason, ResolveRepoCapabilitiesOptions } from "./repo-capabilities.js";
export { repoCapabilitiesRoutes, getRepoCapabilities } from "./repo-capabilities-routes.js";
/*
FNXC:GithubPmCapabilities 2026-07-24-09:40:
FUSI-009: `tab-capabilities.ts` has zero React/JSX dependency (only types + pure functions), so
it is safe to re-export from this server entry point same as every other non-React module
above. `useRepoCapabilities.ts` (a React hook) and `TabCapabilityNotice.tsx` (a JSX component)
are deliberately NOT re-exported here -- per this file's FUSI-001 constraint ("Keep this server
entry free of React/CSS imports"), any React-dependent module is imported directly by the
client view (GitHubPmView.tsx) rather than funneled through this server barrel.
*/
export { mapRepoCapabilitiesToTabs, capabilityForTab, GITHUB_PM_CAPABILITY_TAB_ORDER, type TabGating } from "./tab-capabilities.js";
export { issueRoutes, getIssueDetail, getIssueComments } from "./issue-routes.js";
export { issuesRoutes, getIssuesList, getIssuesFilterOptions } from "./issues-routes.js";
export { subscribeIssuesChanged, notifyIssuesChanged, type IssueMutationKind, type IssuesChangedDetail } from "./issues-events.js";
/*
FNXC:GithubPmIssues 2026-07-24-05:40:
FUSI-014 re-exports: the write-input types (GitHubIssueDetail/GitHubIssueComment are already
re-exported above from FUSI-013), the write-route array + handlers, and the new agent tools.
Mirrors the taxonomy/repo-config/issues re-export precedent -- one export block per feature.
*/
export type { CreateIssueInput, UpdateIssueInput, SetIssueStateInput } from "./github-client.js";
export {
  issueWriteRoutes,
  postIssueCreate,
  putIssueUpdate,
  putIssueState,
  postIssueComment,
  putIssueComment,
} from "./issue-write-routes.js";
export {
  githubPmCreateIssueTool,
  githubPmEditIssueTool,
  githubPmCommentIssueTool,
  githubPmSetIssueStateTool,
} from "./tools.js";
/*
FNXC:GithubPmLabels 2026-07-24-11:40:
KB-002 re-exports: the label-routes array + handlers and the three new label agent tools.
Mirrors the FUSI-014 issue-write re-export block precedent exactly -- one export block per
feature. LabelsPanel.tsx/LabelsPanel.css are deliberately NOT re-exported here (React/CSS
modules stay out of this server entry point per the FUSI-001 constraint noted above).
*/
export {
  labelRoutes,
  getLabelsList,
  postLabelCreate,
  putLabelUpdate,
  postLabelDelete,
} from "./label-routes.js";
export {
  githubPmCreateLabelTool,
  githubPmUpdateLabelTool,
  githubPmDeleteLabelTool,
} from "./tools.js";
/*
FNXC:GithubPmMilestones 2026-07-25-00:45:
KB-003 re-exports: the milestone write-input types, the milestone routes array + handlers, and
the milestone agent tools. Same one-export-block-per-feature precedent as every earlier block
in this file; kept as its own block (rather than merged into the FUSI-014 issue block above) so
KB-002's sibling labels re-export block lands without a merge conflict here.
*/
export type { GitHubListMilestonesOptions, CreateMilestoneInput, UpdateMilestoneInput, SetMilestoneStateInput } from "./github-client.js";
export {
  milestoneRoutes,
  getMilestonesList,
  postMilestoneCreate,
  putMilestoneUpdate,
  putMilestoneState,
  postMilestoneDelete,
  postMilestoneReassignOpenIssues,
} from "./milestone-routes.js";
export {
  githubPmCreateMilestoneTool,
  githubPmUpdateMilestoneTool,
  githubPmSetMilestoneStateTool,
  githubPmDeleteMilestoneTool,
} from "./tools.js";
/*
FNXC:GithubPmDiscussions 2026-07-25-12:30:
KB-005 re-exports: the discussion-browse client types/methods (already declared in
github-client.ts, re-exported here following the FUSI-014/KB-002/KB-003 one-export-block-per-
feature precedent) and the discussion-browse read-route array + handlers. DiscussionsPanel.tsx/
DiscussionsPanel.css are deliberately NOT re-exported here (React/CSS modules stay out of this
server entry point per the FUSI-001 constraint noted at the top of this file). This is a
READ-ONLY feature -- no write route, no agent tool is added by this block.
*/
export { buildDiscussionSearchQuery } from "./github-client.js";
export type { GitHubDiscussionCategory, GitHubDiscussionBrowseItem, GitHubDiscussionBrowseOptions } from "./github-client.js";
export { discussionRoutes, getDiscussionCategories, getDiscussionsList } from "./discussion-routes.js";
/*
FNXC:GithubPmDiscussions 2026-07-25-16:00:
KB-006 re-exports: the discussion DETAIL client types/methods (declared in github-client.ts,
re-exported here following the KB-005 one-export-block-per-feature precedent), the new
detail/comments/replies/post-comment route handlers (extending the SAME `discussionRoutes`
array already re-exported above), and the add-discussion-comment agent tool.
DiscussionDetailView.tsx/DiscussionDetailView.css are deliberately NOT re-exported here
(React/CSS modules stay out of this server entry point per the FUSI-001 constraint noted at
the top of this file).
*/
export type {
  GitHubDiscussionUser,
  GitHubDiscussionReply,
  GitHubDiscussionComment,
  GitHubDiscussionDetail,
  GitHubDiscussionCommentsPage,
  GitHubDiscussionRepliesPage,
  CreateDiscussionCommentInput,
  GitHubDiscussionCreatedComment,
} from "./github-client.js";
export {
  getDiscussionDetailRoute,
  getDiscussionCommentsRoute,
  getDiscussionRepliesRoute,
  postDiscussionComment,
} from "./discussion-routes.js";
export { githubPmAddDiscussionCommentTool } from "./tools.js";
