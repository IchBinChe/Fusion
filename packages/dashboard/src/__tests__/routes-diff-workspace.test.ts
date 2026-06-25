/*
FNXC:Workspace 2026-06-25-00:40:
A workspace (multi-repo) task has no singular `worktree`/`branch` — its changes live in per-sub-repo
worktrees recorded in `task.workspaceWorktrees`. `/tasks/:id/diff` and `/tasks/:id/file-diffs` must
aggregate each sub-repo's diff (computed in that sub-repo's worktree) and prefix every file path with
the sub-repo key, instead of diffing the non-git workspace root (which returns empty).

We mock runGitCommand (keyed by cwd so each sub-repo returns its own files) and node:fs/promises
access (so the sub-repo worktrees "exist") — no real/slow git.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";

const runGitCommandMock = vi.fn<(...args: any[]) => Promise<string>>();

vi.mock("../routes/resolve-diff-base.js", () => ({
  // Per-repo base: the route passes the sub-repo's captured baseCommitSha through.
  resolveDiffBase: vi.fn(async (task: any) => task.baseCommitSha),
  runGitCommand: (...args: any[]) => runGitCommandMock(...args),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, access: vi.fn(async () => undefined) };
});

import { createServer } from "../server.js";

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();
  getRootDir(): string { return "/ws-root"; }
  getFusionDir(): string { return "/ws-root/.fusion"; }
  getDatabase() {
    return { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }) };
  }
  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]), createMission: vi.fn(), getMission: vi.fn(), updateMission: vi.fn(), deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]), createTemplate: vi.fn(), getTemplate: vi.fn(), updateTemplate: vi.fn(), deleteTemplate: vi.fn(), instantiateMission: vi.fn(),
    };
  }
  async listTasks(): Promise<Task[]> { return Array.from(this.tasks.values()); }
  getTask(id: string): Task | undefined { return this.tasks.get(id); }
  addTask(task: Task): void { this.tasks.set(task.id, task); }
  async getTaskCommitAssociationsByLineageId(): Promise<[]> { return []; }
}

function workspaceTask(): Task {
  return {
    id: "MULT-002", title: "ws task", description: "", column: "in-review",
    dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-06-24T00:00:00.000Z", updatedAt: "2026-06-24T00:00:00.000Z",
    worktree: undefined, branch: undefined,
    workspaceWorktrees: {
      // Intentionally non-alphabetical insertion to prove sorted, deterministic output.
      swarmclaw: { worktreePath: "/wt/swarmclaw", branch: "fusion/mult-002", baseCommitSha: "baseS" },
      openvide: { worktreePath: "/wt/openvide", branch: "fusion/mult-002", baseCommitSha: "baseO" },
    },
  } as Task;
}

// Per-cwd git responses. Anything not listed throws — restrictActiveCommittedFilesToOwnTask's
// attribution probes hit that and are swallowed (display-only), preserving the broad diff.
const RESPONSES: Record<string, Record<string, string>> = {
  "/wt/openvide": {
    "diff --name-status -M baseO..HEAD": "A\tsrc/a.ts",
    "diff --cached --name-status -M": "",
    "diff --name-status -M": "",
    "diff baseO -- src/a.ts": "+a\n+aa\n",
  },
  "/wt/swarmclaw": {
    "diff --name-status -M baseS..HEAD": "M\tlib/b.ts",
    "diff --cached --name-status -M": "",
    "diff --name-status -M": "",
    "diff baseS -- lib/b.ts": "+b\n-old\n",
  },
};

describe("workspace task diff aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGitCommandMock.mockImplementation(async (gitArgs: string[], cwd?: string) => {
      const repo = (cwd && RESPONSES[cwd]) || {};
      const key = gitArgs.join(" ");
      if (key in repo) return repo[key] ?? "";
      throw new Error(`Unexpected git command [${cwd}]: ${key}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("/diff aggregates per-sub-repo files with repo-prefixed paths and summed stats", async () => {
    const store = new MockStore();
    store.addTask(workspaceTask());
    const app = createServer(store as any);

    const { get } = await import("../test-request.js");
    const res = await get(app, "/api/tasks/MULT-002/diff");

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.path)).toEqual(["openvide/src/a.ts", "swarmclaw/lib/b.ts"]);
    expect(res.body.files.find((f: any) => f.path === "openvide/src/a.ts").status).toBe("added");
    expect(res.body.stats).toEqual({ filesChanged: 2, additions: 3, deletions: 1 });
  });

  it("preserves deterministic repo-sorted order across the concurrent (parallelized) aggregation", async () => {
    // FNXC:WorkspaceDiff 2026-06-25-09:40: sub-repos are now diffed concurrently; the output must
    // still be sorted by repo key regardless of which sub-repo's git calls finish first. Three repos
    // inserted out of order, with the first-sorted repo deliberately given the slowest git response.
    const task = workspaceTask();
    (task as any).workspaceWorktrees = {
      zulu: { worktreePath: "/wt/zulu", branch: "fusion/mult-002", baseCommitSha: "baseZ" },
      alpha: { worktreePath: "/wt/alpha", branch: "fusion/mult-002", baseCommitSha: "baseA" },
      mike: { worktreePath: "/wt/mike", branch: "fusion/mult-002", baseCommitSha: "baseM" },
    };
    const resp: Record<string, Record<string, string>> = {
      "/wt/alpha": { "diff --name-status -M baseA..HEAD": "A\ta.ts", "diff --cached --name-status -M": "", "diff --name-status -M": "", "diff baseA -- a.ts": "+x\n" },
      "/wt/mike": { "diff --name-status -M baseM..HEAD": "A\tm.ts", "diff --cached --name-status -M": "", "diff --name-status -M": "", "diff baseM -- m.ts": "+y\n" },
      "/wt/zulu": { "diff --name-status -M baseZ..HEAD": "A\tz.ts", "diff --cached --name-status -M": "", "diff --name-status -M": "", "diff baseZ -- z.ts": "+w\n" },
    };
    runGitCommandMock.mockImplementation(async (gitArgs: string[], cwd?: string) => {
      const key = gitArgs.join(" ");
      const repo = (cwd && resp[cwd]) || {};
      if (key in repo) {
        // Make the first-sorted repo (alpha) resolve LAST to prove order is by key, not completion.
        if (cwd === "/wt/alpha") await new Promise((r) => setTimeout(r, 5));
        return repo[key] ?? "";
      }
      throw new Error(`Unexpected git command [${cwd}]: ${key}`);
    });

    const store = new MockStore();
    store.addTask(task);
    const app = createServer(store as any);
    const { get } = await import("../test-request.js");
    const res = await get(app, "/api/tasks/MULT-002/diff");

    expect(res.status).toBe(200);
    expect(res.body.files.map((f: any) => f.path)).toEqual(["alpha/a.ts", "mike/m.ts", "zulu/z.ts"]);
  });

  it("/file-diffs returns repo-prefixed per-file patches", async () => {
    const store = new MockStore();
    store.addTask(workspaceTask());
    const app = createServer(store as any);

    const { get } = await import("../test-request.js");
    const res = await get(app, "/api/tasks/MULT-002/file-diffs");

    expect(res.status).toBe(200);
    expect(res.body.map((f: any) => f.path)).toEqual(["openvide/src/a.ts", "swarmclaw/lib/b.ts"]);
    expect(res.body.find((f: any) => f.path === "swarmclaw/lib/b.ts").diff).toContain("-old");
  });
});
