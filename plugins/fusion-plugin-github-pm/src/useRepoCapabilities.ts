import { useEffect, useState } from "react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import type { RepoCapabilities, RepoCapabilityTabId } from "./repo-capabilities.js";

/*
FNXC:GithubPmCapabilities 2026-07-24-09:10:
FUSI-009 Step 4: client hook wrapping GET /repo/capabilities (repo-capabilities-routes.ts),
mirroring AuthDiagnosticsPanel's fetch/loading/error/projectQuery conventions exactly so the
GitHub PM plugin has one consistent fetch shape across its diagnostics/capability surfaces.
Re-fetches whenever the selected repo (or project context) changes. A fetch failure degrades
to an ALL-TABS-AVAILABLE synthetic payload rather than hard-blocking the whole tab shell --
"can't verify capability" must never become "everything is disabled" (mission: a capability
probe failure is a soft, non-blocking degradation, same as the server resolver's own
network-error handling).
*/

export type UseRepoCapabilitiesState = "loading" | "ready" | "error";

export interface UseRepoCapabilitiesResult {
  state: UseRepoCapabilitiesState;
  capabilities?: RepoCapabilities;
  error?: string;
}

interface RepoCapabilitiesResponse extends Partial<RepoCapabilities> {
  ok?: boolean;
  error?: string;
}

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

const ALWAYS_AVAILABLE_TAB_IDS: readonly RepoCapabilityTabId[] = ["issues", "labels", "milestones", "discussions", "projects", "triage"];

function degradedAllAvailable(repo: string | null): RepoCapabilities {
  const tabs = Object.fromEntries(ALWAYS_AVAILABLE_TAB_IDS.map((id) => [id, { available: true }])) as RepoCapabilities["tabs"];
  return { repo: repo ?? "", authenticated: true, tabs };
}

function buildQuery(repo: string | null, context?: PluginDashboardViewContext): string {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  if (context?.projectId) params.set("projectId", context.projectId);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function fetchRepoCapabilities(repo: string | null, context?: PluginDashboardViewContext): Promise<RepoCapabilities> {
  const response = await fetch(`${PLUGIN_BASE}/repo/capabilities${buildQuery(repo, context)}`);
  const json = (await response.json().catch(() => ({}))) as RepoCapabilitiesResponse;
  if (!response.ok || json.ok === false || !json.tabs) {
    throw new Error(json.error ?? `Repo capabilities request failed with status ${response.status}.`);
  }
  return { repo: json.repo ?? repo ?? "", authenticated: json.authenticated === true, tabs: json.tabs };
}

/**
 * Fetch the per-repo tab capability model for the currently selected repo. Re-fetches on
 * every `repo`/`context.projectId` change. On failure, `capabilities` is populated with an
 * all-tabs-available synthetic payload (never `undefined`) so a transient probe failure never
 * strands the shell without a usable capabilities object -- only `state`/`error` signal the
 * degraded condition.
 */
export function useRepoCapabilities(repo: string | null, context?: PluginDashboardViewContext): UseRepoCapabilitiesResult {
  const [state, setState] = useState<UseRepoCapabilitiesState>("loading");
  const [capabilities, setCapabilities] = useState<RepoCapabilities>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setError(undefined);

    if (!repo) {
      // No repo selected yet: nothing to gate against -- present every tab as available so
      // the shell doesn't flash a false-blocked state before a repo is chosen.
      setCapabilities(degradedAllAvailable(null));
      setState("ready");
      return () => {
        cancelled = true;
      };
    }

    fetchRepoCapabilities(repo, context)
      .then((result) => {
        if (cancelled) return;
        setCapabilities(result);
        setState("ready");
      })
      .catch((fetchError) => {
        if (cancelled) return;
        setCapabilities(degradedAllAvailable(repo));
        setError(fetchError instanceof Error ? fetchError.message : "Repo capabilities request failed");
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [repo, context?.projectId]);

  return { state, capabilities, error };
}

export default useRepoCapabilities;
