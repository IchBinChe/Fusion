import { WorkflowIrError } from "@fusion/core";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import type { WorkflowNodeHandler, WorkflowNodeResult } from "./workflow-graph-executor.js";

export type WorkflowSeamName = "planning" | "execute" | "review" | "merge" | "schedule" | "step-execute";

export interface WorkflowLegacySeams {
  /** Planning/spec stage. Built-in triage runs upstream of the interpreter
   *  today, so the default engine seam is a no-op for already-specified tasks;
   *  custom planning behavior is expressed as a custom prompt node. */
  planning: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  execute: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  review: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  merge: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  schedule: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
  /**
   * Step-inversion (KTD-2/KTD-4, U3): run exactly the foreach-active step inside
   * the task's session/worktree. Only invoked for `step-execute` prompt nodes
   * inside a foreach template, where `context["foreach:active"]` carries the
   * active instance's `stepIndex`. Optional — a workflow that never uses a
   * foreach/step-execute node needs no implementation (the noop seams omit it,
   * and a step-execute node reached without this wired fails cleanly rather than
   * silently no-opping). The engine wires this to `runTaskStep` (executor.ts
   * createGraphSeams); it returns the per-step `baselineSha`/`checkpointId` in
   * its `contextPatch` so a later RETHINK (U5) can reset the step.
   */
  stepExecute?: (task: TaskDetail, context: Record<string, unknown>) => Promise<WorkflowNodeResult>;
}

/** The reserved context key carrying the active foreach instance (KTD-3, U3).
 *  Template node handlers (step-execute now; step-review in U5) read it to learn
 *  which step they operate on and the per-instance baseline/checkpoint state. */
export const FOREACH_ACTIVE_CONTEXT_KEY = "foreach:active";

/** Shape of the value stored under {@link FOREACH_ACTIVE_CONTEXT_KEY}. */
export interface ForeachActiveContext {
  foreachNodeId: string;
  stepIndex: number;
  instanceId: string;
  baselineSha?: string;
  checkpointId?: string;
}

/**
 * Runs a custom (non-seam) prompt/script/gate node for a task — typically by
 * delegating to the WorkflowStep prompt-session/script machinery. Injected so
 * the graph layer stays engine-agnostic and unit-testable with fakes.
 */
export type WorkflowCustomNodeRunner = (
  node: WorkflowIrNode,
  task: TaskDetail,
  context: Record<string, unknown>,
) => Promise<WorkflowNodeResult>;

/** Resolve a node's seam name, or undefined for custom (non-seam) nodes. */
export function resolveSeamName(node: { config?: Record<string, unknown> }): WorkflowSeamName | undefined {
  const seam = node.config?.seam;
  if (seam === undefined) return undefined;
  if (
    seam === "planning" ||
    seam === "execute" ||
    seam === "review" ||
    seam === "merge" ||
    seam === "schedule" ||
    seam === "step-execute"
  ) {
    return seam;
  }
  throw new WorkflowIrError(`Unsupported workflow seam: ${String(seam)}`);
}

/**
 * Prompt/script handler: seam-configured nodes delegate to the legacy seam;
 * custom nodes run through the injected custom-node runner.
 */
export function createPromptLikeHandler(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): WorkflowNodeHandler {
  return async (node, context) => {
    const seam = resolveSeamName(node);
    if (seam === "step-execute") {
      // Step-inversion (U3): step-execute resolves the active foreach instance
      // from the reserved context key and runs exactly that step. The active
      // context is set by the executor's foreach sub-walk on instance entry.
      const active = context.context[FOREACH_ACTIVE_CONTEXT_KEY] as
        | ForeachActiveContext
        | undefined;
      if (!active || typeof active.stepIndex !== "number") {
        throw new WorkflowIrError(
          `step-execute node '${node.id}' reached without an active foreach instance context`,
        );
      }
      if (!seams.stepExecute) {
        // Fail closed: a step-execute node with no seam wired must NOT silently
        // succeed — that would merge a task with no step work done.
        return { outcome: "failure", value: "step-execute-unwired" };
      }
      return seams.stepExecute(context.task, context.context);
    }
    if (seam) {
      return seams[seam]!(context.task, context.context);
    }
    if (!runCustomNode) {
      throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
    }
    return runCustomNode(node, context.task, context.context);
  };
}

/**
 * Gate handler. Two forms:
 * - Context gate (original scaffold contract): `config.expect` compared against
 *   a context key — pure, no execution.
 * - Executable gate: a gate node carrying a prompt/script config runs through
 *   the custom-node runner; its outcome decides whether the gate passes.
 */
export function createGateHandler(runCustomNode?: WorkflowCustomNodeRunner): WorkflowNodeHandler {
  return async (node, context) => {
    const expected = node.config?.expect;
    if (typeof expected === "string") {
      const actual = context.context[String(node.config?.contextKey ?? "outcome")];
      if (actual !== expected) {
        return { outcome: "failure", value: "gate-mismatch" };
      }
      return { outcome: "success" };
    }

    const hasExecutableConfig =
      typeof node.config?.prompt === "string" || typeof node.config?.scriptName === "string";
    if (hasExecutableConfig) {
      // Fail closed: an executable gate with no runner must NOT auto-pass — that
      // would silently bypass the gate and let the workflow continue. Mirror the
      // prompt/script handler, which throws in the same situation.
      if (!runCustomNode) {
        throw new WorkflowIrError(`No custom-node runner registered for node: ${node.id}`);
      }
      return runCustomNode(node, context.task, context.context);
    }

    return { outcome: "success" };
  };
}

/**
 * Placeholder handler for the `step-review` node kind (KTD-4). The real verdict
 * logic (delegating to `reviewStep`, mapping APPROVE/REVISE/RETHINK/UNAVAILABLE
 * to outcome edges, and triggering RETHINK reset on rework traversal) is U5, NOT
 * U3. Until U5 wires it, a step-review node reached during a foreach instance
 * fails cleanly with a documented not-implemented value rather than throwing an
 * unhandled-node-kind error — keeping a foreach with a step-review node from
 * crashing the walk while making the gap explicit and routable.
 */
export const stepReviewNotImplementedHandler: WorkflowNodeHandler = async (node) => ({
  outcome: "failure",
  value: "step-review-not-implemented",
  contextPatch: {
    [`node:${node.id}:error`]: "step-review handler is not implemented until U5",
  },
});

export function createDefaultNodeHandlers(
  seams: WorkflowLegacySeams,
  runCustomNode?: WorkflowCustomNodeRunner,
): Record<"prompt" | "script" | "gate" | "step-review", WorkflowNodeHandler> {
  const promptLike = createPromptLikeHandler(seams, runCustomNode);
  return {
    prompt: promptLike,
    script: promptLike,
    gate: createGateHandler(runCustomNode),
    "step-review": stepReviewNotImplementedHandler,
  };
}

/** Back-compat export: the original context-only gate handler. */
export const gateNodeHandler: WorkflowNodeHandler = createGateHandler();

export function createNoopLegacySeams(): WorkflowLegacySeams {
  const success = async (): Promise<WorkflowNodeResult> => ({ outcome: "success" });
  return {
    planning: success,
    execute: success,
    review: success,
    merge: success,
    schedule: success,
  };
}
