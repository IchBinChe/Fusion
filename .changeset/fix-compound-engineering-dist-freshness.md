---
"@runfusion/fusion": patch
---

Fix the persistent non-blocking Full Suite failure caused by the Compound Engineering plugin's `dist-freshness.test.ts`. The test reads the plugin's compiled `dist/settings.js` and `dist/session/orchestrator.js`, but the plugin had no `pretest` build and was absent from `ensure-test-artifacts.mjs`, so on a fresh checkout `dist/` did not exist and the freshness guard threw "dist/ is missing — run pnpm build first". Register the plugin's required artifacts in `ensure-test-artifacts.mjs` and add a `pretest` hook that builds them, matching the other bundled plugins.
