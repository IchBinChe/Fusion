// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type Goal } from "@fusion/core";
import { createMissionRouter } from "../mission-routes.js";
import { get, request } from "../test-request.js";

async function createFixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "kb-mission-goal-links-"));
  const globalDir = join(rootDir, ".fusion-global-settings");
  const store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
  await store.init();

  const app = express();
  app.use(express.json());
  app.use("/api/missions", createMissionRouter(store));

  return { app, store, rootDir };
}

async function createArchivedGoal(store: TaskStore, title = "Archived Goal") {
  const created = store.getGoalStore().createGoal({ title });
  return store.getGoalStore().archiveGoal(created.id);
}

describe("mission goal linkage routes", () => {
  let rootDir: string;
  let app: express.Express;
  let store: TaskStore;

  beforeEach(async () => {
    ({ app, store, rootDir } = await createFixture());
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("lists empty and populated linked goals", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });

    const empty = await get(app, `/api/missions/${mission.id}/goals`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ goals: [] });

    store.getMissionStore().linkGoal(mission.id, goalA.id);
    store.getMissionStore().linkGoal(mission.id, goalB.id);

    const populated = await get(app, `/api/missions/${mission.id}/goals`);
    expect(populated.status).toBe(200);
    expect((populated.body as { goals: Goal[] }).goals.map((goal) => goal.id)).toEqual([goalA.id, goalB.id]);
  });

  it("creates a mission with linked goalIds and dedupes duplicates", async () => {
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });

    const response = await request(
      app,
      "POST",
      "/api/missions",
      JSON.stringify({ title: "Ship mission", goalIds: [goalA.id, goalB.id, goalB.id] }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect((response.body as { linkedGoals: Goal[] }).linkedGoals.map((goal) => goal.id)).toEqual([goalA.id, goalB.id]);
    const missionId = (response.body as { id: string }).id;
    expect(store.getMissionStore().listGoalIdsForMission(missionId)).toEqual([goalA.id, goalB.id]);
  });

  it("rejects archived and unknown goalIds on mission create", async () => {
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });
    const archivedGoal = await createArchivedGoal(store);

    const archivedResponse = await request(
      app,
      "POST",
      "/api/missions",
      JSON.stringify({ title: "Ship mission", goalIds: [goal.id, archivedGoal.id] }),
      { "content-type": "application/json" },
    );

    expect(archivedResponse.status).toBe(400);
    expect(archivedResponse.body).toMatchObject({
      details: { code: "GOAL_ARCHIVED", goalId: archivedGoal.id },
    });
    const archivedMissionId = (archivedResponse.body as { id?: string }).id;
    if (archivedMissionId) {
      expect(store.getMissionStore().listGoalIdsForMission(archivedMissionId)).toEqual([]);
    }

    const missingResponse = await request(
      app,
      "POST",
      "/api/missions",
      JSON.stringify({ title: "Ship another mission", goalIds: [goal.id, "G-404"] }),
      { "content-type": "application/json" },
    );

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });
  });

  it("replaces linked goals via patch, clears with [], and ignores undefined goalIds", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });
    const goalC = store.getGoalStore().createGoal({ title: "Goal C" });
    store.getMissionStore().linkGoal(mission.id, goalA.id);

    const replaceResponse = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ goalIds: [goalB.id, goalC.id, goalC.id] }),
      { "content-type": "application/json" },
    );

    expect(replaceResponse.status).toBe(200);
    expect((replaceResponse.body as { linkedGoals: Goal[] }).linkedGoals.map((goal) => goal.id)).toEqual([goalB.id, goalC.id]);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);

    const unchangedResponse = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ title: "Renamed mission" }),
      { "content-type": "application/json" },
    );
    expect(unchangedResponse.status).toBe(200);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);

    const clearResponse = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ goalIds: [] }),
      { "content-type": "application/json" },
    );
    expect(clearResponse.status).toBe(200);
    expect(clearResponse.body).toMatchObject({ linkedGoals: [] });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([]);
  });

  it("rejects archived and unknown goalIds on patch before mutating links", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });
    const archivedGoal = await createArchivedGoal(store);
    store.getMissionStore().linkGoal(mission.id, goalA.id);

    const archivedResponse = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ title: "Updated title", goalIds: [goalB.id, archivedGoal.id] }),
      { "content-type": "application/json" },
    );
    expect(archivedResponse.status).toBe(400);
    expect(archivedResponse.body).toMatchObject({
      details: { code: "GOAL_ARCHIVED", goalId: archivedGoal.id },
    });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalA.id]);
    expect(store.getMissionStore().getMission(mission.id)?.title).toBe("Ship mission");

    const missingResponse = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ goalIds: [goalB.id, "G-404"] }),
      { "content-type": "application/json" },
    );
    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalA.id]);
  });

  it("sets the full linked goal set via put and rejects invalid states atomically", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goalA = store.getGoalStore().createGoal({ title: "Goal A" });
    const goalB = store.getGoalStore().createGoal({ title: "Goal B" });
    const goalC = store.getGoalStore().createGoal({ title: "Goal C" });
    const archivedGoal = await createArchivedGoal(store);
    store.getMissionStore().linkGoal(mission.id, goalA.id);
    store.getMissionStore().linkGoal(mission.id, goalB.id);

    const response = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goalB.id, goalC.id, goalC.id] }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect((response.body as { goals: Goal[] }).goals.map((goal) => goal.id)).toEqual([goalB.id, goalC.id]);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);

    const archivedResponse = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goalA.id, archivedGoal.id] }),
      { "content-type": "application/json" },
    );
    expect(archivedResponse.status).toBe(400);
    expect(archivedResponse.body).toMatchObject({
      details: { code: "GOAL_ARCHIVED", goalId: archivedGoal.id },
    });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);

    const missingResponse = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goalA.id, "G-404"] }),
      { "content-type": "application/json" },
    );
    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goalB.id, goalC.id]);
  });

  it("adds a linked goal idempotently and rejects archived or missing goals", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });
    const archivedGoal = await createArchivedGoal(store);

    const first = await request(app, "POST", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(first.status).toBe(200);
    expect((first.body as { goals: Goal[] }).goals.map((entry) => entry.id)).toEqual([goal.id]);

    const second = await request(app, "POST", `/api/missions/${mission.id}/goals/${goal.id}`);
    expect(second.status).toBe(200);
    expect((second.body as { goals: Goal[] }).goals.map((entry) => entry.id)).toEqual([goal.id]);
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goal.id]);

    const archivedResponse = await request(app, "POST", `/api/missions/${mission.id}/goals/${archivedGoal.id}`);
    expect(archivedResponse.status).toBe(400);
    expect(archivedResponse.body).toMatchObject({
      details: { code: "GOAL_ARCHIVED", goalId: archivedGoal.id },
    });
    expect(store.getMissionStore().listGoalIdsForMission(mission.id)).toEqual([goal.id]);

    const missingResponse = await request(app, "POST", `/api/missions/${mission.id}/goals/G-404`);
    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });
  });

  it("removes a linked archived goal idempotently", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });
    store.getMissionStore().linkGoal(mission.id, goal.id);
    const archivedGoal = store.getGoalStore().archiveGoal(goal.id);

    const first = await request(app, "DELETE", `/api/missions/${mission.id}/goals/${archivedGoal.id}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ removed: true, goals: [] });

    const second = await request(app, "DELETE", `/api/missions/${mission.id}/goals/${archivedGoal.id}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ removed: true, goals: [] });
  });

  it("returns 400 for malformed goal ids", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });

    const listBad = await get(app, `/api/missions/not-a-mission/goals`);
    expect(listBad.status).toBe(400);

    const setBad = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: ["bad-goal-id"] }),
      { "content-type": "application/json" },
    );
    expect(setBad.status).toBe(400);

    const patchBad = await request(
      app,
      "PATCH",
      `/api/missions/${mission.id}`,
      JSON.stringify({ goalIds: ["bad-goal-id"] }),
      { "content-type": "application/json" },
    );
    expect(patchBad.status).toBe(400);

    const createBad = await request(
      app,
      "POST",
      "/api/missions",
      JSON.stringify({ title: "Ship mission", goalIds: ["bad-goal-id"] }),
      { "content-type": "application/json" },
    );
    expect(createBad.status).toBe(400);

    const addBad = await request(app, "POST", `/api/missions/${mission.id}/goals/not-a-goal`);
    expect(addBad.status).toBe(400);

    const deleteBad = await request(app, "DELETE", `/api/missions/${mission.id}/goals/not-a-goal`);
    expect(deleteBad.status).toBe(400);
  });

  it("returns 404 for missing missions and unlinking unknown goals", async () => {
    const mission = store.getMissionStore().createMission({ title: "Ship mission" });
    const goal = store.getGoalStore().createGoal({ title: "Goal A" });

    const missingMissionList = await get(app, "/api/missions/M-404/goals");
    expect(missingMissionList.status).toBe(404);

    const missingMissionAdd = await request(app, "POST", `/api/missions/M-404/goals/${goal.id}`);
    expect(missingMissionAdd.status).toBe(404);

    const missingMissionPatch = await request(
      app,
      "PATCH",
      "/api/missions/M-404",
      JSON.stringify({ goalIds: [goal.id] }),
      { "content-type": "application/json" },
    );
    expect(missingMissionPatch.status).toBe(404);

    const missingGoalAdd = await request(app, "POST", `/api/missions/${mission.id}/goals/G-404`);
    expect(missingGoalAdd.status).toBe(400);
    expect(missingGoalAdd.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });

    const missingGoalSet = await request(
      app,
      "PUT",
      `/api/missions/${mission.id}/goals`,
      JSON.stringify({ goalIds: [goal.id, "G-404"] }),
      { "content-type": "application/json" },
    );
    expect(missingGoalSet.status).toBe(400);
    expect(missingGoalSet.body).toMatchObject({
      details: { code: "GOAL_NOT_FOUND", goalId: "G-404" },
    });

    const missingGoalDelete = await request(app, "DELETE", `/api/missions/${mission.id}/goals/G-404`);
    expect(missingGoalDelete.status).toBe(404);
  });
});
