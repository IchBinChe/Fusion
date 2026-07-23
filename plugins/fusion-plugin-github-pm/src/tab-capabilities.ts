import type { RepoCapabilities, RepoCapabilityTabId, TabCapability, TabCapabilityReason } from "./repo-capabilities.js";

/*
FNXC:GithubPmCapabilities 2026-07-24-09:00:
FUSI-009 Step 4: pure, client-safe mapper from the server's `RepoCapabilities` payload
(GET /repo/capabilities) to an ordered per-tab gating array the tab shell renders directly.
This file imports ONLY types from repo-capabilities.ts (erased at compile time -- no runtime
import of that Node-only module, which pulls in auth.ts/github-client.ts/node:crypto), so it
stays safe to bundle into the browser. This mapper -- together with the server resolver and
the useRepoCapabilities hook -- is the SINGLE place tab enable/disable is decided; no tab
component may independently re-check scope/feature state.
*/

/** Canonical tab order + labels, mirroring GITHUB_PM_TABS in GitHubPmTabs.tsx. Kept as a
 * small local literal (not imported from the .tsx file) so this module has zero React/JSX
 * dependency and stays trivially unit-testable in a plain Node/vitest environment. */
const TAB_ORDER: ReadonlyArray<{ id: RepoCapabilityTabId; label: string }> = [
  { id: "issues", label: "Issues" },
  { id: "labels", label: "Labels" },
  { id: "milestones", label: "Milestones" },
  { id: "discussions", label: "Discussions" },
  { id: "projects", label: "Projects" },
  { id: "triage", label: "Triage" },
];

export interface TabGating {
  id: RepoCapabilityTabId;
  label: string;
  /** True when this tab must be greyed out / non-activatable. */
  disabled: boolean;
  reason?: TabCapabilityReason;
  /** Human-readable explanation. Never raw/redacted GitHub API error text. */
  message?: string;
  /** Ordered, actionable remediation steps. */
  fix?: string[];
}

/**
 * Look up a single tab's raw capability entry from a (possibly absent) capabilities payload.
 * Returns `undefined` when capabilities haven't loaded yet -- callers should treat that as
 * "not yet known", not "disabled".
 */
export function capabilityForTab(
  capabilities: RepoCapabilities | undefined,
  tabId: RepoCapabilityTabId,
): TabCapability | undefined {
  return capabilities?.tabs?.[tabId];
}

/**
 * Map a `RepoCapabilities` payload (or `undefined` while it hasn't loaded) into the ordered
 * per-tab gating array the tab shell consumes. Absent capabilities (still loading) map every
 * tab to `disabled: false` so the shell doesn't flash a false-blocked state before the first
 * fetch resolves -- gating only takes effect once the server has actually spoken.
 */
export function mapRepoCapabilitiesToTabs(capabilities: RepoCapabilities | undefined): TabGating[] {
  return TAB_ORDER.map(({ id, label }) => {
    const capability = capabilityForTab(capabilities, id);
    if (!capability) {
      return { id, label, disabled: false };
    }
    // `available: true` entries (including reason:"unknown" informational notes) stay enabled.
    return {
      id,
      label,
      disabled: capability.available === false,
      reason: capability.reason,
      message: capability.message,
      fix: capability.fix,
    };
  });
}

export { TAB_ORDER as GITHUB_PM_CAPABILITY_TAB_ORDER };
