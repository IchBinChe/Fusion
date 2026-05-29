---
"@runfusion/fusion": minor
---

Add per-mission/planning branch-group data-model foundations in `@fusion/core`.

- Introduce durable `branch_groups` storage with source linkage (`mission`/`planning`), branch metadata, PR state, status, and auto-merge override.
- Add `TaskStore` branch-group APIs: create/get/getBySource/list/update/setTaskBranchGroup.
- Persist `Task.autoMerge` and `Mission.autoMerge` as optional overrides.
- Reuse `Task.branchContext.groupId` for task↔group linkage (no separate `branchGroupId` column).
- Bump project schema version to `94` with migration coverage and schema assertions.
