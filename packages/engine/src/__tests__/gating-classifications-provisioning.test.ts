import { describe, expect, it } from "vitest";
import {
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  PERMANENT_AGENT_TASK_MUTATION_TOOLS,
  TASK_AGENT_MUTATION_TOOLS,
} from "../gating-classifications.js";

describe("gating classifications provisioning split", () => {
  it("keeps provisioning tools out of action-gate set", () => {
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_agent_create")).toBe(false);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_agent_delete")).toBe(false);
  });

  it("retains provisioning tools in permanent/task mutation sets", () => {
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_agent_create")).toBe(true);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_agent_delete")).toBe(true);
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_agent_create")).toBe(true);
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_agent_delete")).toBe(true);
  });
});
