import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PWA configuration", () => {
  it("manifest defines required PWA fields and icon sizes", () => {
    const manifestPath = resolve(__dirname, "../public/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      short_name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ sizes?: string }>;
    };

    expect(manifest.name).toBe("Fusion");
    expect(manifest.short_name).toBe("Fusion");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes?.includes("192"))).toBe(true);
    expect(manifest.icons?.some((icon) => icon.sizes?.includes("512"))).toBe(true);
  });

  it("index.html includes required PWA meta tags", () => {
    const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8");

    expect(indexHtml).toContain('<link rel="manifest"');
    expect(indexHtml).toContain("apple-mobile-web-app-capable");
  });

  it("service worker contains lifecycle handlers and versioned cache name", () => {
    const swSource = readFileSync(resolve(__dirname, "../public/sw.js"), "utf8");

    expect(swSource).toContain('addEventListener("install"');
    expect(swSource).toContain('addEventListener("fetch"');
    expect(swSource).toContain('addEventListener("activate"');
    expect(swSource).toMatch(/fusion-cache-v\d+/);
  });
});
