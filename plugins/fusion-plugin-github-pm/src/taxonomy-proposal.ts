import type { GitHubClient, GitHubDiscussionListItem, GitHubIssueListItem, GitHubLabel } from "./github-client.js";

/*
FNXC:GithubPmTaxonomy 2026-07-24-00:00:
FUSI-005 Phase 1 mission: given a repo's REAL issue/discussion/label history, produce a
repo-specific label/field/category taxonomy PROPOSAL -- never silently applied. Four
invariants this module (and its callers in taxonomy-store.ts / taxonomy-routes.ts) must
uphold everywhere:
  1. DATA-DRIVEN -- the proposal content is derived from `aggregateRepoSignal`'s output
     (this repo's observed labels/issue titles/label frequencies/discussion categories),
     never a fixed default scheme baked into code. There is deliberately no constant
     "starter taxonomy" anywhere in this file.
  2. REVIEWABLE -- generation only ever returns a draft payload; it never writes to the
     settings blob itself (that is taxonomy-store.ts's job, invoked from a route).
  3. REVERSIBLE -- drafts are versioned (taxonomy-store.ts) so a bad proposal can be
     rejected or superseded by a fresh `propose` call without losing prior versions.
  4. NO SILENT APPLY -- only an explicit accept route (taxonomy-routes.ts) may ever set
     `RepoConfig.approvedTaxonomyVersion`; this module has no path that mutates it.
Generation flows exclusively through the engine-injected `ctx.createAiSession` factory
(passed in here as `createAiSession`), which is what makes the AI pass honor project
testMode/mock -- this module makes no direct model/provider calls of its own.
*/

export interface TaxonomyLabel {
  name: string;
  description?: string;
  color?: string;
}

export type TaxonomyFieldType = "single-select" | "text" | "number" | "date";

export interface TaxonomyField {
  name: string;
  type: TaxonomyFieldType;
  options?: string[];
  description?: string;
}

export interface TaxonomyCategory {
  name: string;
  description?: string;
  exampleIssueNumbers?: number[];
}

export type TaxonomyProposalStatus = "draft" | "accepted" | "rejected";

export interface TaxonomyProposalSourceStats {
  issueCount: number;
  discussionCount: number;
  existingLabelCount: number;
}

/** The AI-generated / user-editable content of a proposal, minus server-managed fields. */
export interface TaxonomyProposalContent {
  labels: TaxonomyLabel[];
  fields: TaxonomyField[];
  categories: TaxonomyCategory[];
  rationale?: string;
}

export interface TaxonomyProposal extends TaxonomyProposalContent {
  version: number;
  generatedAt: string;
  status: TaxonomyProposalStatus;
  sourceStats: TaxonomyProposalSourceStats;
}

// ── Repo signal aggregation (the data-driven core) ─────────────────────────

export interface RepoSignalInput {
  issues: GitHubIssueListItem[];
  discussions: GitHubDiscussionListItem[];
  labels: GitHubLabel[];
}

export interface LabelFrequency {
  name: string;
  count: number;
}

export interface DiscussionCategorySummary {
  name: string;
  count: number;
  sampleTitles: string[];
}

/**
 * Compact, data-driven summary of a repo's actual issue/discussion/label history.
 * This is the ONLY input the AI prompt is grounded in -- nothing here is a constant;
 * every field is derived from the `issues`/`discussions`/`labels` arguments.
 */
export interface RepoSignal {
  existingLabels: LabelFrequency[];
  sampleIssueTitles: string[];
  discussionCategories: DiscussionCategorySummary[];
  sourceStats: TaxonomyProposalSourceStats;
}

const MAX_SAMPLE_ISSUE_TITLES = 40;
const MAX_SAMPLE_TITLES_PER_CATEGORY = 5;

/**
 * Build a bounded, data-driven summary of the repo's actual history: existing label
 * names with observed usage frequency (co-occurrence across issues), a bounded sample
 * of issue titles, and discussion categories with their titles. Never throws on empty
 * input -- an unhistoried repo yields empty arrays and zeroed counts, not an error.
 */
export function aggregateRepoSignal({ issues, discussions, labels }: RepoSignalInput): RepoSignal {
  const frequency = new Map<string, number>();
  for (const label of labels) frequency.set(label.name, frequency.get(label.name) ?? 0);
  for (const issue of issues) {
    for (const labelName of issue.labels) {
      frequency.set(labelName, (frequency.get(labelName) ?? 0) + 1);
    }
  }
  const existingLabels: LabelFrequency[] = [...frequency.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const sampleIssueTitles = issues.slice(0, MAX_SAMPLE_ISSUE_TITLES).map((issue) => issue.title);

  const categoryMap = new Map<string, { count: number; sampleTitles: string[] }>();
  for (const discussion of discussions) {
    const categoryName = discussion.category?.trim() || "Uncategorized";
    const entry = categoryMap.get(categoryName) ?? { count: 0, sampleTitles: [] };
    entry.count += 1;
    if (entry.sampleTitles.length < MAX_SAMPLE_TITLES_PER_CATEGORY) entry.sampleTitles.push(discussion.title);
    categoryMap.set(categoryName, entry);
  }
  const discussionCategories: DiscussionCategorySummary[] = [...categoryMap.entries()]
    .map(([name, { count, sampleTitles }]) => ({ name, count, sampleTitles }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    existingLabels,
    sampleIssueTitles,
    discussionCategories,
    sourceStats: {
      issueCount: issues.length,
      discussionCount: discussions.length,
      existingLabelCount: labels.length,
    },
  };
}

// ── Prompt construction ─────────────────────────────────────────────────────

export function buildProposalSystemPrompt(): string {
  return [
    "You are a repository triage architect for a project-management tool.",
    "You design a bespoke, repo-specific taxonomy (labels, custom fields, categories) that fits ONE repository's actual issue/discussion history.",
    "Ground every element of your proposal ONLY in the repo signal the user provides -- never invent labels, fields, or categories that are not evidenced by the given data.",
    "Respond with a single fenced JSON code block (```json ... ```) containing exactly one object with keys: labels, fields, categories, rationale.",
    "labels: array of { name, description?, color? } (color is an optional 6-digit hex without '#').",
    "fields: array of { name, type: one of \"single-select\"|\"text\"|\"number\"|\"date\", options? (string[], only for single-select), description? }.",
    "categories: array of { name, description?, exampleIssueNumbers? (number[]) }.",
    "rationale: a short string explaining how the proposal reflects the observed data.",
    "Do not include any text outside the fenced JSON block.",
  ].join("\n");
}

export function buildProposalUserPrompt(signal: RepoSignal): string {
  const lines: string[] = [
    "Repository signal (derived from this repo's real history -- base your taxonomy on this data only):",
    "",
    `Existing labels (name: usage count), ${signal.existingLabels.length} total:`,
    signal.existingLabels.length
      ? signal.existingLabels.map((label) => `- ${label.name}: ${label.count}`).join("\n")
      : "(none observed)",
    "",
    `Sample issue titles (${signal.sampleIssueTitles.length} of ${signal.sourceStats.issueCount}):`,
    signal.sampleIssueTitles.length ? signal.sampleIssueTitles.map((title) => `- ${title}`).join("\n") : "(no issues observed)",
    "",
    `Discussion categories (${signal.discussionCategories.length}), from ${signal.sourceStats.discussionCount} discussions:`,
    signal.discussionCategories.length
      ? signal.discussionCategories
          .map((category) => `- ${category.name} (${category.count}): ${category.sampleTitles.join("; ") || "(no sample titles)"}`)
          .join("\n")
      : "(no discussions observed)",
    "",
    "Propose a taxonomy grounded in this data. If the data is sparse, propose a small, minimal taxonomy rather than a generic default one.",
  ];
  return lines.join("\n");
}

// ── Response parsing (tolerant, throw-free) ─────────────────────────────────

export interface ParseProposalFailure {
  ok: false;
  reason: string;
}

export interface ParseProposalSuccess {
  ok: true;
  content: TaxonomyProposalContent;
}

export type ParseProposalResult = ParseProposalSuccess | ParseProposalFailure;

function extractJsonCandidate(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidateText = fenced ? fenced[1] : text;
  const start = candidateText.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < candidateText.length; i += 1) {
    const char = candidateText[i];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidateText.slice(start, i + 1);
    }
  }
  return null;
}

function coerceStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceLabels(value: unknown): TaxonomyLabel[] {
  if (!Array.isArray(value)) return [];
  const out: TaxonomyLabel[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = coerceStringField(record.name);
    if (!name) continue;
    out.push({ name, description: coerceStringField(record.description), color: coerceStringField(record.color) });
  }
  return out;
}

const FIELD_TYPES: readonly TaxonomyFieldType[] = ["single-select", "text", "number", "date"];

function coerceFields(value: unknown): TaxonomyField[] {
  if (!Array.isArray(value)) return [];
  const out: TaxonomyField[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = coerceStringField(record.name);
    const type = typeof record.type === "string" && (FIELD_TYPES as readonly string[]).includes(record.type) ? (record.type as TaxonomyFieldType) : undefined;
    if (!name || !type) continue;
    const options = Array.isArray(record.options)
      ? record.options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
      : undefined;
    out.push({ name, type, options, description: coerceStringField(record.description) });
  }
  return out;
}

function coerceCategories(value: unknown): TaxonomyCategory[] {
  if (!Array.isArray(value)) return [];
  const out: TaxonomyCategory[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = coerceStringField(record.name);
    if (!name) continue;
    const exampleIssueNumbers = Array.isArray(record.exampleIssueNumbers)
      ? record.exampleIssueNumbers.filter((num): num is number => typeof num === "number" && Number.isFinite(num))
      : undefined;
    out.push({ name, description: coerceStringField(record.description), exampleIssueNumbers });
  }
  return out;
}

/**
 * Tolerant extraction of a taxonomy proposal from raw assistant text: strips fences,
 * locates the first balanced JSON object, and coerces each field into a safe payload.
 * NEVER throws -- unparseable/garbage output returns a structured failure the caller
 * (a route) maps to a clear error response instead of an uncaught exception.
 */
export function parseProposalResponse(assistantText: string): ParseProposalResult {
  if (typeof assistantText !== "string" || !assistantText.trim()) {
    return { ok: false, reason: "Assistant response was empty." };
  }
  const candidate = extractJsonCandidate(assistantText);
  if (!candidate) {
    return { ok: false, reason: "No JSON object found in the assistant response." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "Assistant response contained malformed JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Assistant response JSON was not an object." };
  }
  const record = parsed as Record<string, unknown>;
  const content: TaxonomyProposalContent = {
    labels: coerceLabels(record.labels),
    fields: coerceFields(record.fields),
    categories: coerceCategories(record.categories),
    rationale: coerceStringField(record.rationale),
  };
  return { ok: true, content };
}

// ── End-to-end generation ────────────────────────────────────────────────────

export interface CreateAiSessionOptionsLike {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
}

export interface AiSessionResultLike {
  session: {
    prompt(text: string): Promise<void>;
    state: { messages: Array<{ role: string; content?: unknown }> };
  };
}

export type CreateAiSessionFactoryLike = (options: CreateAiSessionOptionsLike) => Promise<AiSessionResultLike>;

export interface GenerateTaxonomyProposalOptions {
  client: Pick<GitHubClient, "listIssues" | "listDiscussions" | "listLabels">;
  owner: string;
  repo: string;
  /** Engine-injected AI session factory (undefined when the engine is not loaded). */
  createAiSession: CreateAiSessionFactoryLike | undefined;
  cwd: string;
  /** Bounds the number of issues fetched for aggregation. Default 200 (matches the task's guidance). */
  maxIssues?: number;
}

export type GenerateTaxonomyProposalResult =
  | { ok: true; content: TaxonomyProposalContent; sourceStats: TaxonomyProposalSourceStats }
  | { ok: false; reason: "ai-unavailable"; message: string }
  | { ok: false; reason: "parse-error"; message: string };

function extractLatestAssistantText(session: AiSessionResultLike["session"]): string {
  const assistantMessages = session.state.messages.filter((message) => message.role === "assistant");
  const latest = assistantMessages[assistantMessages.length - 1];
  const content = latest?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") ? (part as { text: string }).text : "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Fetch issue/discussion/label history for one repo, aggregate it into a data-driven
 * signal, and run a single AI pass (via the engine-injected `createAiSession`) to
 * propose a taxonomy. Returns the parsed proposal content + source stats -- it never
 * writes anything; persistence is the caller's (a route's) responsibility via
 * taxonomy-store.ts. If `createAiSession` is undefined (engine not loaded) or the
 * assistant response cannot be parsed, returns a typed failure instead of throwing.
 */
export async function generateTaxonomyProposal(options: GenerateTaxonomyProposalOptions): Promise<GenerateTaxonomyProposalResult> {
  const { client, owner, repo, createAiSession, cwd, maxIssues = 200 } = options;

  if (!createAiSession) {
    return { ok: false, reason: "ai-unavailable", message: "AI session factory unavailable: engine not registered." };
  }

  const [issues, discussions, labels] = await Promise.all([
    client.listIssues(owner, repo, { state: "all", maxItems: maxIssues }),
    client.listDiscussions(owner, repo),
    client.listLabels(owner, repo),
  ]);

  const signal = aggregateRepoSignal({ issues, discussions, labels });
  const systemPrompt = buildProposalSystemPrompt();
  const userPrompt = buildProposalUserPrompt(signal);

  const sessionResult = await createAiSession({ cwd, systemPrompt, tools: "readonly" });
  await sessionResult.session.prompt(userPrompt);
  const assistantText = extractLatestAssistantText(sessionResult.session);

  const parsed = parseProposalResponse(assistantText);
  if (!parsed.ok) {
    return { ok: false, reason: "parse-error", message: parsed.reason };
  }

  return { ok: true, content: parsed.content, sourceStats: signal.sourceStats };
}
