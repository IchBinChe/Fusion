// @vitest-environment node

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../../../..");

function readDoc(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("Command Center pricing documentation contract", () => {
  it("documents user-facing estimated cost semantics in the dashboard guide", () => {
    const dashboardGuide = readDoc("docs/dashboard-guide.md");

    expect(dashboardGuide).toContain("estimated cost");
    expect(dashboardGuide).toContain("derived at read time");
    expect(dashboardGuide).toContain("it is not persisted");
    expect(dashboardGuide).toContain("prices as of");
    expect(dashboardGuide).toContain("low-confidence");
    expect(dashboardGuide).toContain("cost unavailable");
  });

  it("documents the model-pricing maintenance contract in architecture docs", () => {
    const architecture = readDoc("docs/architecture.md");

    expect(architecture).toContain("Model pricing & cost estimation");
    expect(architecture).toContain("packages/core/src/model-pricing.ts");
    expect(architecture).toContain("MODEL_PRICING");
    expect(architecture).toContain("pricingAsOf");
    expect(architecture).toContain("PRICING_STALE_AFTER_MS");
    expect(architecture).toContain("openai-codex:*");
  });
});
