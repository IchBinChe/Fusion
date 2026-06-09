import { describe, expect, it } from "vitest";

import { markSideEffectsStarted, primitiveNodeContext } from "../runtime-primitives.js";

describe("runtime primitives", () => {
  it("creates a workflow primitive context from a run and node", () => {
    const run = {
      runId: "run-1",
      taskId: "FN-1",
      workflowId: "coding",
    };
    const node = {
      id: "execute",
      kind: "prompt" as const,
      column: "in-progress",
      config: { prompt: "implement" },
    };

    const ctx = primitiveNodeContext(run, node, {
      effectivePrincipalId: "agent:builder",
      attempt: 2,
      context: { priorOutcome: "revise" },
    });

    expect(ctx).toEqual({
      run,
      node: {
        node,
        effectivePrincipalId: "agent:builder",
        attempt: 2,
        context: { priorOutcome: "revise" },
      },
    });
  });

  it("marks side effects on an immutable context copy", () => {
    const ctx = primitiveNodeContext(
      {
        runId: "run-1",
        taskId: "FN-1",
        workflowId: "coding",
      },
      { id: "execute", kind: "prompt" as const },
    );

    const marked = markSideEffectsStarted(ctx);

    expect(marked).toEqual({
      ...ctx,
      run: {
        ...ctx.run,
        sideEffectsStarted: true,
      },
    });
    expect(ctx.run.sideEffectsStarted).toBeUndefined();
  });
});
