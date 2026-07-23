import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { createElement } from "react";
import { GitHubPmView } from "./GitHubPmView.js";

export function GitHubPmDashboardView({ context }: { context?: PluginDashboardViewContext }) {
  return createElement(GitHubPmView, { context });
}

export default GitHubPmDashboardView;
export { GitHubPmView };
