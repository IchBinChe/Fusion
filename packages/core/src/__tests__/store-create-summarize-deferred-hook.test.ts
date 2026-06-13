import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { setCreateFnAgent } from "../ai-engine-loader.js";
import { TaskStore } from "../store.js";
import { setTaskCreatedHook } from "../task-creation-hooks.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore createTask title summarization deferred hook", () => {
  const harness = createTaskStoreTestHarness();
  let store: TaskStore;

  beforeEach(async () => {
    await harness.beforeEach();
    store = harness.store();
  });

  afterEach(async () => {
    setTaskCreatedHook(undefined);
    setCreateFnAgent(undefined);
    await harness.afterEach();
  });

  it("defers the task-created hook until store-managed summarize completes", async () => {
    const longDescription = "a".repeat(201);
    let releasePrompt!: () => void;
    const promptStarted = vi.fn();
    const promptDone = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    setCreateFnAgent(vi.fn(async () => ({
      session: {
        prompt: vi.fn(async () => {
          promptStarted();
          await promptDone;
        }),
        state: { messages: [{ role: "assistant", content: "Deferred Hook Title" }] },
      },
    })));
    const hookSpy = vi.fn();
    setTaskCreatedHook(hookSpy);

    const task = await store.createTask(
      { description: longDescription, summarize: true },
      {
        settings: {
          autoSummarizeTitles: false,
          titleSummarizerProvider: "mock",
          titleSummarizerModelId: "title-model",
        },
      },
    );

    await vi.waitFor(() => expect(promptStarted).toHaveBeenCalled());
    expect(hookSpy).not.toHaveBeenCalled();

    releasePrompt();
    await vi.waitFor(() => {
      expect(hookSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          id: task.id,
          title: "Deferred Hook Title",
        }),
        store,
      );
    });
  });
});
