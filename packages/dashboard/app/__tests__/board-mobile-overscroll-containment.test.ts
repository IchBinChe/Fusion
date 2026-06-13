import { describe, expect, it } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../test/cssFixture";

/** Extract all content inside @media (max-width: 768px) blocks. */
function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount++;
      if (content[endIdx] === "}") braceCount--;
      endIdx++;
    }
    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }
  return blocks.join("\n");
}

function extractRuleBlock(content: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*\\}`))?.[0] ?? "";
}

describe("board-mobile-overscroll-containment (FN-6378)", () => {
  const cssContent = loadAllAppCss();
  const baseCss = loadAllAppCssBaseOnly();
  const mobileCss = extractMobileMediaBlocks(cssContent);

  it("mobile .board contains horizontal overscroll while preserving intentional scroll and proximity snap", () => {
    const boardBlock = extractRuleBlock(mobileCss, ".board");

    expect(boardBlock).toContain("overflow-x: auto");
    expect(boardBlock).toContain("overscroll-behavior-x: contain");
    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).not.toContain("scroll-snap-type: x mandatory");
  });

  it("base .board contains horizontal overscroll for shared and tablet board scrollers", () => {
    const boardBlock = extractRuleBlock(baseCss, ".board");

    expect(boardBlock).toContain("overflow-x: auto");
    expect(boardBlock).toContain("overscroll-behavior-x: contain");
    expect(boardBlock).toContain("scroll-snap-type: x proximity");
    expect(boardBlock).not.toContain("scroll-snap-type: x mandatory");
  });

  it("workflow columns and multi-lane column strips contain horizontal overscroll", () => {
    const workflowColumnsBlock = extractRuleBlock(baseCss, ".board.board-workflow-columns");
    const laneColumnsBlock = extractRuleBlock(baseCss, ".lane-columns");

    for (const block of [workflowColumnsBlock, laneColumnsBlock]) {
      expect(block).toContain("overflow-x: auto");
      expect(block).toContain("overscroll-behavior-x: contain");
      expect(block).toContain("scroll-snap-type: x proximity");
      expect(block).not.toContain("scroll-snap-type: x mandatory");
    }
  });
});
