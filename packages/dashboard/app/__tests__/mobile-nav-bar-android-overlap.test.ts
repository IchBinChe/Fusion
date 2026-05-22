import { describe, expect, it } from "vitest";
import { loadAllAppCss } from "../test/cssFixture";

/**
 * Android overlap contract:
 * - MobileNavBar keeps a 44px SSR fallback token.
 * - MobileNavBar.tsx republishs --mobile-nav-height at runtime from live DOM height.
 * - Footer/content offsets consume the token, so Android's taller label line-box no longer overlaps.
 */
function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

describe("mobile nav / executor footer overlap contract", () => {
  const css = loadAllAppCss();

  it("keeps 44px :root fallback token", () => {
    expect(css).toMatch(/:root\s*\{[\s\S]*--mobile-nav-height:\s*44px;/);
  });

  it("uses min-height var token for the nav bar", () => {
    const navBlock = extractRuleBlock(css, ".mobile-nav-bar");
    expect(navBlock).toContain("min-height: var(--mobile-nav-height)");
    expect(navBlock).not.toContain("height: 44px");
  });

  it("positions executor footer above nav using the token on mobile", () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*\.executor-status-bar\s*\{[\s\S]*bottom:\s*calc\(var\(--mobile-nav-height\)\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\s*\+\s*var\(--standalone-bottom-gap\)\)/);
  });

  it("uses nav-height token in mobile project-content padding rules", () => {
    expect(css).toMatch(/\.project-content--with-mobile-nav:not\(\.project-content--with-footer\)\s*\{[\s\S]*padding-bottom:\s*calc\(var\(--mobile-nav-height\)/);
    expect(css).toMatch(/\.project-content--with-footer\.project-content--with-mobile-nav\s*\{[\s\S]*padding-bottom:\s*calc\([\s\S]*var\(--mobile-nav-height\)/);
  });
});
