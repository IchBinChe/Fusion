---
"@runfusion/fusion": minor
---

Wire branch-group-aware merge routing into the merge path. Tasks marked with `branchContext.assignmentMode = "shared"` now merge onto their group's integration branch (`branch_groups.branchName`) in both direct merge and PR-mode base-branch resolution, while ungrouped and `per-task-derived` tasks keep existing default-branch behavior.

This release also adds reliability backstop coverage for grouped vs ungrouped routing and branch-group merge audit telemetry (`merge:branch-group-routed`).
