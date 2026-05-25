import { describe, expect, it } from "vitest";

import { findSameAgentDuplicates } from "../duplicate-intake.js";

describe("findSameAgentDuplicates", () => {
  const nowMs = Date.now();

  it("returns same-agent high-similarity match within window", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck in secrets sync", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck in secrets sync",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });

  it("filters out entries older than 24h", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 25 * 60 * 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters out candidates with no shared caller identity", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: null }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("filters archived candidates via duplicate matcher defaults", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "typecheck error" },
      [{ id: "FN-1", title: "Fix typecheck", description: "typecheck error", column: "archived", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("respects threshold", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix parser", description: "parse errors on sync job" },
      [{ id: "FN-1", title: "Refactor dashboard layout", description: "button spacing and css", column: "todo", createdAt: nowMs - 60 * 1000, sourceAgentId: "agent-x" }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches).toEqual([]);
  });

  it("matches siblings sharing the same parent task even when sourceAgentId differs", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event for lane selection",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event for per-lane provider/runtime selection",
        description: "Emit run-audit event recording per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "different-agent",
        sourceParentTaskId: "FN-5206",
      }],
      { nowMs, sourceAgentId: "calling-agent" },
    );
    expect(matches[0]?.id).toBe("FN-5544");
  });

  it("does not match sibling with different parent task", () => {
    const matches = findSameAgentDuplicates(
      {
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        sourceParentTaskId: "FN-5206",
      },
      [{
        id: "FN-5544",
        title: "Add structured run-audit event",
        description: "Emit a run-audit event for per-lane provider/runtime selection",
        column: "triage",
        createdAt: nowMs - 5 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: "FN-OTHER",
      }],
      { nowMs, sourceAgentId: "agent-y" },
    );
    expect(matches).toEqual([]);
  });

  it("falls back to sourceAgentId match when parent is unset", () => {
    const matches = findSameAgentDuplicates(
      { title: "Fix typecheck", description: "promisify scrypt causes typecheck error" },
      [{
        id: "FN-1",
        title: "Fix typecheck",
        description: "promisify scrypt causes typecheck error",
        column: "todo",
        createdAt: nowMs - 60 * 60 * 1000,
        sourceAgentId: "agent-x",
        sourceParentTaskId: null,
      }],
      { nowMs, sourceAgentId: "agent-x" },
    );
    expect(matches[0]?.id).toBe("FN-1");
  });
});
