import type { Settings } from "./types.js";

const LEGACY_EXPERIMENTAL_FEATURE_ALIASES: Record<string, string> = {
  devServer: "devServerView",
};

/*
FNXC:WorkflowSettings 2026-06-22-18:00:
workflowGraphExecutor and workflowColumns graduated from Experimental. Runtime graph execution and workflow-defined columns are always on; stale persisted values are ignored by runtime helpers instead of acting as kill switches.

FNXC:WorkflowSettings 2026-06-23-21:55:
workflowInterpreterDualObserve is no longer user-controllable in Settings. Treat stale persisted true values as inert so upgraded users do not keep running hidden diagnostic shadow observation with no visible off switch.
*/
const DEFAULT_ON_EXPERIMENTAL_FEATURES = new Set<string>();
const RETIRED_EXPERIMENTAL_FEATURES = new Set<string>([
  "workflowInterpreterDualObserve",
]);

export function isExperimentalFeatureEnabled(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
  key: string,
): boolean {
  const features = settings?.experimentalFeatures;
  const canonicalKey = LEGACY_EXPERIMENTAL_FEATURE_ALIASES[key] ?? key;
  if (RETIRED_EXPERIMENTAL_FEATURES.has(canonicalKey)) return false;
  if (features?.[canonicalKey] === false) return false;
  if (features?.[canonicalKey] === true) return true;

  for (const [legacyKey, aliasCanonical] of Object.entries(LEGACY_EXPERIMENTAL_FEATURE_ALIASES)) {
    if (aliasCanonical === canonicalKey && features?.[legacyKey] === true) {
      return true;
    }
  }

  if (DEFAULT_ON_EXPERIMENTAL_FEATURES.has(canonicalKey)) return true;

  return false;
}
