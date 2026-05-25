import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media[^{]*\(max-width: 768px\)[^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;
    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount += 1;
      if (content[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }
    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

describe("quick-chat mobile keyboard layout css", () => {
  const css = loadAllAppCss();
  const mobileCss = extractMobileMediaBlocks(css);

  it("drops safe-area bottom inset from composer padding while keyboard-open class is active", () => {
    const keyboardOpenRule = /\.quick-chat-panel\.quick-chat-panel--keyboard-open\s+\.quick-chat-panel-input\s*\{[^}]*padding-bottom:\s*calc\(var\(--space-sm\)\s*\+\s*var\(--space-xs\)\)\s*;/m;
    expect(keyboardOpenRule.test(mobileCss)).toBe(true);
  });
});
