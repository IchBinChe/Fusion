import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, XCircle } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import "./AuthDiagnosticsPanel.css";

/*
FNXC:GithubPmAuth 2026-07-24-00:30:
Diagnostics panel for FUSI-002. Fetches GET /auth/diagnostics (auth.ts's
getGitHubAuthDiagnostics, exposed via routes.ts) and renders the resolved
source plus per-capability support. When the `project` scope is missing this
renders a clear, actionable warning with step-by-step remediation instructions
instead of failing silently -- the acceptance criterion this feature exists to
satisfy. There is deliberately no separate GitHub OAuth/login button anywhere
in this panel: the only remediation paths are gh CLI login, the GITHUB_TOKEN
env var, or pasting a PAT into plugin settings.
*/

type CapabilityState = "supported" | "missing" | "unknown";
type AuthSource = "pat" | "env" | "gh-cli" | "none";

interface DiagnosticsResponse {
  ok?: boolean;
  error?: string;
  authenticated?: boolean;
  source?: AuthSource;
  introspectable?: boolean;
  probeStatus?: string;
  capabilities?: { issues: CapabilityState; discussions: CapabilityState; projects: CapabilityState };
  missingProjectScope?: boolean;
  warning?: { message: string; instructions: string[] };
}

type PanelState = "loading" | "ready" | "error";

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

const SOURCE_LABEL: Record<AuthSource, string> = {
  pat: "Personal access token (plugin setting override)",
  env: "GITHUB_TOKEN environment variable",
  "gh-cli": "GitHub CLI (gh)",
  none: "Not authenticated",
};

function projectQuery(context?: PluginDashboardViewContext): string {
  const params = new URLSearchParams(context?.projectId ? { projectId: context.projectId } : {});
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function getDiagnostics(context?: PluginDashboardViewContext): Promise<DiagnosticsResponse> {
  const response = await fetch(`${PLUGIN_BASE}/auth/diagnostics${projectQuery(context)}`);
  const json = (await response.json().catch(() => ({}))) as DiagnosticsResponse;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `Auth diagnostics failed with status ${response.status}.`);
  }
  return json;
}

function CapabilityBadge({ label, state }: { label: string; state: CapabilityState }) {
  const Icon = state === "supported" ? CheckCircle2 : state === "missing" ? XCircle : HelpCircle;
  return (
    <span
      className={`auth-diagnostics__capability auth-diagnostics__capability--${state}`}
      data-testid={`capability-${label.toLowerCase()}`}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <span className="auth-diagnostics__capability-state">
        {state === "supported" ? "Supported" : state === "missing" ? "Missing" : "Unknown"}
      </span>
    </span>
  );
}

export function AuthDiagnosticsPanel({ context }: { context?: PluginDashboardViewContext }) {
  const [state, setState] = useState<PanelState>("loading");
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse>();
  const [errorMessage, setErrorMessage] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    getDiagnostics(context)
      .then((result) => {
        if (cancelled) return;
        setDiagnostics(result);
        setState("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "Auth diagnostics failed");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [context?.projectId]);

  if (state === "loading") {
    return (
      <section className="auth-diagnostics card" aria-labelledby="auth-diagnostics-heading" data-testid="auth-diagnostics-panel">
        <h2 id="auth-diagnostics-heading" className="auth-diagnostics__title">Authentication diagnostics</h2>
        <p className="auth-diagnostics__loading" role="status">
          <Loader2 aria-hidden="true" className="auth-diagnostics__spinner" /> Checking GitHub authentication…
        </p>
      </section>
    );
  }

  if (state === "error" || !diagnostics) {
    return (
      <section className="auth-diagnostics card" aria-labelledby="auth-diagnostics-heading" data-testid="auth-diagnostics-panel">
        <h2 id="auth-diagnostics-heading" className="auth-diagnostics__title">Authentication diagnostics</h2>
        <p className="auth-diagnostics__warning" role="alert" data-testid="auth-diagnostics-degraded">
          <AlertTriangle aria-hidden="true" /> Could not load authentication diagnostics ({errorMessage ?? "unknown error"}). This does not affect the rest of the plugin; try again shortly.
        </p>
      </section>
    );
  }

  if (!diagnostics.authenticated) {
    return (
      <section className="auth-diagnostics card" aria-labelledby="auth-diagnostics-heading" data-testid="auth-diagnostics-panel">
        <h2 id="auth-diagnostics-heading" className="auth-diagnostics__title">Authentication diagnostics</h2>
        <p className="auth-diagnostics__warning" role="alert" data-testid="auth-diagnostics-unauthenticated">
          <AlertTriangle aria-hidden="true" /> {diagnostics.warning?.message ?? "GitHub PM is not authenticated."}
        </p>
        {diagnostics.warning?.instructions?.length ? (
          <ul className="auth-diagnostics__instructions">
            {diagnostics.warning.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  }

  const capabilities = diagnostics.capabilities ?? { issues: "unknown", discussions: "unknown", projects: "unknown" };
  const source = diagnostics.source ?? "none";

  return (
    <section className="auth-diagnostics card" aria-labelledby="auth-diagnostics-heading" data-testid="auth-diagnostics-panel">
      <h2 id="auth-diagnostics-heading" className="auth-diagnostics__title">Authentication diagnostics</h2>
      <p className="auth-diagnostics__source" data-testid="auth-diagnostics-source">
        <CheckCircle2 aria-hidden="true" className="auth-diagnostics__source-icon" />
        Authenticated via {SOURCE_LABEL[source]}
      </p>

      <div className="auth-diagnostics__capabilities">
        <CapabilityBadge label="Issues" state={capabilities.issues} />
        <CapabilityBadge label="Discussions" state={capabilities.discussions} />
        <CapabilityBadge label="Projects" state={capabilities.projects} />
      </div>

      {!diagnostics.introspectable ? (
        <p className="auth-diagnostics__note" data-testid="auth-diagnostics-non-introspectable">
          <HelpCircle aria-hidden="true" /> This token's classic scopes cannot be read (fine-grained personal access token or GitHub App token). Capability support above is unknown, not confirmed missing.
        </p>
      ) : null}

      {diagnostics.missingProjectScope && diagnostics.warning ? (
        <div className="auth-diagnostics__warning-box" role="alert" data-testid="auth-diagnostics-project-warning">
          <p className="auth-diagnostics__warning">
            <AlertTriangle aria-hidden="true" /> {diagnostics.warning.message}
          </p>
          <ol className="auth-diagnostics__instructions">
            {diagnostics.warning.instructions.map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

export default AuthDiagnosticsPanel;
