import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { Task } from "@fusion/core";

function makeTask(id: string, column: Task["column"], updatedAt: string): Task {
  return {
    id,
    title: id,
    description: id,
    column,
    status: "pending",
    priority: "normal",
    createdAt: "2026-05-08T10:00:00.000Z",
    updatedAt,
    currentStep: 0,
    steps: [],
    dependencies: [],
  } as unknown as Task;
}

function createContext(tasks: Task[], apiKey = "secret") {
  return {
    pluginId: "fusion-plugin-even-realities-glasses",
    settings: { apiKey },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    taskStore: {
      listTasks: vi.fn(async () => tasks),
      getTask: vi.fn(async (id: string) => tasks.find((task) => task.id === id)),
    },
  } as never;
}

function route(path: string) {
  return plugin.routes!.find((entry) => entry.path === path)!;
}

describe("board routes", () => {
  it("returns 401 when auth header missing", async () => {
    const response = (await route("/board/cards").handler({ headers: {} }, createContext([]))) as any;
    expect(response.status).toBe(401);
  });

  it("returns 503 when plugin is not configured", async () => {
    const response = (await route("/board/cards").handler({ headers: { authorization: "Bearer secret" } }, createContext([], ""))) as any;
    expect(response.status).toBe(503);
  });

  it("returns deck on happy path", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z"), makeTask("FN-2", "in-progress", "2026-05-08T12:00:00.000Z")];
    const response = (await route("/board/cards").handler({ headers: { authorization: "Bearer secret" } }, createContext(tasks))) as any;
    expect(response.status).toBe(200);
    expect(response.body.deck.cards[0].id).toBe("summary");
    expect(response.body.deck.cards).toHaveLength(3);
  });

  it("returns task deck for known id", async () => {
    const tasks = [makeTask("FN-1", "todo", "2026-05-08T11:00:00.000Z")];
    const response = (await route("/tasks/:id/cards").handler(
      { headers: { authorization: "Bearer secret" }, params: { id: "FN-1" } },
      createContext(tasks),
    )) as any;
    expect(response.status).toBe(200);
    expect(response.body.deck.cards[0].id).toBe("FN-1");
  });
});
