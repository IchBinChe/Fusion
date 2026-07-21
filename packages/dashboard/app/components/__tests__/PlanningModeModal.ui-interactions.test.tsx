import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PlanningModeModal sequential layout", () => {
  it("uses one persistent responsive plan-and-question workspace", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.css"), "utf8");
    expect(css).not.toMatch(/planning-compact-pane-switcher|planning-answered-history/);
    expect(css).toContain("planning-workspace");
    expect(css).toContain('grid-template-areas: "question plan"');
    expect(css).toContain("planning-summary-actions");
  });

  it("keeps plan actions in a non-scrolling sibling footer with equal mobile columns", () => {
    const css = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.css"), "utf8");
    expect(css).toMatch(/\.planning-actions\s*\{[^}]*flex-shrink\s*:\s*0\s*;/);
    expect(css).toMatch(/\.planning-plan-actions\s*\{[^}]*justify-content\s*:\s*flex-end\s*;/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions\s*\{[^}]*display\s*:\s*grid\s*;[^}]*grid-template-columns\s*:\s*repeat\(2, minmax\(0, 1fr\)\)\s*;[^}]*safe-area-inset-bottom/);
    expect(css).toMatch(/@media \(max-width: 1024px\)[\s\S]*?\.planning-plan-actions \.btn\s*\{[^}]*width\s*:\s*100%\s*;/);
  });
});
