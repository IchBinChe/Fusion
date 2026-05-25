import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendAutoWidenedScopeToPrompt, evaluateScopeAutoWiden, ScopeAutoWidenPersistError } from "../merger-scope-auto-widen.js";

describe("merger-scope-auto-widen", () => {
  const roots: string[] = [];

  async function makeRoot() {
    const root = await mkdtemp(join(tmpdir(), "fn-5226-"));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("widens a clean own-attributed candidate", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn(),
    } as any;
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("not ignored"))
      .mockResolvedValueOnce({ stdout: "sha1\x00feat(FN-5226): update\x00\x1e" });

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: ["packages/engine/src/merger.ts"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([{
      file: "packages/engine/src/merger.ts",
      attribution: "subject-prefix",
      commits: ["sha1"],
    }]);
    expect(result.refused).toEqual([]);
  });

  it("refuses on foreign-attributed commits", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn(),
    } as any;
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("not ignored"))
      .mockResolvedValueOnce({ stdout: "sha1\x00feat(FN-9999): foreign\x00\x1e" })
      .mockRejectedValueOnce(new Error("not ignored"))
      .mockResolvedValueOnce({ stdout: "sha2\x00no token\x00\x1e" });

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: ["foreign.ts", "none.ts"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([
      { file: "foreign.ts", reason: "foreign-commit" },
      { file: "none.ts", reason: "foreign-commit" },
    ]);
  });

  it("refuses when git log has no branch-side attribution evidence", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn(),
    } as any;
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("not ignored"))
      .mockResolvedValueOnce({ stdout: "" });

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: ["no-log.ts"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: "no-log.ts", reason: "no-attribution" }]);
  });

  it("refuses .fusion and gitignored paths", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn(),
    } as any;
    const exec = vi.fn().mockResolvedValue({ stdout: "" });

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: [".fusion/tasks/FN-1/notes.txt", "ignored.log"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([
      { file: ".fusion/tasks/FN-1/notes.txt", reason: "ignored-path" },
      { file: "ignored.log", reason: "ignored-path" },
    ]);
  });

  it("refuses when another active task claims the path (including glob scopes) and ignores done/archived tasks", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([
        { id: "FN-100", column: "in-progress", deletedAt: null },
        { id: "FN-101", column: "done", deletedAt: null },
        { id: "FN-102", column: "archived", deletedAt: null },
      ]),
      parseFileScopeFromPrompt: vi.fn(async (taskId: string) => {
        if (taskId === "FN-100") return ["claimed.ts", "packages/engine/src/**/*.ts"];
        return ["other.ts"];
      }),
    } as any;
    const exec = vi.fn().mockRejectedValue(new Error("not ignored"));

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: ["packages/engine/src/utils/foo.ts"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([]);
    expect(result.refused).toEqual([{ file: "packages/engine/src/utils/foo.ts", reason: "claimed-by-other-task" }]);
  });

  it("appends scope markers idempotently and parseFileScopeFromPrompt round-trips", async () => {
    const root = await makeRoot();
    const taskId = "FN-5226";
    const taskDir = join(root, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), `# Prompt\n\n## File Scope\n\n<!-- scopeOverride manual -->\n- \`packages/engine/src/merger.ts\`\n\n## Steps\n- one\n`, "utf-8");

    const fakeStore = { getTaskDir: (id: string) => join(root, ".fusion", "tasks", id) } as any;
    const addedFirst = await appendAutoWidenedScopeToPrompt({ store: fakeStore, taskId, files: ["AGENTS.md", "packages/engine/src/merger.ts"] });
    const addedSecond = await appendAutoWidenedScopeToPrompt({ store: fakeStore, taskId, files: ["AGENTS.md"] });

    expect(addedFirst).toEqual(["AGENTS.md"]);
    expect(addedSecond).toEqual([]);

    const prompt = await readFile(join(taskDir, "PROMPT.md"), "utf-8");
    expect(prompt).toContain("<!-- scopeOverride manual -->");
    expect(prompt).toContain("- `AGENTS.md` <!-- scopeAutoWiden FN-5226 -->");
    expect(prompt.match(/scopeAutoWiden FN-5226/g)?.length ?? 0).toBe(1);

    const store = new TaskStore(root, join(root, ".fusion-global-settings"), { inMemoryDb: true });
    const parsed = await store.parseFileScopeFromPrompt(taskId);
    expect(parsed).toContain("AGENTS.md");
    expect(parsed).toContain("packages/engine/src/merger.ts");
  });

  it("accepts trailer attribution with multi-line commit body", async () => {
    const store = {
      listTasks: vi.fn().mockResolvedValue([]),
      parseFileScopeFromPrompt: vi.fn(),
    } as any;
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("not ignored"))
      .mockResolvedValueOnce({ stdout: "sha3\x00chore: detailed message\x00Body line\n\nFusion-Task-Id: FN-5226\x1e" });

    const result = await evaluateScopeAutoWiden({
      store,
      task: { id: "FN-5226" } as any,
      taskId: "FN-5226",
      rootDir: "/tmp",
      branch: "fusion/fn-5226",
      baseRef: "main",
      candidateFiles: ["multiline.ts"],
      execAsyncImpl: exec as any,
    });

    expect(result.widened).toEqual([{ file: "multiline.ts", attribution: "trailer", commits: ["sha3"] }]);
    expect(result.refused).toEqual([]);
  });

  it("throws when File Scope section is missing", async () => {
    const root = await makeRoot();
    const taskId = "FN-5226";
    const taskDir = join(root, ".fusion", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeFile(join(taskDir, "PROMPT.md"), "# Prompt\n\n## Steps\n- one\n", "utf-8");

    const fakeStore = { getTaskDir: (id: string) => join(root, ".fusion", "tasks", id) } as any;
    await expect(appendAutoWidenedScopeToPrompt({ store: fakeStore, taskId, files: ["AGENTS.md"] })).rejects.toBeInstanceOf(ScopeAutoWidenPersistError);
  });
});
