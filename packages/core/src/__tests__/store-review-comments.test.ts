import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskStore } from "../store.js";

describe("TaskStore review comment ingestion", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "store-review-comments-"));
    globalDir = join(rootDir, ".fusion-global-settings");
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    await store.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("inserts github review comment metadata on first write", async () => {
    const task = await store.createTask({ description: "review ingest", column: "in-review" });

    await store.addComment(task.id, "Needs fixes", "github:alice", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-101",
      reviewState: "CHANGES_REQUESTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments?.[0]).toMatchObject({
      source: "github-review",
      externalId: "review-101",
      reviewState: "CHANGES_REQUESTED",
      author: "github:alice",
    });
  });

  it("deduplicates repeated writes by source + externalId", async () => {
    const task = await store.createTask({ description: "dedupe", column: "in-review" });

    await store.addComment(task.id, "Please address", "github:bob", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-102",
      reviewState: "CHANGES_REQUESTED",
    });
    await store.addComment(task.id, "Please address updated", "github:bob", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-102",
      reviewState: "CHANGES_REQUESTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments?.[0]?.text).toBe("Please address");
  });

  it("keeps interleaved review and review-comment threads distinct", async () => {
    const task = await store.createTask({ description: "interleave", column: "in-review" });

    await store.addComment(task.id, "Review summary", "github:alice", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-201",
      reviewState: "COMMENTED",
    });
    await store.addComment(task.id, "Inline comment 1", "github:alice", {
      skipRefinement: true,
      source: "github-review-comment",
      externalId: "comment-301",
      reviewState: "COMMENTED",
    });
    await store.addComment(task.id, "Inline comment 2", "github:alice", {
      skipRefinement: true,
      source: "github-review-comment",
      externalId: "comment-302",
      reviewState: "COMMENTED",
    });

    const updated = await store.getTask(task.id);
    expect(updated.comments).toHaveLength(3);
    expect(updated.comments?.map((comment) => `${comment.source}:${comment.externalId}`)).toEqual([
      "github-review:review-201",
      "github-review-comment:comment-301",
      "github-review-comment:comment-302",
    ]);
  });

  it("respects skipRefinement for done task github comments", async () => {
    const task = await store.createTask({ description: "done", column: "done" });

    await store.addComment(task.id, "changes requested", "github:reviewer", {
      skipRefinement: true,
      source: "github-review",
      externalId: "review-500",
      reviewState: "CHANGES_REQUESTED",
    });

    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);
  });
});
