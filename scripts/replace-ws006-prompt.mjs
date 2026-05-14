#!/usr/bin/env node
/**
 * Replace the WS-006 (Frontend UX Design) workflow step prompt in the database
 * with the updated version that uses structured JSON verdict output.
 *
 * Usage:
 *   node scripts/replace-ws006-prompt.mjs [--db=.fusion/fusion.db] [--dry-run]
 *
 * Flags:
 *   --db=<path>    Path to the SQLite database (default: .fusion/fusion.db)
 *   --dry-run      Print the new prompt without writing to the database
 *
 * Idempotent: re-running replaces the prompt again with the same content.
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dbArg = args.find((a) => a.startsWith("--db="));
const dryRun = args.includes("--dry-run");
const dbPath = dbArg ? dbArg.slice(5) : ".fusion/fusion.db";

const NEW_PROMPT = `You are a UX design reviewer. Verify frontend changes maintain visual polish and consistency with existing UI patterns and design tokens.

## Step 1: Scope Check (MANDATORY FIRST)

The task harness provides a "Diff Scope" listing files this task actually changed.

If the Diff Scope contains ZERO frontend/UI files (no .tsx/.jsx/.ts/.js component files, no .css/.scss/.sass/.styl, no .html/.vue/.svelte/.astro, no design-token/theme files), output ONLY:

\`\`\`json-workflow-verdict
{"verdict":"PASS","notes":"No UI changes in scope — approved."}
\`\`\`

Then STOP. Do not browse the worktree. Do not read any files.

If there ARE frontend/UI files in scope, proceed to Step 2.

## Step 2: Design Review

Restrict your review to ONLY the UI files in the diff scope.

Check:
1. **Visual Hierarchy** — heading levels, content flow, information architecture
2. **Spacing and Typography** — consistent margins, padding, gaps, type scale
3. **Color and Token Consistency** — CSS custom properties and design tokens used; no hardcoded colors
4. **Component Reuse** — existing components reused; no one-off styling or duplication
5. **Responsive Behavior** — layouts adapt across viewports
6. **Fit with Design Language** — border radius, shadows, transitions, icon style match patterns

## Output Format

End your response with a JSON verdict block:

For clean reviews:
\`\`\`json-workflow-verdict
{"verdict":"PASS","notes":"<1-2 sentence summary>"}
\`\`\`

For issues requiring code changes:
\`\`\`json-workflow-verdict
{"verdict":"FAIL","notes":"<specific files and what needs to change>"}
\`\`\`

Prioritize: layout breaks > visual inconsistency > style preferences.
Do NOT spend time on nits when no real issues exist.`;

const STEP_ID = "frontend-ux-design";

async function main() {
  if (dryRun) {
    console.log("=== DRY RUN: New WS-006 prompt ===\n");
    console.log(NEW_PROMPT);
    console.log("\n=== End of prompt ===");
    return;
  }

  const resolvedPath = resolve(dbPath);
  console.log(`Opening database: ${resolvedPath}`);

  const db = new Database(resolvedPath);

  // Check if the workflow step exists
  const row = db.prepare("SELECT id, name, prompt FROM workflow_steps WHERE id = ?").get(STEP_ID);

  if (!row) {
    console.error(`Workflow step '${STEP_ID}' not found in database. No action taken.`);
    db.close();
    process.exit(0);
  }

  console.log(`Found workflow step: ${row.name} (${row.id})`);
  console.log(`Old prompt length: ${row.prompt?.length ?? 0} chars`);
  console.log(`New prompt length: ${NEW_PROMPT.length} chars`);

  const result = db.prepare("UPDATE workflow_steps SET prompt = ?, updatedAt = ? WHERE id = ?").run(
    NEW_PROMPT,
    new Date().toISOString(),
    STEP_ID,
  );

  console.log(`Updated ${result.changes} row(s).`);
  db.close();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
