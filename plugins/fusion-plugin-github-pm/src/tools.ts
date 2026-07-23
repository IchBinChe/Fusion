import type { PluginContext, PluginToolDefinition, PluginToolResult } from "@fusion/plugin-sdk";
import { hasPersonalAccessToken, resolveGitHubPmSettings } from "./settings.js";
import { GitHubClient, isGitHubApiError, normalizeGitHubLabelColor } from "./github-client.js";
import type { GitHubDiscussionCreatedComment } from "./github-client.js";
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

/*
FNXC:GithubPmWriteGate 2026-07-24-06:20:
FUSI-017 shared tool guard, mirrors requireConfirmation in issue-write-routes.ts. Resolves
confirmWrites via resolveGitHubPmSettings(ctx.settings) and, when ON, requires an explicit
params.confirmed === true; otherwise returns an isError:true textResult. Called from every
one of the 4 write tools BEFORE resolveRepoAndClient/any client.* call, so an unconfirmed
call performs ZERO auth resolution and ZERO GitHub API calls. github_pm_status is read-only
and deliberately NOT gated.
*/
function requireToolConfirmation(ctx: PluginContext, confirmed: unknown): PluginToolResult | null {
  const settings = resolveGitHubPmSettings(ctx.settings);
  if (!settings.confirmWrites) return null;
  if (confirmed === true) return null;
  return textResult("This write requires confirmation. Re-run with confirmed:true, or disable 'Confirm writes' in GitHub PM plugin settings.", undefined, true);
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
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["title"],
  },
  execute: async (params, ctx: PluginContext) => {
    const title = typeof (params as Record<string, unknown>).title === "string" ? ((params as Record<string, unknown>).title as string).trim() : "";
    if (!title) return textResult("A non-empty 'title' is required to create an issue.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, (params as Record<string, unknown>).confirmed);
    if (confirmationBlocked) return confirmationBlocked;
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
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    if (!Number.isFinite(number) || number <= 0) return textResult("A positive integer 'number' is required to edit an issue.", undefined, true);
    if (typeof p.title !== "string" && typeof p.body !== "string") return textResult("At least one of 'title' or 'body' must be supplied.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
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
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number", "body"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    const body = typeof p.body === "string" ? p.body.trim() : "";
    if (!Number.isFinite(number) || number <= 0 || !body) return textResult("A positive integer 'number' and a non-empty 'body' are required to comment.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
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
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number", "state"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    const state = p.state === "open" || p.state === "closed" ? p.state : undefined;
    if (!Number.isFinite(number) || number <= 0 || !state) return textResult("A positive integer 'number' and state 'open' or 'closed' are required.", undefined, true);
    const stateReason = typeof p.stateReason === "string" && CLOSE_STATE_REASONS.has(p.stateReason) ? (p.stateReason as "completed" | "not_planned") : undefined;
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
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

/*
FNXC:GithubPmLabels 2026-07-24-10:40:
KB-002 label agent tools: create/update/delete, mirroring the FUSI-014 write-tool shape exactly
(requireToolConfirmation BEFORE resolveRepoAndClient/any client call, isGitHubApiError mapping,
token never echoed). The color validity check (normalizeGitHubLabelColor) runs BEFORE the
confirmation gate, same ordering as label-routes.ts's write handlers.
*/
export const githubPmCreateLabelTool: PluginToolDefinition = {
  name: "github_pm_create_label",
  description: "Create a new GitHub label with a name, a 6-hex-digit color, and an optional description.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      name: { type: "string", description: "Label name (required)." },
      color: { type: "string", description: "Six hex digits, with or without a leading '#' (required), e.g. 'd73a4a'." },
      description: { type: "string", description: "Label description." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["name", "color"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const rawColor = typeof p.color === "string" ? p.color : "";
    if (!name || !rawColor) return textResult("A non-empty 'name' and 'color' are required to create a label.", undefined, true);
    const color = normalizeGitHubLabelColor(rawColor);
    if (!color) return textResult(`Invalid label color "${rawColor}". Use six hex digits, e.g. "d73a4a".`, undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const label = await resolved.client.createLabel(resolved.owner, resolved.repo, {
        name,
        color,
        description: typeof p.description === "string" ? p.description : undefined,
      });
      return textResult(`Created label "${label.name}" (#${label.color}).`, { label });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Label creation failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmUpdateLabelTool: PluginToolDefinition = {
  name: "github_pm_update_label",
  description: "Rename (preserving issue associations via new_name), recolor, and/or re-describe an existing GitHub label.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      name: { type: "string", description: "Current label name (required)." },
      newName: { type: "string", description: "New label name. Sent as GitHub's new_name so issue associations are preserved." },
      color: { type: "string", description: "New six-hex-digit color, with or without a leading '#'." },
      description: { type: "string", description: "New description." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["name"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return textResult("A non-empty 'name' is required to update a label.", undefined, true);
    const newName = typeof p.newName === "string" ? p.newName : undefined;
    const rawColor = typeof p.color === "string" ? p.color : undefined;
    const description = typeof p.description === "string" ? p.description : undefined;
    if (newName === undefined && rawColor === undefined && description === undefined) {
      return textResult("At least one of 'newName', 'color', or 'description' must be supplied.", undefined, true);
    }
    let color: string | undefined;
    if (rawColor !== undefined) {
      const normalized = normalizeGitHubLabelColor(rawColor);
      if (!normalized) return textResult(`Invalid label color "${rawColor}". Use six hex digits, e.g. "d73a4a".`, undefined, true);
      color = normalized;
    }
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const label = await resolved.client.updateLabel(resolved.owner, resolved.repo, name, { newName, color, description });
      return textResult(`Updated label "${label.name}" (#${label.color}).`, { label });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Label update failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmDeleteLabelTool: PluginToolDefinition = {
  name: "github_pm_delete_label",
  description: "Delete an existing GitHub label by name. Removes it from any open issues it was applied to.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      name: { type: "string", description: "Label name to delete (required)." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["name"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) return textResult("A non-empty 'name' is required to delete a label.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      await resolved.client.deleteLabel(resolved.owner, resolved.repo, name);
      return textResult(`Deleted label "${name}".`, { deleted: name });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Label deletion failed unexpectedly.", undefined, true);
    }
  },
};

/*
FNXC:GithubPmMilestones 2026-07-25-01:00:
KB-003 agent-write tools mirroring the issue write tools above: create/update/set-state
(close/reopen)/delete. Each resolves repo+auth exactly like the issue tools
(resolveRepoAndClient) and gates confirmation BEFORE resolving repo/auth
(requireToolConfirmation), so an unconfirmed call performs ZERO auth resolution and ZERO
GitHub API calls -- same invariant the issue tools establish.
*/
export const githubPmCreateMilestoneTool: PluginToolDefinition = {
  name: "github_pm_create_milestone",
  description: "Create a new GitHub milestone with a title, optional description, due date, and state.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      title: { type: "string", description: "Milestone title (required)." },
      description: { type: "string", description: "Milestone description." },
      dueOn: { type: "string", description: "ISO-8601 due date." },
      state: { type: "string", enum: ["open", "closed"], description: "Initial state; defaults to open." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["title"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!title) return textResult("A non-empty 'title' is required to create a milestone.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const milestone = await resolved.client.createMilestone(resolved.owner, resolved.repo, {
        title,
        description: typeof p.description === "string" ? p.description : undefined,
        dueOn: typeof p.dueOn === "string" ? p.dueOn : undefined,
        state: p.state === "open" || p.state === "closed" ? p.state : undefined,
      });
      return textResult(`Created milestone #${milestone.number}: ${milestone.title}`, { milestone });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Milestone creation failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmUpdateMilestoneTool: PluginToolDefinition = {
  name: "github_pm_update_milestone",
  description: "Edit an existing GitHub milestone's title, description, and/or due date.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Milestone number to edit (required)." },
      title: { type: "string", description: "New title." },
      description: { type: "string", description: "New description." },
      dueOn: { type: "string", description: "New ISO-8601 due date. Pass an explicit JSON null to clear it." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    if (!Number.isFinite(number) || number <= 0) return textResult("A positive integer 'number' is required to edit a milestone.", undefined, true);
    const hasDueOn = Object.prototype.hasOwnProperty.call(p, "dueOn");
    if (typeof p.title !== "string" && typeof p.description !== "string" && !hasDueOn) {
      return textResult("At least one of 'title', 'description', or 'dueOn' must be supplied.", undefined, true);
    }
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const milestone = await resolved.client.updateMilestone(resolved.owner, resolved.repo, number, {
        title: typeof p.title === "string" ? p.title : undefined,
        description: typeof p.description === "string" ? p.description : undefined,
        dueOn: p.dueOn === null ? null : typeof p.dueOn === "string" ? p.dueOn : undefined,
      });
      return textResult(`Updated milestone #${milestone.number}: ${milestone.title}`, { milestone });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Milestone update failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmSetMilestoneStateTool: PluginToolDefinition = {
  name: "github_pm_set_milestone_state",
  description: "Close or reopen a GitHub milestone.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Milestone number (required)." },
      state: { type: "string", enum: ["open", "closed"], description: "Target state (required)." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number", "state"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    const state = p.state === "open" || p.state === "closed" ? p.state : undefined;
    if (!Number.isFinite(number) || number <= 0 || !state) return textResult("A positive integer 'number' and state 'open' or 'closed' are required.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const milestone = await resolved.client.setMilestoneState(resolved.owner, resolved.repo, number, { state });
      return textResult(`Milestone #${milestone.number} is now ${milestone.state}.`, { milestone });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Milestone state change failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmDeleteMilestoneTool: PluginToolDefinition = {
  name: "github_pm_delete_milestone",
  description: "Delete a GitHub milestone. This detaches it from any issues; it does not delete the issues.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      number: { type: "number", description: "Milestone number to delete (required)." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["number"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const number = typeof p.number === "number" ? p.number : NaN;
    if (!Number.isFinite(number) || number <= 0) return textResult("A positive integer 'number' is required to delete a milestone.", undefined, true);
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      await resolved.client.deleteMilestone(resolved.owner, resolved.repo, number);
      return textResult(`Deleted milestone #${number}.`, { number });
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Milestone delete failed unexpectedly.", undefined, true);
    }
  },
};

/*
FNXC:GithubPmDiscussions 2026-07-25-14:20:
KB-006 agent-write tool: post a new top-level discussion comment (no `replyToId`) or a nested
reply under `replyToId` (a top-level comment's GraphQL node id). Mirrors the FUSI-014/KB-002/
KB-003 write-tool shape exactly: `requireToolConfirmation` runs BEFORE `resolveRepoAndClient`/
any client call, and the authoritative created comment (including its echoed `replyTo.id`) is
reported via `textResult` -- the parent-linkage round-trip proof, never fabricated client-side.
This tool runs server-side in the agent execution context and deliberately does NOT call any
browser-only pub/sub. `repo` is accepted for parity with every other tool here but is not
actually required by the underlying `addDiscussionComment` mutation (GitHub addresses it
entirely by `discussionId`/`replyToId` node ids) -- `resolveRepoAndClient` is still used so auth
resolution is identical to every other tool in this file.
*/
export const githubPmAddDiscussionCommentTool: PluginToolDefinition = {
  name: "github_pm_add_discussion_comment",
  description: "Post a new top-level comment on a GitHub discussion, or a nested reply when replyToId (a top-level comment's node id) is supplied.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/repo. Omit to use the currently selected repo." },
      discussionId: { type: "string", description: "The discussion's GraphQL node id (required)." },
      body: { type: "string", description: "Comment body markdown (required)." },
      replyToId: { type: "string", description: "The parent top-level comment's GraphQL node id. Omit to post a new top-level comment." },
      confirmed: { type: "boolean", description: "Set true to confirm this write. Required when the plugin's 'Confirm writes' setting is on." },
    },
    required: ["discussionId", "body"],
  },
  execute: async (params, ctx: PluginContext) => {
    const p = params as Record<string, unknown>;
    const discussionId = typeof p.discussionId === "string" ? p.discussionId.trim() : "";
    const body = typeof p.body === "string" ? p.body.trim() : "";
    if (!discussionId || !body) return textResult("A non-empty 'discussionId' and 'body' are required to add a discussion comment.", undefined, true);
    const replyToId = typeof p.replyToId === "string" && p.replyToId.trim() ? p.replyToId.trim() : undefined;
    const confirmationBlocked = requireToolConfirmation(ctx, p.confirmed);
    if (confirmationBlocked) return confirmationBlocked;
    const resolved = await resolveRepoAndClient(ctx, p.repo);
    if (isToolResult(resolved)) return resolved;
    try {
      const comment: GitHubDiscussionCreatedComment = await resolved.client.addDiscussionComment({ discussionId, body, replyToId });
      return textResult(
        comment.replyToId ? `Posted a reply under comment ${comment.replyToId}.` : "Posted a new top-level discussion comment.",
        { comment },
      );
    } catch (error) {
      if (isGitHubApiError(error)) return textResult(error.message, { code: error.code }, true);
      return textResult("Discussion comment failed unexpectedly.", undefined, true);
    }
  },
};

export const githubPmTools: PluginToolDefinition[] = [
  githubPmStatusTool,
  githubPmCreateIssueTool,
  githubPmEditIssueTool,
  githubPmCommentIssueTool,
  githubPmSetIssueStateTool,
  githubPmCreateLabelTool,
  githubPmUpdateLabelTool,
  githubPmDeleteLabelTool,
  githubPmCreateMilestoneTool,
  githubPmUpdateMilestoneTool,
  githubPmSetMilestoneStateTool,
  githubPmDeleteMilestoneTool,
  githubPmAddDiscussionCommentTool,
];
