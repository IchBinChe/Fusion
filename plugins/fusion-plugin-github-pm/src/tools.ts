import type { PluginContext, PluginToolDefinition, PluginToolResult } from "@fusion/plugin-sdk";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";
import { GitHubClient, isGitHubApiError } from "./github-client.js";
import { resolveGitHubAuth } from "./auth.js";
import { normalizeRepoKey, resolveSelectedRepo } from "./repo-config.js";

function textResult(text: string, details?: Record<string, unknown>, isError = false): PluginToolResult {
  return { content: [{ type: "text", text }], details, isError };
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
Placeholder tool (FUSI-001) exercising tool registration ahead of real issue
management tools. Reports configured/not-configured from settings presence
only; never returns the PAT value.
*/
export const githubPmStatusTool: PluginToolDefinition = {
  name: "github_pm_status",
  description: "Report whether the GitHub PM plugin has a default repository or personal access token configured.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: async (_params, ctx: PluginContext) => {
    const settings = resolveGitHubPmSettings(ctx.settings);
    const configured = hasPersonalAccessToken(ctx.settings) || Boolean(settings.defaultRepo);
    const text = configured
      ? `GitHub PM is configured (autonomy: ${settings.defaultAutonomy}${settings.defaultRepo ? `, default repo: ${settings.defaultRepo}` : ""}).`
      : "GitHub PM is not configured yet. Add a default repository or personal access token in Plugin Manager settings.";
    return textResult(text, { configured, autonomy: settings.defaultAutonomy, defaultRepo: settings.defaultRepo ?? null });
  },
};

/*
FNXC:GithubPmIssues 2026-07-24-05:20:
FUSI-014 agent-write tools: create/edit/comment/close-or-reopen. Each resolves repo (explicit
`repo` param, else `resolveSelectedRepo(ctx.settings)`) and auth (`resolveGitHubAuth`) exactly
like issue-write-routes.ts, then calls the matching GitHubClient write method and reports its
authoritative post-write result via textResult. Tools run server-side in the agent execution
context and deliberately do NOT call the browser-only `notifyIssuesChanged` pub/sub (that is
IssueWritePanel.tsx's job) -- an agent-initiated write is picked up by any mounted IssuesPanel
on its next natural re-fetch, not via this event bus.
*/

async function resolveRepoAndClient(
  ctx: PluginContext,
  repoParam: unknown,
): Promise<{ owner: string; repo: string; client: GitHubClient } | PluginToolResult> {
  const repo = normalizeRepoKey(repoParam) ?? resolveSelectedRepo(ctx.settings);
  if (!repo) {
    return textResult("No repository was specified and none is selected. Provide a 'repo' parameter (owner/repo) or select a default repo first.", undefined, true);
  }
  const auth = await resolveGitHubAuth(ctx.settings);
  if (!auth.authenticated || !auth.token) {
    return textResult("GitHub PM is not authenticated. Add a PAT in Plugin Manager settings, set GITHUB_TOKEN, or run 'gh auth login'.", undefined, true);
  }
  const [owner, repoName] = repo.split("/");
  return { owner, repo: repoName, client: new GitHubClient(auth.token) };
}

function isToolResult(value: unknown): value is PluginToolResult {
  return typeof value === "object" && value !== null && "content" in value;
}

export const githubPmCreateIssueTool: PluginToolDefinition = {
  name: "github_pm_create_issue",
  description: "Create a new GitHub issue with a title, optional body, labels, assignees, and milestone.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      title: { type: "string", description: "Issue title (required)." },
      body: { type: "string", description: "Issue body markdown." },
      labels: { type: "array", items: { type: "string" }, description: "Label names to apply." },
      assignees: { type: "array", items: { type: "string" }, description: "Assignee logins." },
      milestone: { type: "number", description: "Milestone number to attach." },
    },
    required: ["title"],
  },
  execute: async (params, ctx: PluginContext) => {
    const title = typeof (params as Record<string, unknown>).title === "string" ? ((params as Record<string, unknown>).title as string).trim() : "";
    if (!title) return textResult("A non-empty 'title' is required to create an issue.", undefined, true);
    const resolved = await resolveRepoAndClient(ctx, (params as Record<string, unknown>).repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const p = params as Record<string, unknown>;
      const issue = await resolved.client.createIssue(resolved.owner, resolved.repo, {
        title,
        body: typeof p.body === "string" ? p.body : undefined,
        labels: Array.isArray(p.labels) ? (p.labels as string[]) : undefined,
        assignees: Array.isArray(p.assignees) ? (p.assignees as string[]) : undefined,
        milestone: typeof p.milestone === "number" ? p.milestone : undefined,
      });
      return textResult(`Created issue #${issue.number}: ${issue.title}`, { issue });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Issue creation failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmEditIssueTool: PluginToolDefinition = {
  name: "github_pm_edit_issue",
  description: "Edit an existing GitHub issue's title and/or body.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Issue number to edit (required)." },
      title: { type: "string", description: "New title." },
      body: { type: "string", description: "New body markdown." },
    },
    required: ["number"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    if (!Number.isFinite(number) || number <= 0) return textResult("A positive integer 'number' is required to edit an issue.", undefined, true);
    if (typeof p.title !== "string" && typeof p.body !== "string") return textResult("At least one of 'title' or 'body' must be supplied.", undefined, true);
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const issue = await resolved.client.updateIssue(resolved.owner, resolved.repo, number, {
        title: typeof p.title === "string" ? p.title : undefined,
        body: typeof p.body === "string" ? p.body : undefined,
      });
      return textResult(`Updated issue #${issue.number}: ${issue.title}`, { issue });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Issue update failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmCommentIssueTool: PluginToolDefinition = {
  name: "github_pm_comment_issue",
  description: "Add a comment to a GitHub issue.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Issue number to comment on (required)." },
      body: { type: "string", description: "Comment body markdown (required)." },
    },
    required: ["number", "body"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    const body = typeof p.body === "string" ? p.body.trim() : "";
    if (!Number.isFinite(number) || number <= 0 || !body) return textResult("A positive integer 'number' and a non-empty 'body' are required to comment.", undefined, true);
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const comment = await resolved.client.createIssueComment(resolved.owner, resolved.repo, number, body);
      return textResult(`Commented on issue #${number}.`, { comment });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Issue comment failed unexpectedly.", undefined, true);
    }
  },
};

const CLOSE_STATE_REASONS = new Set(["completed", "not_planned"]);

export const githubPmSetIssueStateTool: PluginToolDefinition = {
  name: "github_pm_set_issue_state",
  description: "Close (with an optional completed/not_planned reason) or reopen a GitHub issue.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Issue number (required)." },
      state: { type: "string", enum: ["open", "closed"], description: "Target state (required)." },
      stateReason: { type: "string", enum: ["completed", "not_planned"], description: "Close reason, only meaningful when state is 'closed'." },
    },
    required: ["number", "state"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    const state = p.state === "open" || p.state === "closed" ? p.state : undefined;
    if (!Number.isFinite(number) || number <= 0 || !state) return textResult("A positive integer 'number' and state 'open' or 'closed' are required.", undefined, true);
    const stateReason = typeof p.stateReason === "string" && CLOSE_STATE_REASONS.has(p.stateReason) ? (p.stateReason as "completed" | "not_planned") : undefined;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const issue = await resolved.client.setIssueState(resolved.owner, resolved.repo, number, { state, stateReason });
      return textResult(`Issue #${issue.number} is now ${issue.state}.`, { issue });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Issue state change failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmTools: PluginToolDefinition[] = [
  githubPmStatusTool,
  githubPmCreateIssueTool,
  githubPmEditIssueTool,
  githubPmCommentIssueTool,
  githubPmSetIssueStateTool,
];
