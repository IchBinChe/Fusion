import { describe, expect, it } from "vitest";
import {
  BUILTIN_WORKFLOW_IR_FIXTURE,
  WORKFLOW_IR_SCHEMA_VERSION,
  parseWorkflowIr,
  serializeWorkflowIr,
  WorkflowIrError,
} from "../index.js";

describe("workflow ir", () => {
  it("round-trips fixture with no data loss", () => {
    const serialized = serializeWorkflowIr(BUILTIN_WORKFLOW_IR_FIXTURE);
    const parsed = parseWorkflowIr(serialized);
    expect(parsed).toEqual(BUILTIN_WORKFLOW_IR_FIXTURE);
  });

  it("rejects missing or mismatched schemaVersion", () => {
    expect(() =>
      parseWorkflowIr({
        metadata: { name: "missing-version" },
        nodes: [],
        edges: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_version" }));

    expect(() =>
      parseWorkflowIr({
        schemaVersion: "2.0.0",
        metadata: { name: "wrong-version" },
        nodes: [],
        edges: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_version" }));
  });

  it("rejects unknown node kinds and dangling edges", () => {
    expect(() =>
      parseWorkflowIr({
        schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
        metadata: { name: "unknown-kind" },
        nodes: [{ id: "n1", kind: "custom" }],
        edges: [],
      }),
    ).toThrowError(WorkflowIrError);

    expect(() =>
      parseWorkflowIr({
        schemaVersion: WORKFLOW_IR_SCHEMA_VERSION,
        metadata: { name: "dangling-edge" },
        nodes: [{ id: "start", kind: "start" }],
        edges: [{ id: "e1", from: "start", to: "missing" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "dangling_edge" }));
  });

  it("parses fixture JSON string for interpreter parity", () => {
    const json = JSON.stringify(BUILTIN_WORKFLOW_IR_FIXTURE);
    const parsed = parseWorkflowIr(json);

    expect(parsed.schemaVersion).toBe(WORKFLOW_IR_SCHEMA_VERSION);
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(1);
    expect(parsed.edges.length).toBeGreaterThanOrEqual(1);
  });

  it("exposes workflow ir surface from package entry", () => {
    expect(typeof parseWorkflowIr).toBe("function");
    expect(typeof serializeWorkflowIr).toBe("function");
    expect(BUILTIN_WORKFLOW_IR_FIXTURE.schemaVersion).toBe(WORKFLOW_IR_SCHEMA_VERSION);
  });
});
