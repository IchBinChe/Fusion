import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";

function goalsBlocks(css: string): string {
  const blocks = css.match(/[^\n]*\.goals-[^{\n]*\{[^}]*\}/gms) ?? [];
  return blocks.join("\n");
}

describe("GoalsView CSS token guardrails", () => {
  it("uses tokens and contains mobile/focus rules", async () => {
    const css = await loadAllAppCss();
    const goalsCss = goalsBlocks(css);
    const goalsViewBlock = css.match(/\.goals-view\s*\{[^}]*\}/ms)?.[0] ?? "";

    expect(goalsCss).not.toMatch(/#[0-9a-fA-F]{3,8}/g);
    expect(goalsCss).not.toMatch(/rgba?\(/g);
    expect(goalsCss).not.toMatch(/\b[1-9]\d*px\b/g);
    expect(goalsViewBlock).toContain("height: 100%");
    expect(goalsViewBlock).toContain("overflow-y: auto");
    expect(css).toMatch(/\.goals-[^\n{]*:focus-visible/g);
    expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.goals-/);
  });
});
