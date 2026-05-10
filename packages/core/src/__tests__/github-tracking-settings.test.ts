import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTaskGithubTracking } from "../github-tracking.js";
import type { TaskGithubTrackedIssue } from "../types.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-store-github-tracking-settings-test-"));
}

describe("github tracking settings inheritance", () => {
  it.each([
    ["task", { githubTracking: { repoOverride: "task/override" } }, { githubTrackingDefaultRepo: "project/default" }, { githubTrackingDefaultRepo: "global/default" }, "task/override"],
    ["project", { githubTracking: {} }, { githubTrackingDefaultRepo: "project/default" }, { githubTrackingDefaultRepo: "global/default" }, "project/default"],
    ["global", { githubTracking: {} }, {}, { githubTrackingDefaultRepo: "global/default" }, "global/default"],
    ["none", { githubTracking: {} }, {}, {}, null],
  ] as const)("resolves repo with %s precedence", (_name, task, projectSettings, globalSettings, expectedSlug) => {
    const resolved = resolveTaskGithubTracking(task as any, projectSettings as any, globalSettings as any);
    const actual = resolved.repo ? `${resolved.repo.owner}/${resolved.repo.repo}` : null;
    expect(actual).toBe(expectedSlug);
  });

  it.each([
    ["task", { githubTracking: { enabled: true } }, { githubTrackingEnabledByDefault: false }, undefined, true],
    ["project", { githubTracking: {} }, { githubTrackingEnabledByDefault: true }, undefined, true],
    ["global", { githubTracking: {} }, {}, { githubTrackingDefaultEnabledForNewTasks: true }, true],
    ["default", { githubTracking: {} }, {}, undefined, false],
  ] as const)("resolves enabled with %s precedence", (_name, task, projectSettings, globalSettings, expectedEnabled) => {
    const resolved = resolveTaskGithubTracking(task as any, projectSettings as any, globalSettings as any);
    expect(resolved.enabled).toBe(expectedEnabled);
  });
});

describe("github tracking task persistence", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = makeTmpDir();
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
    await rm(globalDir, { recursive: true, force: true });
  });

  it("defaults new tasks to tracking off when no override exists", async () => {
    const task = await store.createTask({ description: "Default tracking off" });
    const resolved = resolveTaskGithubTracking(task, { githubTrackingEnabledByDefault: false }, undefined);
    expect(task.githubTracking).toBeUndefined();
    expect(resolved.enabled).toBe(false);
  });

  it("round-trips per-task githubTracking through create, load, and update", async () => {
    const issue: TaskGithubTrackedIssue = {
      owner: "octocat",
      repo: "hello-world",
      number: 42,
      url: "https://github.com/octocat/hello-world/issues/42",
      createdAt: "2026-05-09T00:00:00.000Z",
    };

    const created = await store.createTask({
      description: "Track this",
      githubTracking: {
        enabled: true,
        repoOverride: "octocat/hello-world",
        issue,
      },
    });

    const loaded = await store.getTask(created.id);
    expect(loaded?.githubTracking).toEqual({
      enabled: true,
      repoOverride: "octocat/hello-world",
      issue,
    });

    await store.updateGithubTracking(created.id, {
      enabled: false,
      repoOverride: "octocat/updated-repo",
      issue,
    });

    const updated = await store.getTask(created.id);
    expect(updated?.githubTracking).toEqual({
      enabled: false,
      repoOverride: "octocat/updated-repo",
      issue,
    });
  });
});
