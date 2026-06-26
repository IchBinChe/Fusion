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
/*
FNXC:WorkflowPostMerge 2026-06-26-12:00:
U7b cutover — `graphNativePostMerge` is now DEFAULT-ON. The graph is the single owner
of post-merge execution: a successful merge lets traversal continue to post-merge graph
nodes (optional-group nodes wired off a merge-region success, plus the plain post-merge
nodes that follow a `seam:"merge"` prompt node — e.g. compound-engineering's `document`
step). When this flag is on the legacy merger post-merge path (`runPostMergeWorkflowSteps`
/ `hasEnabledPostMergeWorkflowSteps` in engine/merger.ts) is INERT so post-merge work runs
exactly once via the graph and never double-runs. The flag is retained (not removed) as an
explicit opt-out back to the legacy merger path until U7c deletes the legacy code + table.
*/
const DEFAULT_ON_EXPERIMENTAL_FEATURES = new Set<string>(["graphNativePostMerge"]);
const RETIRED_EXPERIMENTAL_FEATURES = new Set<string>([
  "workflowInterpreterDualObserve",
]);

/*
FNXC:WorkflowPostMerge 2026-06-26-09:00:
Post-merge workflow steps run GRAPH-NATIVE behind this default-OFF experimental flag
(U7 spike). When OFF (the default — the key is absent from DEFAULT_*_SETTINGS so
`isExperimentalFeatureEnabled` returns false), the merge-region stays collapsed exactly
as before: the graph routes merge-attempt success straight to `end` and the merger still
owns post-merge steps from the legacy table — zero behavior change, byte-identical
builtin:coding traversal. When ON, the graph executor lets traversal continue past a
SUCCESSFUL merge to any post-merge optional-group node reachable from the merge region,
running it via the same optional-group execution+recording path (phase:"post-merge",
non-blocking failures). This unit is additive + reversible: a later unit removes the
legacy merger post-merge path. Mirrors the WORKFLOW_INTERPRETER_DUAL_OBSERVE_FLAG read
plumbing (named constant + `isExperimentalFeatureEnabled`).
*/
export const GRAPH_NATIVE_POST_MERGE_FLAG = "graphNativePostMerge" as const;

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
