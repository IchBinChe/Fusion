import { describe, it, expect, vi } from "vitest";
import {
  FAST_TRIAGE_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
  TriageProcessor,
} from "../triage.js";
import { createTriageDuplicateScenario } from "./fixtures/triage-duplicate-scenario.js";

const { mockReviewStep, mockCreateFnAgent } = vi.hoisted(() => ({
  mockReviewStep: vi.fn(),
  mockCreateFnAgent: vi.fn(),
}));

vi.mock("../reviewer.js", () => ({
  reviewStep: mockReviewStep,
}));

vi.mock("../pi.js", () => ({
  createFnAgent: mockCreateFnAgent,
  describeModel: vi.fn().mockReturnValue("mock-model"),
  promptWithFallback: vi.fn().mockReturnValue("mock-prompt"),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    resolveAgentPrompt: vi.fn().mockReturnValue(null),
  });
});

/**
 * FN-4726 / FN-4734 / FN-4741: triage created repeated duplicate tasks after equivalent
 * work had already landed. FN-4774 fixed this by (1) exposing fn_task_search in triage,
 * (2) guiding TRIAGE_SYSTEM_PROMPT to search done/archived before creating, and
 * (3) preserving that guidance in FAST_TRIAGE_SYSTEM_PROMPT. FN-4815 pins this contract.
 */
describe("FN-4815 triage duplicate-search regression", () => {
  it("toolset contract: createTriageTools includes fn_task_search", () => {
    const scenario = createTriageDuplicateScenario();
    const store = scenario.buildMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");

    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    expect(tools.map((tool: any) => tool.name)).toContain("fn_task_search");
  });

  it("standard prompt guidance keeps duplicate-search instructions", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("Duplicate check");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("fn_task_search");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("including done and archived tasks");
    expect(/Duplicate check[\s\S]{0,700}(done|archived)/i.test(TRIAGE_SYSTEM_PROMPT)).toBe(true);
  });

  it("fast prompt guidance keeps duplicate-search instructions", () => {
    expect(FAST_TRIAGE_SYSTEM_PROMPT).toContain("Duplicate check");
    expect(FAST_TRIAGE_SYSTEM_PROMPT).toContain("fn_task_search");
    expect(FAST_TRIAGE_SYSTEM_PROMPT).toContain("For any likely match in `done` or `archived`");
    expect(/Duplicate check[\s\S]{0,700}(done|archived)/i.test(FAST_TRIAGE_SYSTEM_PROMPT)).toBe(true);
  });

  it("end-to-end duplicate discovery via fixture shows done match before create", async () => {
    const scenario = createTriageDuplicateScenario();
    const store = scenario.buildMockStore();
    const processor = new TriageProcessor(store, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });

    const taskSearchTool = tools.find((tool: any) => tool.name === "fn_task_search");
    const result = await taskSearchTool.execute("call-1", {
      query: scenario.searchQuery,
    });
    const output = result.content[0].text;

    expect(store.searchTasks).toHaveBeenCalledWith(scenario.searchQuery, {
      slim: true,
      includeArchived: true,
      limit: 20,
    });
    expect(output).toContain(`${scenario.doneTask.id} (done):`);
    expect(output).toContain("(done)");
  });

  it("FN-4726/FN-4734: recently-merged done task touching register-session-diff-routes.ts surfaces via fn_task_search", async () => {
    const scenario = createTriageDuplicateScenario();
    const store = scenario.buildMockStore();
    const doneTask = {
      ...scenario.doneTask,
      id: "FN-4726",
      title: "Fix done-task diff rebase/cherry-pick truncation in register-session-diff-routes",
      description:
        "Prevents done-task diff truncation during rebase/cherry-pick paths in packages/dashboard/src/routes/register-session-diff-routes.ts with assertions in packages/dashboard/src/__tests__/routes-diff.test.ts.",
      column: "done" as const,
    };
    store.searchTasks = vi.fn().mockResolvedValue([doneTask]);

    const processor = new TriageProcessor(store, "/tmp/root");
    const tools = (processor as any).createTriageTools({
      parentTaskId: "FN-TRIAGE",
      allowTaskCreate: true,
      createdSubtasksRef: { current: [] },
    });
    const taskSearchTool = tools.find((tool: any) => tool.name === "fn_task_search");

    const query = "done-task diff rebase cherry-pick register-session-diff-routes";
    const result = await taskSearchTool.execute("call-4734", {
      query,
      includeDone: true,
      includeArchived: true,
    });
    const output = result.content[0].text;

    expect(store.searchTasks).toHaveBeenCalledWith(query, {
      slim: true,
      includeArchived: true,
      limit: 20,
    });
    expect(output).toContain("FN-4726 (done):");
    expect(output).toContain("(done)");
  });
});
