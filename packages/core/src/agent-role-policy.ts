import type { Agent, Task } from "./types.js";

const IMPLEMENTATION_TASK_COLUMNS: ReadonlySet<Task["column"]> = new Set([
  "triage",
  "todo",
  "in-progress",
  "in-review",
]);

export function isImplementationTask(task: Pick<Task, "column">): boolean {
  return IMPLEMENTATION_TASK_COLUMNS.has(task.column);
}

export function isExecutorRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "executor";
}

export function isEngineerRoleAgent(agent: Pick<Agent, "role">): boolean {
  return agent.role === "engineer";
}

export function canAgentTakeImplementationTaskForExplicitRouting(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
): boolean {
  return !isImplementationTask(task) || isExecutorRoleAgent(agent) || isEngineerRoleAgent(agent);
}

export interface BacklogPickupRoleOptions {
  /** Allow durable engineer-role agents to auto-claim implementation backlog work. Default: false. */
  allowEngineer?: boolean;
}

export function canAgentTakeImplementationTaskForBacklogPickup(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
  options: BacklogPickupRoleOptions = {},
): boolean {
  return !isImplementationTask(task) || isExecutorRoleAgent(agent) || (options.allowEngineer === true && isEngineerRoleAgent(agent));
}

export function canAgentTakeImplementationTask(
  agent: Pick<Agent, "role">,
  task: Pick<Task, "column">,
  options?: BacklogPickupRoleOptions,
): boolean {
  return canAgentTakeImplementationTaskForBacklogPickup(agent, task, options);
}

export function formatRoleMismatchReason(
  agent: Pick<Agent, "id" | "role">,
  task: Pick<Task, "id" | "column">,
): string {
  return `Agent ${agent.id} has role "${agent.role}"; implementation task ${task.id} requires an "executor"-role agent by default, with durable "engineer" supported only for explicit routing. Pass override=true to bypass.`;
}
