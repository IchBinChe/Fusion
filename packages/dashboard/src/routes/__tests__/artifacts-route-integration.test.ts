// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type ArtifactWithTask } from "@fusion/core";
import { createApiRoutes } from "../../routes.js";
import { request as REQUEST } from "../../test-request.js";

/*
 * FNXC:ArtifactRegistry 2026-06-27-00:00:
 * The mocked artifacts route tests skip the real listArtifacts LEFT JOIN and hand-write media files. This integration test uses a real TaskStore so the Documents Artifacts view contract is pinned end-to-end: registered image artifacts list with task metadata and stream from the real disk write path.
 */
describe("artifacts route integration", () => {
  let store: TaskStore;
  let rootDir: string;
  let globalDir: string;
  let app: express.Express;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "artifacts-route-root-"));
    globalDir = mkdtempSync(join(tmpdir(), "artifacts-route-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();

    app = express();
    app.use(express.json());
    app.use("/api", createApiRoutes(store));
  });

  afterEach(() => {
    store.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  async function createTaskImageArtifact() {
    const task = await store.createTask({
      title: "Render screenshot",
      description: "Capture dashboard artifact rendering evidence",
    });
    const imageBytes = Buffer.from("PNG-FN-7125-route-integration-image-bytes", "utf8");
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Dashboard screenshot",
      mimeType: "image/png",
      data: imageBytes,
      authorId: "agent-7125",
      authorType: "agent",
      taskId: task.id,
    });
    return { task, artifact, imageBytes };
  }

  it("an image artifact created on a task appears in the artifacts listing with task association", async () => {
    const { task, artifact } = await createTaskImageArtifact();

    const res = await REQUEST(app, "GET", "/api/artifacts");

    expect(res.status).toBe(200);
    const body = res.body as ArtifactWithTask[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      id: artifact.id,
      type: "image",
      mimeType: "image/png",
      title: "Dashboard screenshot",
      authorId: "agent-7125",
      taskId: task.id,
      taskTitle: "Render screenshot",
    });
    expect(body[0].taskColumn).toBeTruthy();
  });

  it("the image artifact streams its real bytes with the correct content type", async () => {
    const { artifact, imageBytes } = await createTaskImageArtifact();

    const res = await REQUEST(app, "GET", `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(res.body as string, "utf8")).toEqual(imageBytes);
  });

  it("a global image artifact still streams from the managed global artifacts directory", async () => {
    const imageBytes = Buffer.from("PNG-FN-7143-global-image-bytes", "utf8");
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Global screenshot",
      mimeType: "image/png",
      data: imageBytes,
      authorId: "agent-7143",
      authorType: "agent",
    });

    const res = await REQUEST(app, "GET", `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.from(res.body as string, "utf8")).toEqual(imageBytes);
  });

  it("a URI-only image artifact whose file is missing still returns 404", async () => {
    const task = await store.createTask({
      title: "Missing screenshot",
      description: "Preserve existing missing media semantics",
    });
    const artifact = await store.registerArtifact({
      type: "image",
      title: "Missing screenshot",
      mimeType: "image/png",
      uri: "artifacts/missing.png",
      authorId: "agent-7143",
      authorType: "agent",
      taskId: task.id,
    });

    const res = await REQUEST(app, "GET", `/api/artifacts/${artifact.id}/media`);

    expect(res.status).toBe(404);
  });

  it("a task with no artifacts lists as empty", async () => {
    const task = await store.createTask({
      title: "Render screenshot",
      description: "Capture dashboard artifact rendering evidence",
    });

    const res = await REQUEST(app, "GET", `/api/artifacts?taskId=${encodeURIComponent(task.id)}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
