import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHarness } from "./_harness.js";

function workerRoot(): string {
  const root = process.env.FUSION_TEST_WORKER_ROOT;
  if (!root) throw new Error("FUSION_TEST_WORKER_ROOT is not set");
  return resolve(root);
}

describe("compound-engineering setup invariants", () => {
  it("uses a per-run worker temp root for redirected temp fixtures", () => {
    const root = workerRoot();

    // Regression guard for FN-6282: this must not be the old static
    // tmpdir()/fusion-test-workers directory whose one-level redirect sweep made
    // setup proportional to stale directories from prior interrupted runs.
    expect(basename(root)).toMatch(/^fusion-test-workers-/);
    expect(root).not.toBe(resolve(tmpdir(), "fusion-test-workers"));

    const tempFixture = mkdtempSync(join(tmpdir(), "ce-setup-guard-"));
    try {
      expect(resolve(tempFixture).startsWith(root + sep)).toBe(true);
    } finally {
      rmSync(tempFixture, { recursive: true, force: true });
    }
  });

  it("closes the CE harness and removes its redirected project root", () => {
    const root = workerRoot();
    const harness = makeHarness();
    const projectRoot = resolve(harness.projectRoot);

    expect(projectRoot.startsWith(root + sep)).toBe(true);
    expect(existsSync(projectRoot)).toBe(true);

    harness.close();

    expect(existsSync(projectRoot)).toBe(false);
  });
});
