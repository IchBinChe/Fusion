import { describe, expect, it } from "vitest";
import {
  classifyPermanentAgentToolCall,
  resolvePermanentAgentToolDecision,
} from "../permanent-agent-gating.js";

describe("permanent-agent-gating", () => {
  it("classifies builtin coding tools", () => {
    expect(classifyPermanentAgentToolCall("write").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("edit").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("read").category).toBe("none");
    expect(classifyPermanentAgentToolCall("grep").category).toBe("none");
    expect(classifyPermanentAgentToolCall("bash", { command: "echo hi" }).category).toBe("command_execution");
    expect(classifyPermanentAgentToolCall("bash", { command: "git commit -m test" }).category).toBe("git_write");
  });

  it("classifies shared fn tools by behavior", () => {
    expect(classifyPermanentAgentToolCall("fn_task_create").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_delegate_task").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_update_agent_config").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_update_identity").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_task_document_write").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("fn_memory_append").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("fn_research_run").category).toBe("network_api");
    expect(classifyPermanentAgentToolCall("fn_task_show").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_research_get").category).toBe("none");
  });

  it("uses only canonical action-category names", () => {
    const categories = [
      classifyPermanentAgentToolCall("bash", { command: "git commit -m x" }).category,
      classifyPermanentAgentToolCall("write").category,
      classifyPermanentAgentToolCall("bash", { command: "echo hi" }).category,
      classifyPermanentAgentToolCall("fn_research_run").category,
      classifyPermanentAgentToolCall("fn_task_create").category,
      classifyPermanentAgentToolCall("read").category,
    ];

    expect(new Set(categories)).toEqual(
      new Set(["git_write", "file_write_delete", "command_execution", "network_api", "task_agent_mutation", "none"]),
    );
  });

  it("uses unknown-tool fallback to approval-required", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "plugin_custom_tool",
      gating: {
        permissionPolicy: {
          presetId: "approval-required",
          rules: { command_execution: "block" },
        },
      },
    });

    expect(decision.category).toBe("none");
    expect(decision.recognized).toBe(false);
    expect(decision.disposition).toBe("require-approval");
  });

  it("resolves disposition from policy for sensitive categories", () => {
    const blockDecision = resolvePermanentAgentToolDecision({
      toolName: "write",
      gating: {
        permissionPolicy: {
          presetId: "locked-down",
          rules: {
            file_write_delete: "block",
          },
        },
      },
    });
    expect(blockDecision.disposition).toBe("block");

    const approvalDecision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_create",
      gating: {
        permissionPolicy: {
          presetId: "approval-required",
          rules: {
            task_agent_mutation: "require-approval",
          },
        },
      },
    });
    expect(approvalDecision.disposition).toBe("require-approval");
  });
});
