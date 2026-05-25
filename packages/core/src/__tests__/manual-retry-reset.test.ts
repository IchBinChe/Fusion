import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildManualRetryResetPatch, MANUAL_RETRY_RESET_COUNTER_KEYS } from "../manual-retry-reset.js";

const RETRY_SUMMARY_COUNTER_REGEX = /toCount\(task\.(\w+)\)/g;

describe("buildManualRetryResetPatch", () => {
  it("resets all manual retry counters to zero", () => {
    const patch = buildManualRetryResetPatch();

    for (const key of MANUAL_RETRY_RESET_COUNTER_KEYS) {
      expect(patch[key]).toBe(0);
    }
  });

  it("includes all retry-summary counters in the reset key list", () => {
    const retrySummarySource = readFileSync(new URL("../retry-summary.ts", import.meta.url), "utf-8");
    const retrySummaryKeys = new Set<string>();
    let match: RegExpExecArray | null = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    while (match) {
      retrySummaryKeys.add(match[1]);
      match = RETRY_SUMMARY_COUNTER_REGEX.exec(retrySummarySource);
    }

    for (const key of retrySummaryKeys) {
      expect(MANUAL_RETRY_RESET_COUNTER_KEYS).toContain(key);
    }
  });

  it("sets mergeRetries only when requested", () => {
    expect(buildManualRetryResetPatch()).not.toHaveProperty("mergeRetries");
    expect(buildManualRetryResetPatch({ resetMergeRetries: true })).toMatchObject({ mergeRetries: 0 });
  });

  it("clears nextRecoveryAt", () => {
    expect(buildManualRetryResetPatch()).toMatchObject({ nextRecoveryAt: null });
  });
});
