import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import "./TaxonomyProposalPanel.css";

/*
FNXC:GithubPmTaxonomy 2026-07-24-00:30:
FUSI-005's ONLY taxonomy review surface. Mounted once beneath AuthDiagnosticsPanel in
GitHubPmView.tsx -- do not fork a second panel elsewhere. Reiterates the four
invariants at the UI boundary (see taxonomy-proposal.ts for the full rationale):
data-driven (labels/fields/categories rendered here always come from a real /propose
call over this repo's history, never a client-side default), reviewable (every draft
is shown with its own Accept/Reject/Edit controls -- nothing is applied on generation),
reversible (multiple versions can coexist; rejecting one does not delete history), and
no silent apply (Accept is the only control that can change "approvedTaxonomyVersion",
rendered here as the "Active" badge). "Propose taxonomy" is disabled with inline
guidance when no repo is selected, and Accept/Reject/Edit controls are omitted (not
rendered as disabled shells) once a draft is no longer a draft, so no empty button
shells linger after a state transition -- verified in the Surface Enumeration checklist
for both desktop and narrow/mobile widths (this component uses only flex-wrap layout,
no fixed-width breakpoints of its own, so it reflows naturally).
*/

interface TaxonomyLabel {
  name: string;
  description?: string;
  color?: string;
}

interface TaxonomyField {
  name: string;
  type: "single-select" | "text" | "number" | "date";
  options?: string[];
  description?: string;
}

interface TaxonomyCategory {
  name: string;
  description?: string;
  exampleIssueNumbers?: number[];
}

type ProposalStatus = "draft" | "accepted" | "rejected";

interface TaxonomyProposal {
  version: number;
  generatedAt: string;
  status: ProposalStatus;
  sourceStats: { issueCount: number; discussionCount: number; existingLabelCount: number };
  labels: TaxonomyLabel[];
  fields: TaxonomyField[];
  categories: TaxonomyCategory[];
  rationale?: string;
}

interface ProposalsResponse {
  ok?: boolean;
  error?: string;
  repo?: string | null;
  proposals?: TaxonomyProposal[];
  approvedTaxonomyVersion?: number | null;
}

type PanelState = "loading" | "ready" | "error";

const PLUGIN_BASE = "/api/plugins/fusion-plugin-github-pm";

function projectQuery(context: PluginDashboardViewContext | undefined, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...(context?.projectId ? { projectId: context.projectId } : {}), ...extra });
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const json = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `Request failed with status ${response.status}.`);
  }
  return json;
}

async function loadProposals(context: PluginDashboardViewContext | undefined, repo: string): Promise<ProposalsResponse> {
  return fetchJson<ProposalsResponse>(`${PLUGIN_BASE}/taxonomy/proposals${projectQuery(context, { repo })}`);
}

async function proposeTaxonomy(context: PluginDashboardViewContext | undefined, repo: string): Promise<void> {
  await fetchJson(`${PLUGIN_BASE}/taxonomy/propose${projectQuery(context)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo }),
  });
}

async function acceptProposal(context: PluginDashboardViewContext | undefined, repo: string, version: number): Promise<void> {
  await fetchJson(`${PLUGIN_BASE}/taxonomy/proposals/accept${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, version }),
  });
}

async function rejectProposal(context: PluginDashboardViewContext | undefined, repo: string, version: number): Promise<void> {
  await fetchJson(`${PLUGIN_BASE}/taxonomy/proposals/reject${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, version }),
  });
}

async function editProposal(
  context: PluginDashboardViewContext | undefined,
  repo: string,
  version: number,
  proposal: { labels: TaxonomyLabel[]; fields: TaxonomyField[]; categories: TaxonomyCategory[]; rationale?: string },
): Promise<void> {
  await fetchJson(`${PLUGIN_BASE}/taxonomy/proposals/edit${projectQuery(context)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, version, proposal }),
  });
}

function StatusBadge({ status, isActive }: { status: ProposalStatus; isActive: boolean }) {
  if (isActive) {
    return (
      <span className="taxonomy-proposal__badge taxonomy-proposal__badge--active" data-testid="taxonomy-badge-active">
        <CheckCircle2 aria-hidden="true" /> Active
      </span>
    );
  }
  const className = status === "draft" ? "draft" : status === "rejected" ? "rejected" : "accepted";
  const Icon = status === "draft" ? Sparkles : status === "rejected" ? XCircle : CheckCircle2;
  const label = status === "draft" ? "Draft" : status === "rejected" ? "Rejected" : "Accepted";
  return (
    <span className={`taxonomy-proposal__badge taxonomy-proposal__badge--${className}`} data-testid={`taxonomy-badge-${status}`}>
      <Icon aria-hidden="true" /> {label}
    </span>
  );
}

function ProposalCard({
  proposal,
  isActive,
  onAccept,
  onReject,
  onEdit,
  busy,
}: {
  proposal: TaxonomyProposal;
  isActive: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (content: { labels: TaxonomyLabel[]; fields: TaxonomyField[]; categories: TaxonomyCategory[]; rationale?: string }) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [rationaleDraft, setRationaleDraft] = useState(proposal.rationale ?? "");

  const startEdit = useCallback(() => {
    setRationaleDraft(proposal.rationale ?? "");
    setEditing(true);
  }, [proposal.rationale]);

  const saveEdit = useCallback(() => {
    onEdit({ labels: proposal.labels, fields: proposal.fields, categories: proposal.categories, rationale: rationaleDraft });
    setEditing(false);
  }, [onEdit, proposal.labels, proposal.fields, proposal.categories, rationaleDraft]);

  return (
    <div className="taxonomy-proposal__card" data-testid={`taxonomy-proposal-v${proposal.version}`}>
      <div className="taxonomy-proposal__card-header">
        <span className="taxonomy-proposal__version">Version {proposal.version}</span>
        <StatusBadge status={proposal.status} isActive={isActive} />
      </div>

      <p className="taxonomy-proposal__meta">
        {proposal.sourceStats.issueCount} issues · {proposal.sourceStats.discussionCount} discussions · {proposal.sourceStats.existingLabelCount} existing labels
      </p>

      {proposal.rationale && !editing ? <p className="taxonomy-proposal__rationale">{proposal.rationale}</p> : null}

      <div className="taxonomy-proposal__groups">
        <div className="taxonomy-proposal__group">
          <h4>Labels ({proposal.labels.length})</h4>
          <ul>
            {proposal.labels.map((label) => (
              <li key={label.name}>{label.name}{label.description ? ` — ${label.description}` : ""}</li>
            ))}
          </ul>
        </div>
        <div className="taxonomy-proposal__group">
          <h4>Fields ({proposal.fields.length})</h4>
          <ul>
            {proposal.fields.map((field) => (
              <li key={field.name}>{field.name} ({field.type})</li>
            ))}
          </ul>
        </div>
        <div className="taxonomy-proposal__group">
          <h4>Categories ({proposal.categories.length})</h4>
          <ul>
            {proposal.categories.map((category) => (
              <li key={category.name}>{category.name}</li>
            ))}
          </ul>
        </div>
      </div>

      {editing ? (
        <div className="taxonomy-proposal__edit">
          <label htmlFor={`taxonomy-rationale-${proposal.version}`}>Rationale</label>
          <textarea
            id={`taxonomy-rationale-${proposal.version}`}
            value={rationaleDraft}
            onChange={(event) => setRationaleDraft(event.target.value)}
          />
          <div className="taxonomy-proposal__actions">
            <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={busy}>Save edit</button>
            <button type="button" className="btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : proposal.status === "draft" ? (
        <div className="taxonomy-proposal__actions">
          <button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy} data-testid={`taxonomy-accept-v${proposal.version}`}>
            Accept
          </button>
          <button type="button" className="btn" onClick={onReject} disabled={busy} data-testid={`taxonomy-reject-v${proposal.version}`}>
            Reject
          </button>
          <button type="button" className="btn" onClick={startEdit} disabled={busy} data-testid={`taxonomy-edit-v${proposal.version}`}>
            Edit
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TaxonomyProposalPanel({ context, repo }: { context?: PluginDashboardViewContext; repo: string | null }) {
  const [state, setState] = useState<PanelState>("loading");
  const [proposals, setProposals] = useState<TaxonomyProposal[]>([]);
  const [approvedVersion, setApprovedVersion] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [proposing, setProposing] = useState(false);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!repo) {
      setState("ready");
      setProposals([]);
      setApprovedVersion(null);
      return;
    }
    setState("loading");
    try {
      const result = await loadProposals(context, repo);
      setProposals(result.proposals ?? []);
      setApprovedVersion(result.approvedTaxonomyVersion ?? null);
      setState("ready");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load taxonomy proposals");
      setState("error");
    }
  }, [context, repo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handlePropose = useCallback(async () => {
    if (!repo) return;
    setProposing(true);
    setErrorMessage(undefined);
    try {
      await proposeTaxonomy(context, repo);
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to propose a taxonomy");
    } finally {
      setProposing(false);
    }
  }, [context, refresh, repo]);

  const handleAccept = useCallback(async (version: number) => {
    if (!repo) return;
    setBusyVersion(version);
    try {
      await acceptProposal(context, repo, version);
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to accept the proposal");
    } finally {
      setBusyVersion(null);
    }
  }, [context, refresh, repo]);

  const handleReject = useCallback(async (version: number) => {
    if (!repo) return;
    setBusyVersion(version);
    try {
      await rejectProposal(context, repo, version);
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to reject the proposal");
    } finally {
      setBusyVersion(null);
    }
  }, [context, refresh, repo]);

  const handleEdit = useCallback(async (
    version: number,
    content: { labels: TaxonomyLabel[]; fields: TaxonomyField[]; categories: TaxonomyCategory[]; rationale?: string },
  ) => {
    if (!repo) return;
    setBusyVersion(version);
    try {
      await editProposal(context, repo, version, content);
      await refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save the edit");
    } finally {
      setBusyVersion(null);
    }
  }, [context, refresh, repo]);

  return (
    <section className="taxonomy-proposal card" aria-labelledby="taxonomy-proposal-heading" data-testid="taxonomy-proposal-panel">
      <div className="taxonomy-proposal__header">
        <h2 id="taxonomy-proposal-heading" className="taxonomy-proposal__title">Taxonomy proposal</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handlePropose}
          disabled={!repo || proposing}
          data-testid="taxonomy-propose-button"
        >
          {proposing ? <Loader2 aria-hidden="true" className="taxonomy-proposal__spinner" /> : <Sparkles aria-hidden="true" />}
          {proposing ? "Proposing…" : "Propose taxonomy"}
        </button>
      </div>

      {!repo ? (
        <p className="taxonomy-proposal__guidance" role="status" data-testid="taxonomy-no-repo">
          Select a repository to analyze its issue and discussion history and propose a taxonomy.
        </p>
      ) : null}

      {errorMessage ? (
        <p className="taxonomy-proposal__warning" role="alert" data-testid="taxonomy-error">
          <AlertTriangle aria-hidden="true" /> {errorMessage}
        </p>
      ) : null}

      {state === "loading" ? (
        <p className="taxonomy-proposal__loading" role="status">
          <Loader2 aria-hidden="true" className="taxonomy-proposal__spinner" /> Loading taxonomy proposals…
        </p>
      ) : null}

      {state === "ready" && repo && proposals.length === 0 ? (
        <p className="taxonomy-proposal__guidance" data-testid="taxonomy-empty">
          No taxonomy proposals yet. Click "Propose taxonomy" to analyze this repo's history.
        </p>
      ) : null}

      {state === "ready" && proposals.length > 0 ? (
        <div className="taxonomy-proposal__list">
          {proposals
            .slice()
            .sort((a, b) => b.version - a.version)
            .map((proposal) => (
              <ProposalCard
                key={proposal.version}
                proposal={proposal}
                isActive={approvedVersion === proposal.version}
                busy={busyVersion === proposal.version}
                onAccept={() => handleAccept(proposal.version)}
                onReject={() => handleReject(proposal.version)}
                onEdit={(content) => handleEdit(proposal.version, content)}
              />
            ))}
        </div>
      ) : null}
    </section>
  );
}

export default TaxonomyProposalPanel;
