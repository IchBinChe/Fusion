// @vitest-environment node
//
// FN-7659: HTTP-level coverage for GET /tasks/archived — the dedicated
// paged archived-tasks read backing the Archived board column. Asserts
// newest-first ordering, LIMIT/OFFSET pagination windows, empty-archive
// shape, and 400 rejection for invalid params.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

describe("GET /tasks/archived", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "tasks-archived-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "tasks-archived-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store, undefined));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("returns empty tasks/total 0/hasMore false for an empty archive", async () => {
    const res = await REQUEST(app, "GET", "/api/tasks/archived");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tasks: [], total: 0, hasMore: false });
  });

  it("returns archived tasks newest-first (archivedAt DESC)", async () => {
    const a = await store.createTask({ description: "archived-a" });
    const b = await store.createTask({ description: "archived-b" });
    const c = await store.createTask({ description: "archived-c" });
    // Archive in an order that diverges from createdAt to prove ordering
    // is driven by archivedAt, not createdAt.
    await store.archiveTask(c.id, true);
    await store.archiveTask(a.id, true);
    await store.archiveTask(b.id, true);

    const res = await REQUEST(app, "GET", "/api/tasks/archived?limit=100&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.tasks.map((t: { id: string }) => t.id)).toEqual([b.id, a.id, c.id]);
  });

  it("paginates with LIMIT/OFFSET windows and correct hasMore transitions", async () => {
    for (let i = 0; i < 5; i++) {
      const task = await store.createTask({ description: `archive-window-${i}` });
      await store.archiveTask(task.id, true);
    }

    const page1 = await REQUEST(app, "GET", "/api/tasks/archived?limit=2&offset=0");
    expect(page1.body.tasks).toHaveLength(2);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await REQUEST(app, "GET", "/api/tasks/archived?limit=2&offset=2");
    expect(page2.body.tasks).toHaveLength(2);
    expect(page2.body.hasMore).toBe(true);

    const page3 = await REQUEST(app, "GET", "/api/tasks/archived?limit=2&offset=4");
    expect(page3.body.tasks).toHaveLength(1);
    expect(page3.body.hasMore).toBe(false);
  });

  it("rejects invalid limit/offset with 400", async () => {
    const badLimit = await REQUEST(app, "GET", "/api/tasks/archived?limit=0");
    expect(badLimit.status).toBe(400);

    const negativeLimit = await REQUEST(app, "GET", "/api/tasks/archived?limit=-5");
    expect(negativeLimit.status).toBe(400);

    const negativeOffset = await REQUEST(app, "GET", "/api/tasks/archived?offset=-1");
    expect(negativeOffset.status).toBe(400);

    const nonNumericLimit = await REQUEST(app, "GET", "/api/tasks/archived?limit=abc");
    expect(nonNumericLimit.status).toBe(400);
  });
});
