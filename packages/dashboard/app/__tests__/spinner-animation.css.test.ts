import React from "react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { render, screen } from "@testing-library/react";
import { Loader2 } from "lucide-react";

function extractBlock(content: string, pattern: RegExp): string {
  const match = content.match(pattern);
  expect(match?.index).toBeDefined();

  const start = match!.index! + match![0].length;
  let index = start;
  let depth = 1;

  while (index < content.length && depth > 0) {
    if (content[index] === "{") depth += 1;
    if (content[index] === "}") depth -= 1;
    index += 1;
  }

  expect(depth).toBe(0);
  return content.slice(match!.index!, index);
}

function assertSharedSpinnerCssContract(css: string): void {
  const topLevelSpinBlock = extractBlock(css, /@keyframes\s+spin\s*\{/);
  const animateSpinBlock = css.match(/\.animate-spin\s*\{[\s\S]*?\}/)?.[0] ?? "";
  const spinBlock = css.match(/\.spin\s*\{[\s\S]*?\}/)?.[0] ?? "";
  const svgSpinnerBlock = css.match(/svg\.animate-spin,\s*svg\.spin\s*\{[\s\S]*?\}/)?.[0] ?? "";

  expect(topLevelSpinBlock).toContain("transform: rotate(360deg);");
  expect(css.indexOf("@keyframes spin")).toBeLessThan(css.indexOf(":root {\n  --bg:"));

  expect(animateSpinBlock).toContain("animation: spin 1s linear infinite;");
  expect(spinBlock).toContain("animation: spin 1s linear infinite;");
  expect(animateSpinBlock).toContain("transform-origin: center;");
  expect(spinBlock).toContain("transform-origin: center;");

  expect(svgSpinnerBlock).toContain("transform-box: view-box;");
  expect(svgSpinnerBlock).not.toContain("transform-box: fill-box;");
}

describe("global spinner animation utility", () => {
  const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

  it("keeps the shared spin utility centered and rotating infinitely", () => {
    assertSharedSpinnerCssContract(css);
  });

  it("keeps the svg spinner contract aligned with lucide stroke-only loaders", () => {
    render(React.createElement(Loader2, { className: "animate-spin", "data-testid": "spinner" }));

    const spinner = screen.getByTestId("spinner");
    expect(spinner.tagName.toLowerCase()).toBe("svg");
    expect(spinner).toHaveAttribute("class", expect.stringContaining("animate-spin"));
    expect(spinner).toHaveAttribute("fill", "none");
    expect(spinner).toHaveAttribute("viewBox", "0 0 24 24");
  });

  it("fails the contract if svg spinners regress back to fill-box anchoring", () => {
    const regressedCss = css.replace("transform-box: view-box;", "transform-box: fill-box;");

    expect(() => assertSharedSpinnerCssContract(regressedCss)).toThrow();
  });
});
