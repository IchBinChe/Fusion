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
export { issueRoutes, getIssueDetail, getIssueComments } from "./issue-routes.js";
export { issuesRoutes, getIssuesList, getIssuesFilterOptions } from "./issues-routes.js";
export { subscribeIssuesChanged, notifyIssuesChanged, type IssueMutationKind, type IssuesChangedDetail } from "./issues-events.js";
