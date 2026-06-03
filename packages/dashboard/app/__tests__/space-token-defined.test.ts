import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = resolve(__dirname, "..");
const componentsDir = resolve(appDir, "components");
const stylesPath = resolve(appDir, "styles.css");
const themeDataPath = resolve(appDir, "public/theme-data.css");

function listComponentCssFiles(): string[] {
  return readdirSync(componentsDir)
    .filter((name) => name.endsWith(".css"))
    .sort();
}

describe("dashboard spacing token hygiene", () => {
  it("does not reference undefined --space-2xs in any component stylesheet", () => {
    const violations: string[] = [];

    for (const fileName of listComponentCssFiles()) {
      const filePath = join(componentsDir, fileName);
      const source = readFileSync(filePath, "utf8");
      const lines = source.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].includes("var(--space-2xs)")) {
          violations.push(`${fileName}:${index + 1}:${lines[index].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("documents that --space-2xs remains intentionally undefined in shared token sources", () => {
    const tokenSources = [
      { name: "styles.css", source: readFileSync(stylesPath, "utf8") },
      { name: "theme-data.css", source: readFileSync(themeDataPath, "utf8") },
    ];

    for (const { name, source } of tokenSources) {
      expect(source).not.toContain("--space-2xs:");
    }
  });
});
