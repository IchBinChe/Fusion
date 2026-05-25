import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("index.html theme-data boot contract", () => {
  const indexHtml = readFileSync(resolve(PACKAGE_ROOT, "app/index.html"), "utf8");
  const scripts = [...indexHtml.matchAll(/<script>[\s\S]*?<\/script>/g)].map((m) => m[0]);
  const script = scripts.find((candidate) => candidate.includes("setAttribute('data-theme'")) ?? "";

  it("includes a static theme-data stylesheet link", () => {
    expect(indexHtml).toMatch(/<link\s+[^>]*(id=["']theme-data["'][^>]*href=["']\/theme-data\.css["']|href=["']\/theme-data\.css["'][^>]*id=["']theme-data["'])[^>]*>/i);
  });

  it("does not dynamically create or append the theme-data link", () => {
    expect(script).not.toMatch(/document\.createElement\(("|')link\1\)/);
    expect(script).not.toContain("appendChild(");
  });

  it("still sets theme attributes and font size", () => {
    expect(script).toContain("setAttribute('data-theme'");
    expect(script).toContain("setAttribute('data-color-theme'");
    expect(script).toContain("style.fontSize");
  });

  it("keeps themeDataUrl resolution branches", () => {
    expect(script).toContain("http://");
    expect(script).toContain("https://");
    expect(script).toContain("file://");
    expect(script).toContain("themeDataUrl = '/theme-data.css'");
  });
});
