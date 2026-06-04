import type { Settings, TaskDetail, WorkflowIr, WorkflowIrEdge, WorkflowIrNode } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR, WorkflowIrError, isExperimentalFeatureEnabled } from "@fusion/core";

import {
  createDefaultNodeHandlers,
  createNoopLegacySeams,
  type WorkflowCustomNodeRunner,
  type WorkflowLegacySeams,
} from "./workflow-node-handlers.js";
import {
  runSplitJoin,
  type BranchEnvironment,
  type WorkflowBranchPersistence,
  type WorkflowBranchProgress,
  type WorkflowBranchRunState,
  type WorkflowBranchSemaphore,
} from "./workflow-graph-branches.js";

export type WorkflowNodeOutcome = "success" | "failure";

export interface WorkflowNodeResult {
  outcome: WorkflowNodeOutcome;
  value?: string;
  contextPatch?: Record<string, unknown>;
}

export interface WorkflowNodeExecutionContext {
  task: TaskDetail;
  settings: Pick<Settings, "experimentalFeatures"> | undefined;
  context: Record<string, unknown>;
  /** Set during concurrent branch execution; fail-fast aborts via this signal.
   *  Undefined on the sequential path (zero behavior change for linear graphs). */
  signal?: AbortSignal;
}

export type WorkflowNodeHandler = (node: WorkflowIrNode, context: WorkflowNodeExecutionContext) => Promise<WorkflowNodeResult>;

export interface WorkflowGraphExecutorDeps {
  handlers?: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;
  seams?: WorkflowLegacySeams;
  /** Executes custom (non-seam) prompt/script/gate nodes. */
  runCustomNode?: WorkflowCustomNodeRunner;
  maxRetriesPerNode?: number;
  /** Per-branch run-state persistence (U13). Optional — fully in-memory without it. */
  branchPersistence?: WorkflowBranchPersistence;
  /** Bounds concurrent branch-node execution. Omit when the semaphore is
   *  enforced beneath runCustomNode (the session layer) to avoid double-acquire. */
  branchSemaphore?: WorkflowBranchSemaphore;
  /** Live per-branch progress (dashboard badges). */
  onBranchProgress?: (progress: WorkflowBranchProgress) => void;
  /** Stable identifier for this run, used to key persisted branch state. */
  runId?: string;
}

export interface WorkflowGraphExecutorResult {
  executed: boolean;
  outcome: WorkflowNodeOutcome;
  context: Record<string, unknown>;
  visitedNodeIds: string[];
}

const TERMINAL_FAILURE: WorkflowGraphExecutorResult = {
  executed: false,
  outcome: "failure",
  context: {},
  visitedNodeIds: [],
};

export class WorkflowGraphExecutor {
  private readonly maxRetriesPerNode: number;

  private readonly handlers: Partial<Record<WorkflowIrNode["kind"], WorkflowNodeHandler>>;

  public constructor(private readonly deps: WorkflowGraphExecutorDeps) {
    this.maxRetriesPerNode = Math.max(1, Math.floor(deps.maxRetriesPerNode ?? 2));
    this.handlers = {
      ...createDefaultNodeHandlers(deps.seams ?? createNoopLegacySeams(), deps.runCustomNode),
      ...(deps.handlers ?? {}),
    };
  }

  public async run(
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    ir: WorkflowIr = BUILTIN_CODING_WORKFLOW_IR,
  ): Promise<WorkflowGraphExecutorResult> {
    if (!isExperimentalFeatureEnabled(settings, "workflowGraphExecutor")) {
      return TERMINAL_FAILURE;
    }

    const startNode = ir.nodes.find((node) => node.kind === "start");
    if (!startNode) throw new WorkflowIrError("Workflow IR missing start node");

    const nodeMap = new Map(ir.nodes.map((node) => [node.id, node]));
    const outgoingMap = new Map<string, WorkflowIrEdge[]>();
    for (const edge of ir.edges) {
      if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) {
        throw new WorkflowIrError(`Workflow IR edge references unknown node: ${edge.from} -> ${edge.to}`);
      }
      const list = outgoingMap.get(edge.from) ?? [];
      list.push(edge);
      outgoingMap.set(edge.from, list);
    }

    const context: Record<string, unknown> = {};
    const visitedNodeIds: string[] = [];
    const inStack = new Set<string>();
    const runId = this.deps.runId ?? `${task.id}:run`;

    // On resume, completed branch nodes (from a prior crashed run) are skipped
    // so their handlers do not re-fire (idempotency).
    let completedNodeIds: Set<string> | undefined;
    const persisted = await this.deps.branchPersistence?.loadBranchStates?.(task.id, runId);
    if (persisted && persisted.length > 0) {
      completedNodeIds = new Set(
        persisted
          .filter((s: WorkflowBranchRunState) => s.status === "completed")
          .map((s) => s.currentNodeId),
      );
    }

    // Prune prior-run branch rows on run start (#1412). Done after the resume
    // load so this run's own (taskId, runId) rows survive while every stale run
    // is removed. Never throws into the run.
    await this.pruneStaleBranches(task.id, runId);

    // Shared branch environment: built lazily so the sequential path pays nothing.
    const branchEnv = (): BranchEnvironment => ({
      task,
      settings,
      runId,
      nodeMap,
      outgoingMap,
      runBranchNode: (node, signal) => this.executeNodeWithRetries(node, task, settings, context, signal),
      shouldTraverseEdge: (edge, source) => this.shouldTraverseEdge(edge, source),
      persistence: this.deps.branchPersistence,
      semaphore: this.deps.branchSemaphore,
      onBranchProgress: this.deps.onBranchProgress,
      completedNodeIds,
    });

    const walk = async (nodeId: string): Promise<WorkflowNodeResult> => {
      const node = nodeMap.get(nodeId);
      if (!node) throw new WorkflowIrError(`Unknown workflow node: ${nodeId}`);
      if (inStack.has(nodeId)) throw new WorkflowIrError(`Cycle detected at node: ${nodeId}`);
      inStack.add(nodeId);
      visitedNodeIds.push(nodeId);

      try {
        if (node.kind === "start") {
          return await traverseChildren(node, { outcome: "success" });
        }
        if (node.kind === "end") {
          return { outcome: "success" };
        }

        if (node.kind === "split") {
          // Concurrent fan-out: branches run in parallel up to their join, which
          // synchronizes per its config. The card stays in the split's column for
          // the whole window (no handler-driven move happens in here). Execution
          // then continues sequentially from the join node.
          const splitResult = await runSplitJoin(node, branchEnv());
          visitedNodeIds.push(...splitResult.visitedNodeIds);
          context[`node:${node.id}:outcome`] = splitResult.outcome;
          context[`node:${splitResult.joinNodeId}:outcome`] = splitResult.outcome;
          context[`node:${splitResult.joinNodeId}:branchOutcomes`] = splitResult.branchOutcomes;
          if (!inStack.has(splitResult.joinNodeId)) visitedNodeIds.push(splitResult.joinNodeId);
          return await traverseChildren(
            nodeMap.get(splitResult.joinNodeId)!,
            { outcome: splitResult.outcome },
          );
        }

        const result = await this.executeNodeWithRetries(node, task, settings, context);
        if (result.contextPatch) Object.assign(context, result.contextPatch);
        context[`node:${node.id}:outcome`] = result.outcome;
        if (result.value !== undefined) context[`node:${node.id}:value`] = result.value;

        return await traverseChildren(node, result);
      } finally {
        inStack.delete(nodeId);
      }
    };

    const traverseChildren = async (node: WorkflowIrNode, sourceResult: WorkflowNodeResult): Promise<WorkflowNodeResult> => {
      const edges = outgoingMap.get(node.id) ?? [];
      if (edges.length === 0) {
        return sourceResult;
      }

      const matching = edges.filter((edge) => this.shouldTraverseEdge(edge, sourceResult));
      if (matching.length === 0) {
        return sourceResult;
      }

      let aggregate: WorkflowNodeResult = sourceResult;
      for (const edge of matching.sort((a, b) => a.to.localeCompare(b.to))) {
        const target = nodeMap.get(edge.to);
        if (target?.kind === "end") {
          aggregate = sourceResult;
          continue;
        }
        const child = await walk(edge.to);
        if (child.outcome === "failure") {
          aggregate = child;
          break;
        }
        aggregate = child;
      }
      return aggregate;
    };

    const terminal = await walk(startNode.id);
    // Prune again on run completion (#1412): keeps only this run's rows so the
    // table does not accumulate historical runs for a long-lived task.
    await this.pruneStaleBranches(task.id, runId);
    return {
      executed: true,
      outcome: terminal.outcome,
      context,
      visitedNodeIds,
    };
  }

  /** Best-effort prune of stale-run branch rows; never throws into the run. */
  private async pruneStaleBranches(taskId: string, keepRunId: string): Promise<void> {
    try {
      await this.deps.branchPersistence?.clearStaleBranchStates?.(taskId, keepRunId);
    } catch {
      // Pruning is additive bookkeeping — a failure must not affect the run.
    }
  }

  private shouldTraverseEdge(edge: WorkflowIrEdge, sourceResult: WorkflowNodeResult): boolean {
    if (!edge.condition) return sourceResult.outcome === "success";
    if (edge.condition === "success") return sourceResult.outcome === "success";
    if (edge.condition === "failure") return sourceResult.outcome === "failure";
    if (edge.condition.startsWith("outcome:")) {
      return sourceResult.value === edge.condition.slice("outcome:".length);
    }
    throw new WorkflowIrError(`Unsupported edge condition: ${edge.condition}`);
  }

  private async executeNodeWithRetries(
    node: WorkflowIrNode,
    task: TaskDetail,
    settings: Pick<Settings, "experimentalFeatures"> | undefined,
    context: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowNodeResult> {
    const handler = this.handlers[node.kind];
    if (!handler) {
      throw new WorkflowIrError(`No handler registered for node kind: ${node.kind}`);
    }

    // Per-node override: config.maxRetries beats the executor-wide default.
    const configured = Number(node.config?.maxRetries);
    const maxAttempts = Number.isFinite(configured) && configured >= 1
      ? Math.min(10, Math.floor(configured))
      : this.maxRetriesPerNode;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Fail-fast cancellation: a branch aborted mid-retry stops re-trying.
      if (signal?.aborted) return { outcome: "failure", value: "aborted" };
      try {
        return await handler(node, { task, settings, context, signal });
      } catch (error) {
        lastError = error;
      }
    }

    return {
      outcome: "failure",
      value: "exception",
      contextPatch: {
        [`node:${node.id}:error`]: lastError instanceof Error ? lastError.message : String(lastError),
      },
    };
  }
}
