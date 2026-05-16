import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunAuditEventInput } from "@fusion/core";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedExistsSync,
  setupHappyPathExecSync,
} from "./merger-test-helpers.js";
import * as mergerModule from "../merger.js";

describe("FN-4809 merge-attempt run_audit emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    setupHappyPathExecSync();
    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        state: {},
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      },
    } as any);
  });

  it("emits git merge:start with merge-attempt-1 phase (FN-4809)", async () => {
    const store = createMockStore({ branch: "fusion/FN-050" }) as any;
    const recordRunAuditEvent = vi.fn(async (_input: RunAuditEventInput) => {});
    store.recordRunAuditEvent = recordRunAuditEvent;

    await mergerModule.aiMergeTask(store, "/tmp/root", "FN-050");

    const mergeStartEvent = recordRunAuditEvent.mock.calls
      .map((call) => call[0] as RunAuditEventInput)
      .find((event) =>
        event.domain === "git"
        && event.mutationType === "merge:start"
        && event.taskId === "FN-050"
        && typeof event.metadata?.phase === "string"
        && /^merge-attempt-/.test(event.metadata.phase),
      );

    expect(mergeStartEvent).toBeDefined();
    expect(mergeStartEvent?.metadata).toMatchObject({ phase: "merge-attempt-1" });
  });
});
