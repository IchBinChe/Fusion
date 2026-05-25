import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DependencyCycleError,
  detectDependencyCycle,
} from "../store.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("detectDependencyCycle", () => {
  const lookup = (graph: Record<string, string[]>) => (taskId: string) => graph[taskId];

  it("detects direct self-edge", () => {
    expect(detectDependencyCycle("A", ["A"], lookup({}))).toEqual(["A", "A"]);
  });

  it("detects 2-node cycle", () => {
    expect(detectDependencyCycle("A", ["B"], lookup({ B: ["A"] }))).toEqual(["A", "B", "A"]);
  });

  it("detects 3-node cycle", () => {
    expect(detectDependencyCycle("FN-5240", ["FN-5241"], lookup({
      "FN-5241": ["FN-5242"],
      "FN-5242": ["FN-5240"],
    }))).toEqual(["FN-5240", "FN-5241", "FN-5242", "FN-5240"]);
  });

  it("returns null for diamond non-cycle", () => {
    expect(detectDependencyCycle("A", ["B", "C"], lookup({ B: ["D"], C: ["D"], D: [] }))).toBeNull();
  });

  it("detects 4-node cycle", () => {
    expect(detectDependencyCycle("FN-A", ["FN-B"], lookup({
      "FN-B": ["FN-C"],
      "FN-C": ["FN-D"],
      "FN-D": ["FN-A"],
    }))).toEqual(["FN-A", "FN-B", "FN-C", "FN-D", "FN-A"]);
  });

  it("ignores missing dependencies", () => {
    expect(detectDependencyCycle("A", ["MISSING"], lookup({}))).toBeNull();
  });

  it("supports candidate not yet persisted", () => {
    expect(detectDependencyCycle("A", ["B"], lookup({ B: ["C"], C: [] }))).toBeNull();
  });
});

describe("TaskStore dependency cycle guard", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(async () => {
    await harness.beforeEach();
  });

  afterEach(async () => {
    await harness.afterEach();
  });

  it("rejects cycle-forming update and preserves persisted dependencies", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B", dependencies: [a.id] });

    await expect(store.updateTask(a.id, { dependencies: [b.id] })).rejects.toBeInstanceOf(DependencyCycleError);

    const refreshedA = await store.getTask(a.id);
    expect(refreshedA.dependencies).toEqual([]);

    const rows = (store as any).db.prepare(`SELECT mutationType FROM runAuditEvents WHERE taskId = ? AND mutationType = ?`).all(a.id, "task:dependency-cycle-rejected");
    expect(rows).toHaveLength(1);
  });

  it("accepts umbrella parent depending on children with no back-edge", async () => {
    const store = harness.store();
    const childA = await store.createTask({ title: "child-a", description: "a" });
    const childB = await store.createTask({ title: "child-b", description: "b" });

    const parent = await store.createTask({
      title: "umbrella",
      description: "parent",
      dependencies: [childA.id, childB.id],
    });

    expect(parent.dependencies).toEqual([childA.id, childB.id]);
  });

  it("rejects FN-5240/FN-5241/FN-5242 write-time cycle signature", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "FN-5240", description: "A" });
    const b = await store.createTask({ title: "FN-5241", description: "B" });
    const c = await store.createTask({ title: "FN-5242", description: "C" });

    await store.updateTask(b.id, { dependencies: [c.id] });
    await store.updateTask(c.id, { dependencies: [a.id] });

    let error: DependencyCycleError | null = null;
    try {
      await store.updateTask(a.id, { dependencies: [b.id] });
    } catch (caught) {
      error = caught as DependencyCycleError;
    }

    expect(error).toBeInstanceOf(DependencyCycleError);
    expect(error?.cyclePath).toEqual([a.id, b.id, c.id, a.id]);
    expect(error?.message).toContain(`${a.id} → ${b.id} → ${c.id} → ${a.id}`);

    const refreshedA = await store.getTask(a.id);
    expect(refreshedA.dependencies).toEqual([]);
  });

  it("rejects umbrella back-edge update and records source metadata", async () => {
    const store = harness.store();
    const childA = await store.createTask({ title: "child-a", description: "a" });
    const childB = await store.createTask({ title: "child-b", description: "b" });
    const umbrella = await store.createTask({
      title: "umbrella parent",
      description: "u",
      dependencies: [childA.id, childB.id],
    });

    await expect(store.updateTask(childA.id, { dependencies: [umbrella.id] })).rejects.toBeInstanceOf(DependencyCycleError);

    const rows = (store as any).db
      .prepare(
        "SELECT mutationType, metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ?",
      )
      .all(childA.id, "task:dependency-cycle-rejected") as Array<{
        mutationType: string;
        metadata: string | { source?: string };
      }>;
    expect(rows).toHaveLength(1);
    const metadata = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(metadata.source).toBe("updateTask");
  });

  it("rejects self-loop introduced via update", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });

    let error: unknown;
    try {
      await store.updateTask(a.id, { dependencies: [a.id] });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DependencyCycleError);
    expect(error).toMatchObject({
      name: "DependencyCycleError",
      taskId: a.id,
      cyclePath: [a.id, a.id],
    });
    expect((error as DependencyCycleError).message).toContain(`${a.id} → ${a.id}`);

    const refreshedA = await store.getTask(a.id);
    expect(refreshedA.dependencies).toEqual([]);

    const rows = (store as any).db
      .prepare("SELECT metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ?")
      .all(a.id, "task:dependency-cycle-rejected") as Array<{ metadata: string | { source?: string } }>;
    expect(rows).toHaveLength(1);
    const metadata = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(metadata.source).toBe("updateTask");
  });

  it("rejects createTaskWithReservedId self-loop with typed cycle contract", async () => {
    const store = harness.store();

    let error: unknown;
    try {
      await store.createTaskWithReservedId(
        { title: "self", description: "self", dependencies: ["FN-SELF-1"] },
        { taskId: "FN-SELF-1" },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DependencyCycleError);
    expect(error).toMatchObject({
      taskId: "FN-SELF-1",
      cyclePath: ["FN-SELF-1", "FN-SELF-1"],
    });

    const rows = (store as any).db
      .prepare("SELECT metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ?")
      .all("FN-SELF-1", "task:dependency-cycle-rejected") as Array<{ metadata: string | { source?: string } }>;
    expect(rows).toHaveLength(1);
    const metadata = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(metadata.source).toBe("createTaskWithReservedId");

    await expect(store.getTask("FN-SELF-1")).rejects.toThrow("Task FN-SELF-1 not found");
  });

  it("prioritizes self-edge cycle path when mixed with other dependencies", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });

    await expect(store.updateTask(a.id, { dependencies: [a.id, "FN-NONEXISTENT"] })).rejects.toMatchObject({
      taskId: a.id,
      cyclePath: [a.id, a.id],
    });
  });

  it("rejects incremental update that closes a loop and preserves state", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B", dependencies: [a.id] });
    const c = await store.createTask({ title: "C", description: "C", dependencies: [b.id] });

    await expect(store.updateTask(a.id, { dependencies: [c.id] })).rejects.toMatchObject({
      cyclePath: [a.id, c.id, b.id, a.id],
    });

    const refreshedA = await store.getTask(a.id);
    expect(refreshedA.dependencies).toEqual([]);

    const rows = (store as any).db
      .prepare("SELECT metadata FROM runAuditEvents WHERE taskId = ? AND mutationType = ?")
      .all(a.id, "task:dependency-cycle-rejected") as Array<{ metadata: string | { source?: string } }>;
    expect(rows).toHaveLength(1);
    const metadata = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(metadata.source).toBe("updateTask");
  });

  it("moveTask transitions do not mutate dependencies or emit cycle rejection", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B", dependencies: [a.id] });

    const beforeRows = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM runAuditEvents WHERE domain = ? AND mutationType = ?")
      .get("database", "task:dependency-cycle-rejected") as { count: number };

    await store.moveTask(b.id, "todo");
    await store.moveTask(b.id, "in-progress");
    await store.moveTask(a.id, "todo");
    await store.moveTask(a.id, "in-progress");
    await store.moveTask(a.id, "done");

    const movedA = await store.getTask(a.id);
    const movedB = await store.getTask(b.id);
    expect(movedA.dependencies).toEqual([]);
    expect(movedB.dependencies).toEqual([a.id]);

    const afterRows = (store as any).db
      .prepare("SELECT COUNT(*) as count FROM runAuditEvents WHERE domain = ? AND mutationType = ?")
      .get("database", "task:dependency-cycle-rejected") as { count: number };
    expect(afterRows.count).toBe(beforeRows.count);

    await expect(store.updateTask(a.id, { dependencies: [b.id] })).rejects.toBeInstanceOf(DependencyCycleError);
  });

  it("DependencyCycleError includes IDs and arrow-rendered path", () => {
    const error = new DependencyCycleError("FN-A", ["FN-A", "FN-B", "FN-A"]);

    expect(error.name).toBe("DependencyCycleError");
    expect(error).toBeInstanceOf(Error);
    expect(error.taskId).toBe("FN-A");
    expect(error.cyclePath).toEqual(["FN-A", "FN-B", "FN-A"]);
    expect(error.message).toContain("FN-A");
    expect(error.message).toContain("FN-B");
    expect(error.message).toContain("FN-A → FN-B → FN-A");
  });

  it("accepts non-cyclic updates", async () => {
    const store = harness.store();
    const a = await store.createTask({ title: "A", description: "A" });
    const b = await store.createTask({ title: "B", description: "B" });

    const updated = await store.updateTask(b.id, { dependencies: [a.id] });
    expect(updated.dependencies).toEqual([a.id]);
  });
});
