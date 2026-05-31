import { exec } from "node:child_process";
import { promisify } from "node:util";

import type { BranchGroup, MergeTargetResolution, Task, TaskStore } from "@fusion/core";
import { resolveTaskMergeTarget } from "@fusion/core";

const execAsync = promisify(exec);

export interface BranchGroupMergeRouting {
  branchGroup: BranchGroup;
  mergeTarget: MergeTargetResolution;
}

async function ensureGroupBranchExists(rootDir: string, branchName: string, startPoint: string): Promise<void> {
  const quotedBranch = JSON.stringify(`refs/heads/${branchName}`);
  try {
    await execAsync(`git show-ref --verify --quiet ${quotedBranch}`, { cwd: rootDir });
    return;
  } catch {
    await execAsync(`git branch ${JSON.stringify(branchName)} ${JSON.stringify(startPoint)}`, { cwd: rootDir });
  }
}

export async function resolveBranchGroupMergeRouting(input: {
  task: Pick<Task, "branchContext" | "baseBranch">;
  store: Pick<TaskStore, "getBranchGroup">;
  projectDefaultBranch: string;
  rootDir?: string;
}): Promise<BranchGroupMergeRouting | null> {
  if (input.task.branchContext?.assignmentMode !== "shared") {
    return null;
  }

  const groupId = input.task.branchContext.groupId;
  const branchGroup = input.store.getBranchGroup(groupId);
  if (!branchGroup) {
    return null;
  }

  if (input.rootDir) {
    await ensureGroupBranchExists(input.rootDir, branchGroup.branchName, input.projectDefaultBranch);
  }

  return {
    branchGroup,
    mergeTarget: resolveTaskMergeTarget(input.task, {
      projectDefaultBranch: input.projectDefaultBranch,
      branchGroup,
    }),
  };
}
