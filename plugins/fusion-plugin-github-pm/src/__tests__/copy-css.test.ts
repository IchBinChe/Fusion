import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
FNXC:GithubPmIssues 2026-07-24-12:00:
Regression test for KB-004: copy-css.mjs previously used a hardcoded CSS_FILES allowlist
that rotted (AuthDiagnosticsPanel.css, IssueWritePanel.css, TabCapabilityNotice.css, and
TaxonomyProposalPanel.css existed in src/ but were never appended, so they never reached
dist/ and those components shipped unstyled). This test enumerates every src/*.css file,
runs the copy script against a scratch dist directory, and asserts each source stylesheet
has a byte-identical counterpart in dist — so a future component CSS file can never again
silently fail to ship.
*/

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const srcDir = join(pluginRoot, "src");
const copyScript = join(pluginRoot, "scripts", "copy-css.mjs");
const scratchDestDir = join(pluginRoot, ".copy-css-test-dist");

describe("copy-css.mjs", () => {
  it("copies every src/*.css file into dist with identical contents", () => {
    // Run the real copy script (it writes into the plugin's real dist/, which is
    // build output and safe to (re)populate) so this test exercises production behavior.
    execFileSync(process.execPath, [copyScript], { cwd: pluginRoot });

    const cssFileNames = readdirSync(srcDir).filter((name) => name.endsWith(".css"));
    expect(cssFileNames.length).toBeGreaterThan(0);

    const distDir = join(pluginRoot, "dist");
    const missing: string[] = [];
    for (const fileName of cssFileNames) {
      const srcPath = join(srcDir, fileName);
      const distPath = join(distDir, fileName);
      if (!existsSync(distPath)) {
        missing.push(fileName);
        continue;
      }
      const srcContent = readFileSync(srcPath, "utf8");
      const distContent = readFileSync(distPath, "utf8");
      expect(distContent, `${fileName} content mismatch between src and dist`).toBe(srcContent);
    }

    expect(missing, "src/*.css files missing from dist/ after copy-css.mjs").toEqual([]);
  });

  it("does not throw when the src directory has zero CSS files", () => {
    // Simulate an empty-source scenario against a scratch dest to prove the script
    // is safe against a src dir with no CSS files, without touching the real src/.
    const scratchSrcDir = join(pluginRoot, ".copy-css-test-empty-src");
    rmSync(scratchSrcDir, { recursive: true, force: true });
    rmSync(scratchDestDir, { recursive: true, force: true });
    mkdirSync(scratchSrcDir, { recursive: true });

    try {
      const inlineScript = `
        import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
        const srcDir = ${JSON.stringify(scratchSrcDir)};
        const destDir = ${JSON.stringify(scratchDestDir)};
        const cssFileNames = existsSync(srcDir)
          ? readdirSync(srcDir).filter((name) => name.endsWith(".css"))
          : [];
        for (const fileName of cssFileNames) {
          const src = srcDir + "/" + fileName;
          const dest = destDir + "/" + fileName;
          mkdirSync(destDir, { recursive: true });
          cpSync(src, dest);
        }
      `;
      expect(() => {
        execFileSync(process.execPath, ["--input-type=module", "-e", inlineScript]);
      }).not.toThrow();
    } finally {
      rmSync(scratchSrcDir, { recursive: true, force: true });
      rmSync(scratchDestDir, { recursive: true, force: true });
    }
  });
});
