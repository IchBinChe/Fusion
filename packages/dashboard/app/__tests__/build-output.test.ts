import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const distDir = resolve(__dirname, "../../dist/client");
const assetsDir = resolve(distDir, "assets");
const distExists = existsSync(distDir) && existsSync(assetsDir);

describe("mobile build output chunking", () => {
  test.skipIf(!distExists)("creates vendor chunk files for core dependencies", () => {
    const files = readdirSync(assetsDir);
    const jsFiles = files.filter((file) => file.endsWith(".js"));

    expect(jsFiles.length).toBeGreaterThan(2);
    expect(jsFiles.some((file) => file.includes("vendor-react"))).toBe(true);
    expect(jsFiles.some((file) => file.includes("vendor-xterm"))).toBe(true);
  });

  test.skipIf(!distExists)("index.html references chunked asset scripts", () => {
    const indexHtml = readFileSync(resolve(distDir, "index.html"), "utf8");

    expect(indexHtml).toContain("<script");
    expect(indexHtml).toMatch(/assets\/.+-[A-Za-z0-9_-]+\.js/);
  });
});
