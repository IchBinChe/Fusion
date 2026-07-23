import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Github, Loader2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import "./GitHubPmView.css";

type StatusState = "loading" | "configured" | "unconfigured" | "error";

interface StatusResponse {
  ok?: boolean;
  error?: string;
  configured?: boolean;
  autonomy?: string;
  defaultRepo?: string | null;
}

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

function projectQuery(context?: PluginDashboardViewContext): string {
  const params = new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function getStatus(context?: PluginDashboardViewContext): Promise<StatusResponse> {
  const response = await fetch(`${PLUGIN_BASE}/status${projectQuery(context)}`);
  const json = (await response.json().catch(() => ({}))) as StatusResponse;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `GitHub PM status failed with status ${response.status}.`);
  }
  return json;
}

function StatusBadge({ state, message }: { state: StatusState; message?: string }) {
  const className = state === "configured" ? "auth" : state === "unconfigured" ? "warning" : state === "error" ? "error" : "info";
  const Icon = state === "configured" ? CheckCircle2 : state === "loading" ? Loader2 : AlertCircle;
  return (
    <span className={`github-pm-view__status github-pm-view__status--${className}`} aria-live="polite">
      <Icon aria-hidden="true" />
      {message ?? (state === "configured" ? "Configured" : state === "loading" ? "Checking status" : state === "unconfigured" ? "Not configured" : "Status unavailable")}
    </span>
  );
}

/*
FNXC:GitHubPm 2026-07-24-00:00:
Placeholder view for FUSI-001. Renders a status badge from the plugin-owned
/status route (settings-presence only, no live GitHub call) and explains that
the repo picker + issue management surfaces land in later Foundation-milestone
tasks (FUSI-002/003/004). Never renders the raw personalAccessToken value.
*/
export function GitHubPmView({ context }: { context?: PluginDashboardViewContext }) {
  const [status, setStatus] = useState<StatusState>("loading");
  const [statusMessage, setStatusMessage] = useState<string>();
  const [autonomy, setAutonomy] = useState<string>();
  const [defaultRepo, setDefaultRepo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getStatus(context)
      .then((result) => {
        if (cancelled) return;
        setAutonomy(result.autonomy);
        setDefaultRepo(result.defaultRepo ?? null);
        if (result.configured) {
          setStatus("configured");
          setStatusMessage("GitHub PM configured");
        } else {
          setStatus("unconfigured");
          setStatusMessage("Not configured");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : "GitHub PM status check failed");
      });
    return () => {
      cancelled = true;
    };
  }, [context?.projectId]);

  return (
    <section className="github-pm-view" aria-labelledby="github-pm-heading">
      <header className="github-pm-view__header">
        <div>
          <p className="github-pm-view__eyebrow">Bundled plugin</p>
          <h1 id="github-pm-heading" className="github-pm-view__title">
            <Github aria-hidden="true" /> GitHub PM
          </h1>
          <p className="github-pm-view__subtitle">GitHub-native project management for any repository, without leaving Fusion.</p>
        </div>
        <StatusBadge state={status} message={statusMessage} />
      </header>

      <div className="card github-pm-view__placeholder" role="status">
        <p>
          This is a scaffold. The repo picker, layered GitHub auth (gh CLI / GITHUB_TOKEN / PAT override), and full issue,
          discussion, Projects v2, label, and milestone management are coming online in the Foundation milestone.
        </p>
        {defaultRepo ? <p className="github-pm-view__meta">Default repository: {defaultRepo}</p> : null}
        {autonomy ? <p className="github-pm-view__meta">Default triage autonomy: {autonomy}</p> : null}
        {status === "unconfigured" ? (
          <p className="github-pm-view__meta">Add a default repository or personal access token in Plugin Manager settings to get started.</p>
        ) : null}
      </div>
    </section>
  );
}

export default GitHubPmView;
