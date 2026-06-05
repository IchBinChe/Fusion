/**
 * CLI-agent validator integration (CLI Agent Executor, U9).
 *
 * Bridges a one-shot CLI agent session into the existing validator verdict
 * contract (`ValidationResult` in mission-execution-loop.ts:
 * `status: "pass" | "fail" | "blocked" | "error"`).
 *
 * The cardinal rule: a malformed / unparseable / nonzero-exit one-shot maps to
 * `error`, NEVER a silent `pass`. The verdict must be indistinguishable
 * downstream from a model-executed validation run.
 */

import type {
  OneShotResult,
  RunOneShotOptions,
  runOneShotSession as RunOneShotFn,
} from "./cli-agent/one-shot-session.js";

/** The validator verdict contract shared with model-executed runs. */
export interface ValidatorVerdict {
  status: "pass" | "fail" | "blocked" | "error";
  /** Per-assertion results (empty when the adapter reports a bare verdict). */
  assertions: Array<{ assertionId: string; passed: boolean; message?: string }>;
  summary: string;
  blockedReason?: string;
}

/**
 * A structured verdict an adapter may emit in its one-shot JSON result. We look
 * for these fields on the parsed payload (in priority order) before falling
 * back to prose inference on the `text` field.
 */
interface ParsedVerdictShape {
  verdict?: unknown;
  status?: unknown;
  result?: unknown;
  passed?: unknown;
  blocked?: unknown;
  is_error?: unknown;
  summary?: unknown;
  reason?: unknown;
  assertions?: unknown;
}

/** Normalize a free-form verdict token to the contract's status set. */
export function normalizeVerdictToken(token: string): ValidatorVerdict["status"] | null {
  const t = token.trim().toLowerCase();
  if (["pass", "passed", "approve", "approved", "ok", "success"].includes(t)) return "pass";
  if (["fail", "failed", "revise", "reject", "rejected", "failure"].includes(t)) return "fail";
  if (["blocked", "block", "unavailable"].includes(t)) return "blocked";
  if (["error", "errored"].includes(t)) return "error";
  return null;
}

/**
 * Map a parsed one-shot result payload into a validator verdict.
 *
 * Precedence:
 *  1. explicit `verdict`/`status` string token (normalized)
 *  2. boolean `passed` (true→pass, false→fail) and `blocked === true`
 *  3. `is_error === true` → error (claude-shaped)
 *  4. prose inference from the result text
 *  5. nothing decodable → error (NEVER pass)
 */
export function mapParsedToVerdict(
  parsed: Record<string, unknown>,
  text: string,
): ValidatorVerdict {
  const p = parsed as ParsedVerdictShape;
  const summary =
    (typeof p.summary === "string" && p.summary) ||
    (typeof p.reason === "string" && p.reason) ||
    text ||
    "";
  const assertions = parseAssertions(p.assertions);

  // 3 (early): an adapter error flag is authoritative.
  if (p.is_error === true) {
    return { status: "error", assertions, summary: summary || "Adapter reported an error" };
  }

  // 2: explicit blocked flag.
  if (p.blocked === true) {
    return {
      status: "blocked",
      assertions,
      summary: summary || "Validation blocked",
      blockedReason: typeof p.reason === "string" ? p.reason : summary || "blocked",
    };
  }

  // 1: explicit verdict / status token.
  for (const candidate of [p.verdict, p.status, p.result]) {
    if (typeof candidate === "string") {
      const status = normalizeVerdictToken(candidate);
      if (status) {
        return status === "blocked"
          ? { status, assertions, summary: summary || "Validation blocked", blockedReason: summary }
          : { status, assertions, summary };
      }
    }
  }

  // 2 (boolean): passed flag.
  if (typeof p.passed === "boolean") {
    return { status: p.passed ? "pass" : "fail", assertions, summary };
  }

  // 4: prose inference.
  const inferred = inferVerdictFromProse(text);
  if (inferred) return { status: inferred, assertions, summary: summary || text };

  // 5: undecidable → error, never a silent pass.
  return {
    status: "error",
    assertions,
    summary: summary || "Validator produced no decodable verdict",
  };
}

function parseAssertions(raw: unknown): ValidatorVerdict["assertions"] {
  if (!Array.isArray(raw)) return [];
  const out: ValidatorVerdict["assertions"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    const assertionId =
      typeof a.assertionId === "string"
        ? a.assertionId
        : typeof a.id === "string"
          ? a.id
          : null;
    if (!assertionId) continue;
    out.push({
      assertionId,
      passed: a.passed === true,
      message: typeof a.message === "string" ? a.message : undefined,
    });
  }
  return out;
}

/** Conservative prose inference. Only confident phrasings map to a verdict. */
export function inferVerdictFromProse(text: string): ValidatorVerdict["status"] | null {
  const t = text.toLowerCase();
  if (/\bblocked\b/.test(t)) return "blocked";
  if (/\b(revise|revision requested|does not (pass|meet)|fail(s|ed)?\b)/.test(t)) return "fail";
  if (/\b(all (assertions|checks) pass|validation pass(ed)?|approve(d)?)\b/.test(t)) return "pass";
  return null;
}

/**
 * Convert any one-shot result (success or failure) into a validator verdict.
 * Failures (nonzero exit, unparseable, spawn-failed) → `error` with the bounded
 * stderr folded into the summary.
 */
export function oneShotResultToVerdict(result: OneShotResult): ValidatorVerdict {
  if (!result.ok) {
    return {
      status: "error",
      assertions: [],
      summary: `${result.message}${result.stderr ? `\n--- output tail ---\n${result.stderr}` : ""}`,
    };
  }
  return mapParsedToVerdict(result.parsed, result.text);
}

/**
 * Run a CLI-agent one-shot validation and map it to the verdict contract.
 *
 * This is the integration seam mission-execution-loop's `runValidation` branches
 * to when the resolved validator executor is a CLI agent (adapter-backed) rather
 * than a model. The `run` parameter is injected so this is unit-testable without
 * a live PTY (tests pass a stubbed runner; production passes
 * `runOneShotSession`).
 */
export async function runCliAgentValidation(
  opts: Omit<RunOneShotOptions, "purpose">,
  run: typeof RunOneShotFn,
): Promise<ValidatorVerdict> {
  const result = await run({ ...opts, purpose: "validator" });
  return oneShotResultToVerdict(result);
}
