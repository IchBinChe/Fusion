import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentStore, CheckoutConflictError, TaskStore, createCentralDatabase, type CentralDatabase } from "@fusion/core";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fn-cross-node-claim-test-"));
}

describe("cross-node claim mutex integration", () => {
  let rootDir: string;
  let globalDir: string;
  let taskStore: TaskStore;
  let centralDb: CentralDatabase;
  let storeA: AgentStore;
  let storeB: AgentStore;
  let agentA: string;
  let agentB: string;
  let taskId: string;

  beforeEach(async () => {
    rootDir = makeTmpDir();
    globalDir = join(rootDir, ".fusion-global");
    taskStore = new TaskStore(rootDir, globalDir);
    await taskStore.init();
    centralDb = createCentralDatabase(globalDir);
    centralDb.init();

    storeA = new AgentStore({ rootDir, taskStore, claimStore: centralDb, projectId: "P-1", nodeId: "node-a" });
    storeB = new AgentStore({ rootDir, taskStore, claimStore: centralDb, projectId: "P-1", nodeId: "node-b" });
    await storeA.init();
    await storeB.init();

    agentA = (await storeA.createAgent({ name: "agent-a", role: "executor" })).id;
    agentB = (await storeB.createAgent({ name: "agent-b", role: "executor" })).id;
    taskId = (await taskStore.createTask({ description: "cross-node claim race" })).id;
  });

  afterEach(async () => {
    storeA?.close();
    storeB?.close();
    taskStore?.close();
    centralDb?.close();
    await rm(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("allows one winner per race and bumps epoch once per successful ownership acquisition", async () => {
    const originalTryClaim = centralDb.tryClaimTask.bind(centralDb);
    const installBarrier = () => {
      let waiters = 0;
      let releaseBarrier: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      centralDb.tryClaimTask = ((input) => {
        waiters += 1;
        if (waiters === 2) {
          releaseBarrier?.();
        }
        return barrier.then(() => originalTryClaim(input));
      }) as CentralDatabase["tryClaimTask"];
    };

    installBarrier();
    const [first, second] = await Promise.allSettled([
      storeA.checkoutTask(agentA, taskId, { runId: "run-a" }),
      storeB.checkoutTask(agentB, taskId, { runId: "run-b" }),
    ]);

    const fulfilled = [first, second].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected = [first, second].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(CheckoutConflictError);

    const winner = fulfilled[0].value;
    expect(rejected[0].reason.currentHolderId).toBe(winner.checkedOutBy);
    expect(centralDb.getTaskClaim("P-1", taskId)?.leaseEpoch).toBe(1);
    expect(winner.checkoutLeaseEpoch).toBe(1);
    expect(["node-a", "node-b"]).toContain(winner.checkoutNodeId);

    await (winner.checkedOutBy === agentA ? storeA : storeB).releaseTask(winner.checkedOutBy ?? "", taskId);

    installBarrier();
    const [third, fourth] = await Promise.allSettled([
      storeA.checkoutTask(agentA, taskId, { runId: "run-c" }),
      storeB.checkoutTask(agentB, taskId, { runId: "run-d" }),
    ]);

    const fulfilled2 = [third, fourth].filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<AgentStore["checkoutTask"]>>> => entry.status === "fulfilled");
    const rejected2 = [third, fourth].filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");

    expect(fulfilled2).toHaveLength(1);
    expect(rejected2).toHaveLength(1);
    expect(rejected2[0].reason).toBeInstanceOf(CheckoutConflictError);
    expect(centralDb.getTaskClaim("P-1", taskId)?.leaseEpoch).toBe(1);
  });
});
