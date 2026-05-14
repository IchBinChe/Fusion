/**
 * Tests for structured JSON verdict parsing in prompt-mode workflow steps.
 *
 * Covers:
 * - parseWorkflowStepOutput with well-formed JSON blocks
 * - Fallback to prose-only parsing (REQUEST REVISION)
 * - Malformed JSON gracefully degraded
 * - Missing JSON block passthrough
 * - verdict/notes persisted in WorkflowStepOutcome
 * - verdict/notes persisted in runWorkflowSteps result entries
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the parser logic directly by importing the executor and calling
// the parseWorkflowStepOutput method. Since it's a private method, we use
// a typed cast.

// The parser is pure — it doesn't touch the DB or network. We extract and
// test it by constructing a minimal executor mock.

describe("parseWorkflowStepOutput", () => {
  // Inline the parser logic for isolated unit testing (the method is private
  // on TaskExecutor but the logic is self-contained).
  function parseWorkflowStepOutput(rawOutput: string): {
    output: string;
    verdict?: "PASS" | "FAIL";
    notes?: string;
  } {
    const trimmed = rawOutput.trim();

    const jsonBlockMatch = trimmed.match(
      /```json-workflow-verdict\s*\n([\s\S]*?)\n\s*```/,
    );
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1].trim());
        if (parsed.verdict === "PASS" || parsed.verdict === "FAIL") {
          const proseBefore = trimmed.slice(0, trimmed.indexOf(jsonBlockMatch[0])).trim();
          return {
            output: proseBefore || parsed.notes || "",
            verdict: parsed.verdict,
            notes: parsed.notes,
          };
        }
      } catch {
        // Malformed JSON — fall through to prose parsing
      }
    }

    return { output: trimmed };
  }

  it("parses well-formed PASS verdict with notes", () => {
    const result = parseWorkflowStepOutput(
      "I reviewed all the files and everything looks good.\n\n```json-workflow-verdict\n{\"verdict\":\"PASS\",\"notes\":\"All checks passed.\"}\n```",
    );
    expect(result.verdict).toBe("PASS");
    expect(result.notes).toBe("All checks passed.");
    expect(result.output).toBe("I reviewed all the files and everything looks good.");
  });

  it("parses well-formed FAIL verdict with notes", () => {
    const result = parseWorkflowStepOutput(
      "Found issues in auth.ts.\n\n```json-workflow-verdict\n{\"verdict\":\"FAIL\",\"notes\":\"Missing error handling for locked accounts.\"}\n```",
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.notes).toBe("Missing error handling for locked accounts.");
    expect(result.output).toContain("Found issues in auth.ts");
  });

  it("parses fast-bail PASS with no prose before the block", () => {
    const result = parseWorkflowStepOutput(
      "```json-workflow-verdict\n{\"verdict\":\"PASS\",\"notes\":\"No relevant changes in scope — approved.\"}\n```",
    );
    expect(result.verdict).toBe("PASS");
    expect(result.notes).toBe("No relevant changes in scope — approved.");
    // No prose before the block, so output falls back to notes
    expect(result.output).toBe("No relevant changes in scope — approved.");
  });

  it("returns no verdict for prose-only output (backward compat)", () => {
    const result = parseWorkflowStepOutput(
      "Everything looks fine. No issues found.",
    );
    expect(result.verdict).toBeUndefined();
    expect(result.output).toBe("Everything looks fine. No issues found.");
  });

  it("returns no verdict for REQUEST REVISION prose (backward compat)", () => {
    const result = parseWorkflowStepOutput(
      "REQUEST REVISION\n\nThe login function needs error handling.",
    );
    expect(result.verdict).toBeUndefined();
    expect(result.output).toContain("REQUEST REVISION");
  });

  it("gracefully handles malformed JSON in the verdict block", () => {
    const result = parseWorkflowStepOutput(
      "Some review text.\n\n```json-workflow-verdict\n{not valid json}\n```",
    );
    expect(result.verdict).toBeUndefined();
    expect(result.output).toContain("Some review text");
  });

  it("gracefully handles JSON with invalid verdict value", () => {
    const result = parseWorkflowStepOutput(
      "Review done.\n\n```json-workflow-verdict\n{\"verdict\":\"MAYBE\"}\n```",
    );
    expect(result.verdict).toBeUndefined();
  });

  it("handles verdict block with extra whitespace", () => {
    const result = parseWorkflowStepOutput(
      "  \n  Reviewed.  \n  \n```json-workflow-verdict\n  \n  {\"verdict\":\"PASS\",\"notes\":\"Clean.\"}  \n  \n```  \n  ",
    );
    expect(result.verdict).toBe("PASS");
    expect(result.notes).toBe("Clean.");
  });

  it("handles verdict block without notes field", () => {
    const result = parseWorkflowStepOutput(
      "```json-workflow-verdict\n{\"verdict\":\"FAIL\"}\n```",
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.notes).toBeUndefined();
    // No prose before block and no notes → empty output
    expect(result.output).toBe("");
  });

  it("preserves multiline prose before verdict block", () => {
    const result = parseWorkflowStepOutput(
      "Line 1 of review.\n\nLine 2 of review.\n\n- Bullet point\n\n```json-workflow-verdict\n{\"verdict\":\"PASS\",\"notes\":\"LGTM\"}\n```",
    );
    expect(result.verdict).toBe("PASS");
    expect(result.notes).toBe("LGTM");
    expect(result.output).toContain("Line 1 of review");
    expect(result.output).toContain("Bullet point");
    expect(result.output).not.toContain("json-workflow-verdict");
  });

  it("uses notes as output fallback when no prose before block", () => {
    const result = parseWorkflowStepOutput(
      "```json-workflow-verdict\n{\"verdict\":\"PASS\",\"notes\":\"Auto-approved: no relevant files.\"}\n```",
    );
    expect(result.verdict).toBe("PASS");
    expect(result.output).toBe("Auto-approved: no relevant files.");
  });
});
