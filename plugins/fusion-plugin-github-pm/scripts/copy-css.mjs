import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const destDir = join(root, "dist");

/*
FNXC:GithubPmIssues 2026-07-24-03:35:
FUSI-013 adds IssueDetailView.css and FUSI-012 adds IssuesPanel.css alongside GitHubPmView.css;
copy every plugin component CSS file by name from a FILE LIST rather than growing an
ever-longer explicit src/dest pair, so each task just appends its filename to CSS_FILES
and compositions compose cleanly regardless of merge order.
*/
/*
FNXC:GithubPmLabels 2026-07-24-11:50:
KB-002 appends LabelsPanel.css so the new labels-management panel's styling actually ships in
the built dist/ output (dist assets are what the dashboard host loads at runtime -- an
unlisted component CSS file silently never reaches production). This list was already missing
other pre-existing component CSS files (AuthDiagnosticsPanel.css, IssueWritePanel.css,
TabCapabilityNotice.css, TaxonomyProposalPanel.css) before this task; that is a separate,
pre-existing gap tracked as a follow-up rather than expanded here.
*/
const CSS_FILES = ["GitHubPmView.css", "IssueDetailView.css", "IssuesPanel.css", "LabelsPanel.css"];

for (const fileName of CSS_FILES) {
  const src = join(srcDir, fileName);
  const dest = join(destDir, fileName);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}
