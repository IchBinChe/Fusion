import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../db.js";
import { TaskStore } from "../store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-artifacts-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TaskStore artifacts", () => {
  let rootDir: string;
  let fusionDir: string;
  let db: Database;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    fusionDir = join(rootDir, ".fusion");
    db = new Database(fusionDir);
    db.init();
    store = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
    await store.init();
  });

  afterEach(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    await rm(rootDir, { recursive: true, force: true });
  });

  it("registers inline text artifacts and supports getArtifact hit and miss", async () => {
    const task = await store.createTask({ title: "Artifact task", description: "Inline artifact task" });

    const artifact = await store.registerArtifact({
      type: "document",
      title: "Research notes",
      description: "Inline evidence",
      mimeType: "text/markdown",
      content: "# Notes",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: task.id,
      metadata: { source: "test", tags: ["artifact"] },
    });

    expect(artifact.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(artifact.type).toBe("document");
    expect(artifact.title).toBe("Research notes");
    expect(artifact.description).toBe("Inline evidence");
    expect(artifact.mimeType).toBe("text/markdown");
    expect(artifact.content).toBe("# Notes");
    expect(artifact.uri).toBeUndefined();
    expect(artifact.taskId).toBe(task.id);
    expect(artifact.metadata).toEqual({ source: "test", tags: ["artifact"] });

    await expect(store.getArtifact(artifact.id)).resolves.toEqual(artifact);
    await expect(store.getArtifact("missing-artifact")).resolves.toBeNull();
  });

  it("emits an authoritative event after artifact registration succeeds", async () => {
    const task = await store.createTask({ title: "Artifact event task", description: "Emit artifact event" });
    const registered = vi.fn();
    store.on("artifact:registered", registered);

    const artifact = await store.registerArtifact({
      type: "document",
      title: "Evented artifact",
      content: "# Event",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: task.id,
    });

    expect(registered).toHaveBeenCalledTimes(1);
    expect(registered).toHaveBeenCalledWith(artifact);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-04-20:10:
   * Reproduces FN-7544: an agent registers an artifact through one TaskStore instance (e.g. the
   * engine's own store) while a SECOND TaskStore instance on the same project (e.g. the dashboard's
   * cached getOrCreateProjectStore instance, or a second dashboard process) is the one whose SSE
   * listeners actually serve the Documents/task Artifacts galleries. Before the fix, registerArtifact()
   * never bumped lastModified and checkForChanges() never looked at the artifacts table at all, so the
   * observer instance's `artifact:registered` subscribers never fired for artifacts written elsewhere —
   * the exact symptom reported: the artifact exists in the DB (a plain GET/listArtifacts finds it) but
   * nothing tells an already-open dashboard gallery to refresh, and any subscriber relying solely on the
   * live event has no way to discover the row.
   */
  it("a second TaskStore polling the same DB observes artifact:registered for artifacts it did not write", async () => {
    const task = await store.createTask({ title: "Cross-instance artifact task", description: "Cross-instance artifact registration" });

    const observer = new TaskStore(rootDir, join(rootDir, ".fusion-global-settings"));
    await observer.init();
    await observer.watch();
    const observerRegistered = vi.fn();
    observer.on("artifact:registered", observerRegistered);

    try {
      const artifact = await store.registerArtifact({
        type: "document",
        title: "Written by another instance",
        content: "# Cross-instance",
        authorId: "agent-cross-instance",
        authorType: "agent",
        taskId: task.id,
      });

      // Drive the observer's poll cycle directly so we don't wait on the 1s interval.
      await (observer as unknown as { checkForChanges: () => Promise<void> }).checkForChanges();

      expect(observerRegistered).toHaveBeenCalledTimes(1);
      expect(observerRegistered).toHaveBeenCalledWith(expect.objectContaining({ id: artifact.id, title: "Written by another instance" }));

      // The observer must not re-emit on a second poll cycle for the same row.
      observerRegistered.mockClear();
      await (observer as unknown as { checkForChanges: () => Promise<void> }).checkForChanges();
      expect(observerRegistered).not.toHaveBeenCalled();

      // Confirm the artifact is also readable via the observer's own listArtifacts query
      // (the store-query surface, independent of the live SSE event).
      const observerList = await observer.listArtifacts({ taskId: task.id });
      expect(observerList.map((a) => a.id)).toContain(artifact.id);
    } finally {
      await observer.close();
    }
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-04-20:10:
   * FN-7544: the cross-instance polling fix must never leak an artifact registered in one project's
   * TaskStore/DB into a completely separate project's store or its `artifact:registered` subscribers.
   * Each project is a distinct rootDir/DB file, so this proves the fix stays scoped per-project.
   */
  it("does not leak artifact:registered or listArtifacts rows across separate project stores", async () => {
    const otherRootDir = makeTmpDir();
    const otherStore = new TaskStore(otherRootDir, join(otherRootDir, ".fusion-global-settings"));
    await otherStore.init();
    await otherStore.watch();
    const otherRegistered = vi.fn();
    otherStore.on("artifact:registered", otherRegistered);

    try {
      await store.registerArtifact({
        type: "document",
        title: "Project A only",
        content: "# Project A",
        authorId: "agent-project-a",
        authorType: "agent",
      });

      await (otherStore as unknown as { checkForChanges: () => Promise<void> }).checkForChanges();

      expect(otherRegistered).not.toHaveBeenCalled();
      const otherList = await otherStore.listArtifacts();
      expect(otherList).toHaveLength(0);
    } finally {
      await otherStore.close();
      await rm(otherRootDir, { recursive: true, force: true });
    }
  });

  it("stores binary artifacts on disk under the task artifacts directory", async () => {
    const task = await store.createTask({ description: "Binary artifact task" });
    const data = Buffer.from([0, 1, 2, 3, 255]);

    const artifact = await store.registerArtifact({
      type: "image",
      title: "diagram image.png",
      mimeType: "image/png",
      content: "must not be stored with binary data",
      data,
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: task.id,
    });

    expect(artifact.uri).toMatch(/^artifacts\//);
    expect(artifact.sizeBytes).toBe(data.length);
    expect(artifact.content).toBeUndefined();

    const storedPath = join(store.getTaskDir(task.id), artifact.uri!);
    expect(existsSync(storedPath)).toBe(true);
    await expect(readFile(storedPath)).resolves.toEqual(data);

    const row = db
      .prepare("SELECT content, uri, sizeBytes FROM artifacts WHERE id = ?")
      .get(artifact.id) as { content: string | null; uri: string; sizeBytes: number };
    expect(row.content).toBeNull();
    expect(row.uri).toBe(artifact.uri);
    expect(row.sizeBytes).toBe(data.length);
  });

  it("returns [] for empty, populated, and soft-deleted task artifact states", async () => {
    const task = await store.createTask({ description: "List artifacts task" });
    const emptyTask = await store.createTask({ description: "Empty artifact task" });

    await expect(store.getArtifacts(emptyTask.id)).resolves.toEqual([]);

    const first = await store.registerArtifact({
      type: "document",
      title: "First artifact",
      content: "first",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: task.id,
    });
    await sleep(2);
    const second = await store.registerArtifact({
      type: "image",
      title: "Second artifact",
      data: Buffer.from("image"),
      authorId: "agent-beta",
      authorType: "agent",
      taskId: task.id,
    });

    const artifacts = await store.getArtifacts(task.id);
    expect(artifacts.map((artifact) => artifact.id)).toEqual([second.id, first.id]);

    await store.deleteTask(task.id);
    await expect(store.getArtifacts(task.id)).resolves.toEqual([]);
  });

  it("filters listArtifacts across agents, tasks, types, search, and pagination", async () => {
    const taskA = await store.createTask({ title: "Alpha task", description: "Artifact task A" });
    const taskB = await store.createTask({ title: "Beta task", description: "Artifact task B" });

    const first = await store.registerArtifact({
      type: "document",
      title: "Alpha research memo",
      description: "contains searchable token",
      content: "memo",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: taskA.id,
    });
    await sleep(2);
    const second = await store.registerArtifact({
      type: "image",
      title: "Beta screenshot",
      data: Buffer.from("png"),
      authorId: "agent-beta",
      authorType: "agent",
      taskId: taskB.id,
    });
    await sleep(2);
    const third = await store.registerArtifact({
      type: "audio",
      title: "Gamma narration",
      data: Buffer.from("audio"),
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: taskB.id,
    });

    const all = await store.listArtifacts();
    expect(all.map((artifact) => artifact.id)).toEqual([third.id, second.id, first.id]);
    expect(all.find((artifact) => artifact.id === first.id)?.taskTitle).toBe("Alpha task");
    expect(all.find((artifact) => artifact.id === second.id)?.taskTitle).toBe("Beta task");
    /*
     * FNXC:ArtifactRegistry 2026-06-23-09:52:
     * Artifact registry listings are an execution-time discovery surface, so tests must lock the metadata-only contract that prevents inline content from being loaded during list operations.
     */
    expect(all.every((artifact) => artifact.content === undefined)).toBe(true);

    await expect(store.listArtifacts({ type: "image" })).resolves.toMatchObject([{ id: second.id }]);
    expect((await store.listArtifacts({ authorId: "agent-alpha" })).map((artifact) => artifact.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect((await store.listArtifacts({ taskId: taskB.id })).map((artifact) => artifact.id)).toEqual([
      third.id,
      second.id,
    ]);
    await expect(store.listArtifacts({ search: "searchable token" })).resolves.toMatchObject([{ id: first.id }]);
    await expect(store.listArtifacts({ limit: 1, offset: 1 })).resolves.toMatchObject([{ id: second.id }]);
  });

  it("keeps task-less artifacts queryable while hiding artifacts for soft-deleted tasks", async () => {
    const liveTask = await store.createTask({ title: "Live artifact task", description: "Live" });
    const deletedTask = await store.createTask({ title: "Deleted artifact task", description: "Deleted" });

    const live = await store.registerArtifact({
      type: "document",
      title: "Live artifact",
      content: "live",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: liveTask.id,
    });
    const hidden = await store.registerArtifact({
      type: "document",
      title: "Hidden artifact",
      content: "hidden",
      authorId: "agent-alpha",
      authorType: "agent",
      taskId: deletedTask.id,
    });
    const registry = await store.registerArtifact({
      type: "other",
      title: "Registry artifact",
      data: Buffer.from("registry"),
      authorId: "system",
      authorType: "system",
    });

    await store.deleteTask(deletedTask.id);

    const artifacts = await store.listArtifacts();
    expect(artifacts.map((artifact) => artifact.id).sort()).toEqual([live.id, registry.id].sort());
    expect(artifacts.find((artifact) => artifact.id === registry.id)?.taskTitle).toBeUndefined();

    const hiddenRow = db.prepare("SELECT id FROM artifacts WHERE id = ?").get(hidden.id) as { id: string } | undefined;
    expect(hiddenRow?.id).toBe(hidden.id);
  });

  it("rejects registering artifacts for archived or missing tasks", async () => {
    const task = await store.createTask({ description: "Archived artifact task" });
    await store.moveTask(task.id, "todo");
    await store.moveTask(task.id, "in-progress");
    await store.moveTask(task.id, "in-review");
    await store.moveTask(task.id, "done");
    await store.archiveTask(task.id, true);

    await expect(
      store.registerArtifact({
        type: "document",
        title: "Archived artifact",
        content: "nope",
        authorId: "agent-alpha",
        authorType: "agent",
        taskId: task.id,
      }),
    ).rejects.toThrow(/archived/i);

    await expect(
      store.registerArtifact({
        type: "document",
        title: "Missing artifact",
        content: "nope",
        authorId: "agent-alpha",
        authorType: "agent",
        taskId: "FN-DOES-NOT-EXIST",
      }),
    ).rejects.toThrow("Task FN-DOES-NOT-EXIST not found");
  });
});
