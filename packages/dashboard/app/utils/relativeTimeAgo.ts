/**
 * FNXC:TaskChatTimestamps 2026-06-17-15:40:
 * FN-6597 requires compact relative timestamps for task-chat agent groups and user messages without live polling.
 * Invalid or missing timestamps must return an empty string so UI callers can omit the label instead of rendering NaN or Invalid Date.
 */
export function formatRelativeTimeAgo(iso: string, now: number = Date.now()): string {
  if (!iso) return "";

  const timestampMs = Date.parse(iso);
  if (!Number.isFinite(timestampMs)) return "";

  const diffMs = Math.max(0, now - timestampMs);
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(timestampMs).toLocaleDateString();
}
