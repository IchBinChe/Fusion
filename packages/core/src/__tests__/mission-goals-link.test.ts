import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { GoalStore } from "../goal-store.js";
import { MissionStore } from "../mission-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kb-mission-goals-test-"));
}

describe("MissionStore mission-goal linkage", () => {
  let tmpDir: string;
  let fusionDir: string;
  let db: Database;
  let missionStore: MissionStore;
  let goalStore: GoalStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fusionDir = join(tmpDir, ".fusion");
    db = new Database(fusionDir, { inMemory: true });
    db.init();
    missionStore = new MissionStore(fusionDir, db);
    goalStore = new GoalStore(fusionDir, db);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("links a mission to a goal and persists the row", () => {
    const mission = missionStore.createMission({ title: "Mission Alpha" });
    const goal = goalStore.createGoal({ title: "Goal Alpha" });
    const onLinked = vi.fn();
    missionStore.on("mission:goal-linked", onLinked);

    const link = missionStore.linkGoal(mission.id, goal.id);

    expect(link).toMatchObject({ missionId: mission.id, goalId: goal.id });
    expect(link.createdAt).toBeTruthy();
    expect(missionStore.listGoalIdsForMission(mission.id)).toEqual([goal.id]);
    expect(missionStore.listMissionIdsForGoal(goal.id)).toEqual([mission.id]);
    expect(onLinked).toHaveBeenCalledTimes(1);
    expect(onLinked).toHaveBeenCalledWith(link);

    const row = db
      .prepare("SELECT missionId, goalId, createdAt FROM mission_goals WHERE missionId = ? AND goalId = ?")
      .get(mission.id, goal.id) as { missionId: string; goalId: string; createdAt: string } | undefined;
    expect(row).toEqual(link);
  });

  it("re-linking the same mission and goal is idempotent", () => {
    const mission = missionStore.createMission({ title: "Mission Alpha" });
    const goal = goalStore.createGoal({ title: "Goal Alpha" });
    const onLinked = vi.fn();
    missionStore.on("mission:goal-linked", onLinked);

    const first = missionStore.linkGoal(mission.id, goal.id);
    const second = missionStore.linkGoal(mission.id, goal.id);

    expect(second).toEqual(first);
    expect(onLinked).toHaveBeenCalledTimes(1);
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM mission_goals WHERE missionId = ? AND goalId = ?")
      .get(mission.id, goal.id) as { count: number };
    expect(countRow.count).toBe(1);
  });

  it("unlinks mission-goal pairs and reports whether a row changed", () => {
    const mission = missionStore.createMission({ title: "Mission Alpha" });
    const goal = goalStore.createGoal({ title: "Goal Alpha" });
    missionStore.linkGoal(mission.id, goal.id);
    const onUnlinked = vi.fn();
    missionStore.on("mission:goal-unlinked", onUnlinked);

    expect(missionStore.unlinkGoal(mission.id, goal.id)).toBe(true);
    expect(missionStore.unlinkGoal(mission.id, goal.id)).toBe(false);
    expect(missionStore.listGoalIdsForMission(mission.id)).toEqual([]);
    expect(missionStore.listMissionIdsForGoal(goal.id)).toEqual([]);
    expect(onUnlinked).toHaveBeenCalledTimes(1);
  });

  it("lists mission and goal ids in deterministic createdAt order", () => {
    const missionA = missionStore.createMission({ title: "Mission A" });
    const missionB = missionStore.createMission({ title: "Mission B" });
    const goalA = goalStore.createGoal({ title: "Goal A" });
    const goalB = goalStore.createGoal({ title: "Goal B" });

    db.prepare("INSERT INTO mission_goals (missionId, goalId, createdAt) VALUES (?, ?, ?)")
      .run(missionA.id, goalA.id, "2026-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO mission_goals (missionId, goalId, createdAt) VALUES (?, ?, ?)")
      .run(missionA.id, goalB.id, "2026-01-02T00:00:00.000Z");
    db.prepare("INSERT INTO mission_goals (missionId, goalId, createdAt) VALUES (?, ?, ?)")
      .run(missionB.id, goalA.id, "2026-01-03T00:00:00.000Z");

    expect(missionStore.listGoalIdsForMission(missionA.id)).toEqual([goalA.id, goalB.id]);
    expect(missionStore.listGoalIdsForMission(missionB.id)).toEqual([goalA.id]);
    expect(missionStore.listGoalIdsForMission("M-NONE")).toEqual([]);
    expect(missionStore.listMissionIdsForGoal(goalA.id)).toEqual([missionA.id, missionB.id]);
    expect(missionStore.listMissionIdsForGoal(goalB.id)).toEqual([missionA.id]);
    expect(missionStore.listMissionIdsForGoal("G-NONE")).toEqual([]);
  });

  it("throws when linking an unknown mission or goal", () => {
    const mission = missionStore.createMission({ title: "Mission Alpha" });
    const goal = goalStore.createGoal({ title: "Goal Alpha" });

    expect(() => missionStore.linkGoal("M-UNKNOWN", goal.id)).toThrow("Mission M-UNKNOWN not found");
    expect(() => missionStore.linkGoal(mission.id, "G-UNKNOWN")).toThrow("Goal G-UNKNOWN not found");
  });

  it("cascades mission_goals rows when a goal or mission is deleted", () => {
    const missionA = missionStore.createMission({ title: "Mission A" });
    const missionB = missionStore.createMission({ title: "Mission B" });
    const goalA = goalStore.createGoal({ title: "Goal A" });
    const goalB = goalStore.createGoal({ title: "Goal B" });

    missionStore.linkGoal(missionA.id, goalA.id);
    missionStore.linkGoal(missionA.id, goalB.id);
    missionStore.linkGoal(missionB.id, goalA.id);

    db.prepare("DELETE FROM goals WHERE id = ?").run(goalA.id);
    expect(missionStore.listGoalIdsForMission(missionA.id)).toEqual([goalB.id]);
    expect(missionStore.listMissionIdsForGoal(goalA.id)).toEqual([]);

    missionStore.deleteMission(missionA.id);
    const remaining = db.prepare("SELECT missionId, goalId FROM mission_goals ORDER BY missionId, goalId").all() as Array<{
      missionId: string;
      goalId: string;
    }>;
    expect(remaining).toEqual([]);
  });
});
