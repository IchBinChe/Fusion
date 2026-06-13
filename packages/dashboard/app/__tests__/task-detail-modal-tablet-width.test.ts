import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("task detail modal tablet width (FN-5599)", () => {
  const detailModalCss = readFileSync(
    resolve(__dirname, "../components/TaskDetailModal.css"),
    "utf-8",
  );

  it("keeps desktop base width rule unchanged", () => {
    const baseRuleMatch = detailModalCss.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(baseRuleMatch).toBeTruthy();
    expect(baseRuleMatch![0]).toContain("width: min(95vw, 800px);");
  });

  it("defines a tablet breakpoint override for task detail modal width", () => {
    const tabletBlockMatch = detailModalCss.match(
      /@media\s*\(min-width:\s*769px\)\s*and\s*\(max-width:\s*1024px\)\s*\{([\s\S]*?)\n\}/,
    );
    expect(tabletBlockMatch).toBeTruthy();

    const tabletBlock = tabletBlockMatch![1];
    const modalRuleMatch = tabletBlock.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(modalRuleMatch).toBeTruthy();
    expect(modalRuleMatch![0]).toContain("width: min(96vw, 1024px);");
    expect(modalRuleMatch![0]).toContain("max-width: 96vw;");
  });

  it("keeps mobile full-screen sheet width behavior", () => {
    const mobileBlockMatch = detailModalCss.match(
      /@media\s*\(max-width:\s*768px\)\s*\{\s*\.detail-move-btn__arrow[\s\S]*?\.modal\.task-detail-modal\s*\{[^}]*\}[\s\S]*?\n\}/,
    );
    expect(mobileBlockMatch).toBeTruthy();

    const mobileBlock = mobileBlockMatch![0];
    const modalRuleMatch = mobileBlock.match(/\.modal\.task-detail-modal\s*\{[^}]*\}/s);
    expect(modalRuleMatch).toBeTruthy();
    expect(modalRuleMatch![0]).toContain("width: 100vw;");
  });
});
