import type { TaskComment } from "@fusion/core";

const DEFAULT_USER_COMMENT_LIMIT = 20;

function commentTimestamp(comment: TaskComment): string {
  return comment.updatedAt || comment.createdAt;
}

function timestampMs(comment: TaskComment): number {
  const parsed = Date.parse(commentTimestamp(comment));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteCommentText(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return ["> (empty comment)"];
  return normalized.split(/\r?\n/).map((line) => `> ${line}`);
}

/**
 * FNXC:AgentSteering 2026-06-22-00:05:
 * Task-detail chat and user comments must reach every agent lane that builds prompts: executor, merger, reviewer, and planner. This helper is the canonical formatter for next-prompt delivery outside the executor's live steering injection path, so merger and reviewer prompts do not drift or duplicate comment logic.
 */
export function selectUserCommentsForAgentContext(
  task: { comments?: TaskComment[] },
  opts: { limit?: number } = {},
): TaskComment[] {
  const limit = opts.limit ?? DEFAULT_USER_COMMENT_LIMIT;
  if (!task.comments || task.comments.length === 0 || limit <= 0) return [];

  const byId = new Map<string, TaskComment>();
  for (const comment of task.comments) {
    if (comment.author !== "user") continue;
    byId.set(comment.id, comment);
  }

  return [...byId.values()]
    .sort((a, b) => timestampMs(a) - timestampMs(b))
    .slice(-limit);
}

export function buildUserCommentsPromptSection(
  comments: TaskComment[],
  opts: { heading?: string; intro?: string } = {},
): string {
  if (comments.length === 0) return "";

  const heading = opts.heading ?? "## User Comments";
  const intro = opts.intro ?? "The following user comments were posted on this task. Consider and address this user feedback when completing your agent pass.";
  const lines = [heading, "", intro, ""];

  for (const comment of comments) {
    const timestamp = commentTimestamp(comment);
    lines.push(`**${comment.author}** — ${timestamp}`);
    lines.push(...quoteCommentText(comment.text));
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
