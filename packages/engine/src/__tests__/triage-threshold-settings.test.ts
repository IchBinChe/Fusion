import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  renderTriagePolicyPlaceholders,
  resolveEffectiveSettingsById,
  resolvePlanningPromptFromIr,
  TaskStore,
} from "@fusion/core";

const cleanupDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length) {
    rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

function builtinPlanningPrompt(): string {
  const prompt = resolvePlanningPromptFromIr(BUILTIN_CODING_WORKFLOW_IR);
  if (!prompt) throw new Error("builtin:coding planning prompt missing");
  return prompt;
}

describe("triage threshold workflow settings", () => {
  it("renders behavior-equivalent defaults into the built-in planning prompt", () => {
    const rendered = renderTriagePolicyPlaceholders(builtinPlanningPrompt(), {});

    expect(rendered).toContain("MORE THAN 7 implementation steps");
    expect(rendered).toContain("MORE THAN 3 different packages/modules");
    expect(rendered).toContain("9 or more");
    expect(rendered).toContain("12 or more");
    expect(rendered).toContain("20 or more entries");
    expect(rendered).toContain("at or above 30 items");
    expect(rendered).toContain("S (<2h), M (2-4h), L (4-8h). Split if XL (8h+)");
    expect(rendered).toContain("Decide, Evaluate, Verify, Confirm, Audit, Review whether, Investigate and report");
    expect(rendered).toContain("Keep the project default workflow (`builtin:coding`)");
    expect(rendered).toContain("unless the user explicitly requested a specific workflow");
    expect(rendered).toContain("or you created that task yourself");
    expect(rendered).toContain("When you create a task via `fn_task_create`");
    expect(rendered).toContain("do not move a task you did not create unless the user asked");
    expect(rendered).toContain("Do NOT call `fn_workflow_select` or pass `workflow_id`");
    expect(rendered).toContain("set `**No commits expected:** true` in the PROMPT.md header");
    expect(rendered).not.toContain("prefer `builtin:quick-fix`");
    expect(rendered).not.toContain("{{");
  });

  it("reflects stored workflow overrides in effective settings and rendered prompt", async () => {
    const rootDir = makeTempDir("fn-6233-triage-root-");
    const globalDir = makeTempDir("fn-6233-triage-global-");
    const store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
    try {
      const projectId = store.getWorkflowSettingsProjectId();
      await store.updateWorkflowSettingValues("builtin:coding", projectId, { triageSubtaskStepThreshold: 3 });

      const effective = await resolveEffectiveSettingsById(store, "builtin:coding", projectId);
      expect(effective.triageSubtaskStepThreshold).toBe(3);

      const rendered = renderTriagePolicyPlaceholders(builtinPlanningPrompt(), effective);
      expect(rendered).toContain("MORE THAN 3 implementation steps");
      expect(rendered).not.toContain("MORE THAN 7 implementation steps");
      expect(rendered).not.toContain("{{");
    } finally {
      store.close();
    }
  });

  it("keeps migrated threshold numbers out of the triage prompt assembly code path", async () => {
    const source = await readFile(new URL("../triage.ts", import.meta.url), "utf8");
    const promptAssembly = source.slice(
      source.indexOf("const workflowPlanningPrompt"),
      source.indexOf("const triageSystemPromptFinal"),
    );

    expect(promptAssembly).toContain("renderTriagePolicyPlaceholders");
    expect(promptAssembly).not.toMatch(/\b(?:7|9|12|20|30)\b/);
    expect(promptAssembly).not.toMatch(/builtin:quick-fix|builtin:coding/);
    expect(promptAssembly).not.toMatch(/Decide|Evaluate|Verify|Confirm|Audit|Review whether|Investigate and report/);
  });
});
