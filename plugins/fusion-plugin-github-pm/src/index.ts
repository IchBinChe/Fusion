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
} from "./github-client.js";
