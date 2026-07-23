import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

FNXC:GithubPmIssues 2026-07-24-12:00:
The explicit CSS_FILES allowlist above rotted: AuthDiagnosticsPanel.css, IssueWritePanel.css,
TabCapabilityNotice.css, and TaxonomyProposalPanel.css were added to src/ (FUSI-014, FUSI-009,
FUSI-017, taxonomy work) but never appended to the list, so those components shipped unstyled
to the dashboard host (found while working KB-002/KB-004). Switched to a glob over every
`*.css` file directly under src/ (single-level, no recursion) so future component stylesheets
ship automatically without anyone needing to remember to edit this file.
*/
const cssFileNames = existsSync(srcDir)
  ? readdirSync(srcDir).filter((name) => name.endsWith(".css"))
  : [];

for (const fileName of cssFileNames) {
  const src = join(srcDir, fileName);
  const dest = join(destDir, fileName);
  if (existsSync(src)) {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}
