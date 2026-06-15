/**
 * Route A enable resolution (experimental, DEFAULT ON).
 *
 * The `pi-claude-cli` provider drives Claude through the `claude-code-cli-acp`
 * ACP bridge instead of `claude -p` when BOTH hold at dispatch time:
 *   1. `FUSION_CLAUDE_ACP=1` (this module sets it from the experimental flag), and
 *   2. a bridge path is resolvable (the acp-runtime plugin publishes
 *      `FUSION_CLAUDE_ACP_BRIDGE` on load — KTD10; absent → fail-closed to `-p`).
 *
 * The user-facing switch is `experimentalFeatures.claudeCliAcp`: ON unless the
 * user explicitly sets it to `false`. An explicit `FUSION_CLAUDE_ACP` env value
 * always wins (operator / test override) — see {@link applyClaudeAcpEnable}.
 */

/** True unless `experimentalFeatures.claudeCliAcp === false` (default ON). */
export function claudeAcpExperimentalEnabled(
  globalSettings: Record<string, unknown> | undefined,
): boolean {
  const exp = ((globalSettings ?? {}).experimentalFeatures ?? {}) as Record<string, unknown>;
  return exp.claudeCliAcp !== false;
}

/**
 * Translate the experimental flag into the `FUSION_CLAUDE_ACP` dispatch the
 * provider reads. No-op when the env var is already set (explicit override wins),
 * so operators/tests keep full control. Returns the resolved enabled state.
 */
export function applyClaudeAcpEnable(
  globalSettings: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof env.FUSION_CLAUDE_ACP === "string") return env.FUSION_CLAUDE_ACP === "1";
  const enabled = claudeAcpExperimentalEnabled(globalSettings);
  if (enabled) env.FUSION_CLAUDE_ACP = "1";
  return enabled;
}
