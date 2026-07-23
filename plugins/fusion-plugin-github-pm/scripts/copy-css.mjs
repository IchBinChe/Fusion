import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const destDir = join(root, "dist");

// FNXC:GithubPmIssues 2026-07-24-01:30:
// FUSI-013 adds IssueDetailView.css alongside GitHubPmView.css; copy every plugin
// component CSS file by name rather than growing an ever-longer explicit list.
const cssFiles = ["GitHubPmView.css", "IssueDetailView.css"];

for (const fileName of cssFiles) {
  const src = join(srcDir, fileName);
  const dest = join(destDir, fileName);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}
