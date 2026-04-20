export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3_600_000;

export const HEARTBEAT_INTERVAL_PRESETS = [
  { value: 1000, label: "1s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
  { value: 30000, label: "30s" },
  { value: 60000, label: "1m" },
  { value: 300000, label: "5m" },
  { value: 900000, label: "15m" },
  { value: 1800000, label: "30m" },
  { value: 3600000, label: "1h" },
  { value: 10800000, label: "3h" },
  { value: 21600000, label: "6h" },
  { value: 43200000, label: "12h" },
  { value: 86400000, label: "24h" },
] as const;

export function formatHeartbeatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function resolveHeartbeatIntervalMs(intervalMs: unknown): number {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs)) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  return Math.max(1000, Math.round(intervalMs));
}

export function getHeartbeatIntervalOptions(currentIntervalMs: number): Array<{ value: number; label: string }> {
  if (HEARTBEAT_INTERVAL_PRESETS.some((preset) => preset.value === currentIntervalMs)) {
    return [...HEARTBEAT_INTERVAL_PRESETS];
  }

  const customOption = {
    value: currentIntervalMs,
    label: `${formatHeartbeatInterval(currentIntervalMs)} (custom)`,
  };

  return [...HEARTBEAT_INTERVAL_PRESETS, customOption]
    .sort((a, b) => a.value - b.value);
}
