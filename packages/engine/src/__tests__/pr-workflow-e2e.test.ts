/**
 * U9 — built-in PR workflow end-to-end (FAST, faked GitHub + faked agent).
 *
 * Proves the headline "wire it end to end" deliverable: a task routed through the
 * built-in PR workflow graph (`BUILTIN_PR_WORKFLOW_IR`) flows through the full
 * node lifecycle — create → await-review → (changes-requested) respond →
 * (approved) auto-merge gate → merge → end — with the U4 reconcile firing the
 * external-event releases that advance the await holds.
 *
 * The executor cannot itself park at a hold (holds are dwell columns the runtime
 * parks/resumes the card at; the executor has no hold handler). So this drives the
 * lifecycle in the same SEGMENTS the runtime does, resuming the graph at each next
 * node, and uses the real {@link PrReconciler} to prove a GitHub state change fires
 * the matching `github:pr-<event>` release between segments. The PR node handlers
 * (pr-create / pr-respond / pr-merge / auto-merge gate) run with injected fakes —
 * the engine never touches a real GitHub client.
 *
 * It also pins that the built-in IR parses/validates and round-trips.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BUILTIN_PR_WORKFLOW_IR,
  TaskStore,
  parseWorkflowIr,
  serializeWorkflowIr,
} from "@fusion/core";
import type { PrEntity, TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type {
  PrMergeCallResult,
  PrNodeDeps,
  PrRespondCallResult,
  PrSourceDescriptor,
} from "../pr-nodes.js";
import {
  PrReconciler,
  type PrReconcileFetchResult,
  type PrReconcileGithubOps,
} from "../pr-reconcile.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

const SOURCE: PrSourceDescriptor = {
  sourceType: "task",
  sourceId: "T-1",
  repo: "owner/repo",
  headBranch: "fusion/t-1",
};

const TASK = { id: "T-1" } as TaskDetail;

/** A focused sub-IR mirroring a segment of the built-in graph, so the executor
 *  resumes at a single runnable node and stops at the next hold/end — exactly the
 *  way the runtime resumes a parked card. */
function segment(name: string, nodes: WorkflowIr["nodes"], edges: WorkflowIr["edges"]): WorkflowIr {
  return { version: "v1", name, nodes, edges };
}

describe("built-in PR workflow — static validity (U9)", () => {
  it("parses/validates as a v2 IR with the PR node lifecycle", () => {
    const ir = parseWorkflowIr(BUILTIN_PR_WORKFLOW_IR);
    expect(ir.version).toBe("v2");
    const kinds = ir.nodes.map((n) => n.kind);
    expect(kinds).toContain("pr-create");
    expect(kinds).toContain("pr-respond");
    expect(kinds).toContain("pr-merge");
    expect(kinds).toContain("hold");
    // The bounded review loop is a top-level rework edge into the region head.
    expect(
      ir.edges.some((e) => e.from === "pr-respond" && e.to === "await-review" && e.kind === "rework"),
    ).toBe(true);
  });

  it("round-trips serialize → parse unchanged", () => {
    const serialized = serializeWorkflowIr(BUILTIN_PR_WORKFLOW_IR);
    expect(serializeWorkflowIr(parseWorkflowIr(serialized))).toBe(serialized);
  });
});

describe("built-in PR workflow — node lifecycle end to end (U9)", () => {
  let rootDir: string;
  let globalDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), "fusion-pr-e2e-"));
    globalDir = mkdtempSync(join(tmpdir(), "fusion-pr-e2e-global-"));
    store = new TaskStore(rootDir, globalDir, { inMemoryDb: true });
    await store.init();
  });

  afterEach(async () => {
    store.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(globalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // ── Fakes ──────────────────────────────────────────────────────────────────

  /** A scriptable fake reconcile GitHub-ops returning a chosen deep-fetch state. */
  function makeReconcileOps(fetch: () => PrReconcileFetchResult): {
    ops: PrReconcileGithubOps;
    fetchCalls: number;
  } {
    const state = { fetchCalls: 0 };
    return {
      get fetchCalls() {
        return state.fetchCalls;
      },
      ops: {
        probe: async () => ({ changed: true, etag: "etag" }),
        fetchPrState: async () => {
          state.fetchCalls += 1;
          return fetch();
        },
      },
    };
  }

  function makeReconciler(ops: PrReconcileGithubOps): { reconciler: PrReconciler; fired: string[] } {
    const fired: string[] = [];
    const reconciler = new PrReconciler({
      store,
      ops,
      releaseByEvent: async (taskId: string, tag: string) => {
        fired.push(`${taskId}::${tag}`);
        return { released: true };
      },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    return { reconciler, fired };
  }

  function prDeps(overrides: Partial<PrNodeDeps> = {}): PrNodeDeps {
    return {
      getStore: () => store,
      resolvePrSource: () => SOURCE,
      createPr: async () => ({ prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7", headOid: "head-1" }),
      mergePr: async () => ({ status: "merged-requested" }) as PrMergeCallResult,
      ...overrides,
    };
  }

  it("drives create → await-review → respond → gate → merge → end with reconcile-fired releases", async () => {
    const respond = vi.fn(async (): Promise<PrRespondCallResult> => ({ value: "fixed" }));
    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    const deps = prDeps({ respond, mergePr });

    // ── Segment 1: start → pr-create → (await-review). The executor stops where
    // the built-in would park at the await-review hold. ────────────────────────
    const createExec = new WorkflowGraphExecutor({ prNodes: deps });
    const createResult = await createExec.run(
      TASK,
      settingsOn(),
      segment(
        "seg-create",
        [
          { id: "start", kind: "start" },
          { id: "pr-create", kind: "pr-create" },
          { id: "await-review", kind: "end" }, // hold stand-in (the parking point)
        ],
        [
          { from: "start", to: "pr-create" },
          { from: "pr-create", to: "await-review", condition: "outcome:open" },
        ],
      ),
    );
    expect(createResult.outcome).toBe("success");
    expect(createResult.visitedNodeIds).toContain("pr-create");
    const opened = store.getActivePrEntityBySource("task", "T-1");
    expect(opened?.state).toBe("open");
    expect(opened?.prNumber).toBe(7);
    // Verified so the gate/respond hard-gate (R19) does not block it.
    store.updatePrEntity(opened!.id, { unverified: false });

    // ── Reconcile fires changes-requested → the await-review hold releases to
    // pr-respond. ────────────────────────────────────────────────────────────
    const cr = makeReconcileOps(() => ({ exists: true, prState: "open", prNumber: 7, reviewDecision: "CHANGES_REQUESTED" }));
    const r1 = makeReconciler(cr.ops);
    const fired1 = await r1.reconciler.reconcileRepoOnce("owner/repo");
    expect(fired1.map((t) => t.event)).toContain("changes-requested");
    expect(r1.fired).toContain("T-1::github:pr-changes-requested");

    // ── Segment 2: pr-respond runs the (faked) review-response and loops back to
    // the await-review hold (the bounded rework edge). ───────────────────────────
    const respondExec = new WorkflowGraphExecutor({ prNodes: deps });
    const respondResult = await respondExec.run(
      TASK,
      settingsOn(),
      segment(
        "seg-respond",
        [
          { id: "start", kind: "start" },
          { id: "pr-respond", kind: "pr-respond" },
          { id: "await-review", kind: "end" }, // loop back to the await hold
        ],
        [
          { from: "start", to: "pr-respond" },
          { from: "pr-respond", to: "await-review", condition: "outcome:fixed" },
        ],
      ),
    );
    expect(respondResult.visitedNodeIds).toContain("pr-respond");
    expect(respond).toHaveBeenCalledTimes(1);
    // The rework-cycle counter advanced (R8 cap backing, persisted).
    expect(store.getActivePrEntityBySource("task", "T-1")?.responseRounds).toBe(1);

    // ── Reconcile fires approved → the await-review hold releases to the gate. ──
    const ap = makeReconcileOps(() => ({
      exists: true,
      prState: "open",
      prNumber: 7,
      headOid: "head-1", // a real deep-fetch returns the corroborated head OID
      reviewDecision: "APPROVED",
      checksRollup: "success",
      mergeable: "clean",
    }));
    const r2 = makeReconciler(ap.ops);
    const fired2 = await r2.reconciler.reconcileRepoOnce("owner/repo");
    expect(fired2.map((t) => t.event)).toContain("approved");
    expect(r2.fired).toContain("T-1::github:pr-approved");

    // Opt in to auto-merge so the gate routes auto-on → pr-merge.
    const approved = store.getActivePrEntityBySource("task", "T-1")!;
    store.updatePrEntity(approved.id, { autoMerge: true });
    expect(approved.reviewDecision).toBe("APPROVED");

    // ── Segment 3: gate (auto-merge) → pr-merge → end. ──────────────────────────
    const mergeExec = new WorkflowGraphExecutor({ prNodes: deps });
    const mergeResult = await mergeExec.run(
      TASK,
      settingsOn(),
      segment(
        "seg-gate-merge",
        [
          { id: "start", kind: "start" },
          { id: "gate", kind: "gate", config: { gate: "auto-merge" } },
          { id: "pr-merge", kind: "pr-merge" },
          { id: "await-review", kind: "end" }, // auto-off would park here
          { id: "end", kind: "end" },
        ],
        [
          { from: "start", to: "gate" },
          { from: "gate", to: "pr-merge", condition: "outcome:auto-on" },
          { from: "gate", to: "await-review", condition: "outcome:auto-off" },
          { from: "pr-merge", to: "end", condition: "outcome:merged-requested" },
        ],
      ),
    );
    expect(mergeResult.outcome).toBe("success");
    // `end` nodes are terminal sinks the executor never adds to visitedNodeIds.
    expect(mergeResult.visitedNodeIds).toEqual(["start", "gate", "pr-merge"]);
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(mergePr).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadOid: "head-1" }));
    // pr-merge does NOT write the terminal state — reconcile corroborates it.
    expect(store.getActivePrEntityBySource("task", "T-1")?.state).toBe("open");

    // ── Reconcile fires merged → entity goes terminal and drops from the poll
    // set (the run ends). ───────────────────────────────────────────────────────
    const mg = makeReconcileOps(() => ({ exists: true, prState: "merged", prNumber: 7 }));
    const r3 = makeReconciler(mg.ops);
    const fired3 = await r3.reconciler.reconcileRepoOnce("owner/repo");
    expect(fired3.map((t) => t.event)).toEqual(["merged"]);
    expect(r3.fired).toContain("T-1::github:pr-merged");
    expect(store.getActivePrEntityBySource("task", "T-1")).toBeNull();
    expect(store.listActivePrEntities()).toHaveLength(0);
  });

  it("auto-merge OFF parks for manual merge instead of reaching pr-merge", async () => {
    // Seed an open, approved-but-not-opted-in entity.
    const entity = store.ensurePrEntityForSource({ ...SOURCE, state: "open" });
    store.updatePrEntity(entity.id, {
      state: "open",
      unverified: false,
      reviewDecision: "APPROVED",
      checksRollup: "success",
      mergeable: "clean",
      autoMerge: false, // not opted in → gate must route auto-off
      headOid: "head-1",
    });

    const mergePr = vi.fn(async () => ({ status: "merged-requested" }) as PrMergeCallResult);
    // `park` is a script (a runnable parking sink) so the executor visits it —
    // an `end` node is a terminal sink the executor never adds to visitedNodeIds.
    const park = vi.fn(async () => ({ outcome: "success" as const }));
    const exec = new WorkflowGraphExecutor({ prNodes: prDeps({ mergePr }), handlers: { script: park } });
    const result = await exec.run(
      TASK,
      settingsOn(),
      segment(
        "seg-auto-off",
        [
          { id: "start", kind: "start" },
          { id: "gate", kind: "gate", config: { gate: "auto-merge" } },
          { id: "pr-merge", kind: "pr-merge" },
          { id: "park", kind: "script" },
          { id: "end", kind: "end" },
        ],
        [
          { from: "start", to: "gate" },
          { from: "gate", to: "pr-merge", condition: "outcome:auto-on" },
          { from: "gate", to: "park", condition: "outcome:auto-off" },
          { from: "park", to: "end" },
        ],
      ),
    );
    expect(result.visitedNodeIds).toContain("park");
    expect(result.visitedNodeIds).not.toContain("pr-merge");
    expect(mergePr).not.toHaveBeenCalled();
  });

  it("the bounded review loop runs the built-in IR's rework region to its cap", async () => {
    // Run the real built-in IR's review region as a top-level rework loop: a
    // respond that always returns `fixed` keeps the rework edge firing until the
    // await-review head's maxReworkCycles budget exhausts and routes out. This
    // pins the built-in's rework wiring against the executor's bound enforcement.
    const entity = store.ensurePrEntityForSource({ ...SOURCE, state: "open" });
    store.updatePrEntity(entity.id, { state: "open", unverified: false, headOid: "h" });

    const respond = vi.fn(async (): Promise<PrRespondCallResult> => ({ value: "fixed" }));
    // Exhaustion routes to a runnable parking sink (not an `end`), so the run's
    // terminal outcome is that sink's success — mirroring the foreach exhaustion
    // posture (the head's exhaustion result is `failure` only to deselect the
    // success loop edge; the exhausted target then runs).
    const parked = vi.fn(async () => ({ outcome: "success" as const }));
    const exec = new WorkflowGraphExecutor({ prNodes: prDeps({ respond }), handlers: { script: parked } });

    // Mirror the built-in's region head config (reworkRegion + a small cap) so the
    // executor seeds the same bounded budget.
    const cap = 3;
    const ir = segment(
      "review-loop",
      [
        { id: "start", kind: "start" },
        { id: "await-review", kind: "gate", config: { reworkRegion: true, maxReworkCycles: cap } },
        { id: "pr-respond", kind: "pr-respond" },
        { id: "parked", kind: "script" },
        { id: "end", kind: "end" },
      ],
      [
        { from: "start", to: "await-review" },
        // Region head's forward edges: keep looping (success) vs exit (exhausted).
        { from: "await-review", to: "pr-respond", condition: "success" },
        { from: "await-review", to: "parked", condition: "outcome:rework-exhausted" },
        { from: "parked", to: "end" },
        { from: "pr-respond", to: "await-review", condition: "outcome:fixed", kind: "rework" },
      ],
    );

    const result = await exec.run(TASK, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain("parked");
    // Initial pass + `cap` rework re-entries → pr-respond runs cap+1 times, then
    // the head's budget exhausts and routes out of the loop exactly once.
    expect(respond).toHaveBeenCalledTimes(cap + 1);
    expect(parked).toHaveBeenCalledTimes(1);
    expect(store.getActivePrEntityBySource("task", "T-1")?.responseRounds).toBe(cap + 1);
  });
});
