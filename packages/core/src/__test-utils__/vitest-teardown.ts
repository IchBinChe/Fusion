/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export default function setup(): () => Promise<void> {
  // Use a fresh root for each Vitest invocation. A static shared root makes the
  // setup-time redirect sweep proportional to stale directories left by every
  // prior interrupted run.
  const workerRoot = resolve(mkdtempSync(join(tmpdir(), "fusion-test-workers-")));
  process.env.FUSION_TEST_WORKER_ROOT = workerRoot;

  return async function teardown() {
    try {
      process.chdir(tmpdir());
    } catch {
      // Ignore — cleanup below is best-effort and uses an absolute path.
    }
    try {
      rmSync(workerRoot, { recursive: true, force: true });
    } catch {
      // Ignore — interrupted or still-active workers may leave a per-run root
      // behind, but future runs no longer sweep it because every invocation gets
      // a fresh root.
    }
  };
}
