---
"@runfusion/fusion": minor
---

Add a new New Task branch strategy option, **Merge into a shared feature branch** (`shared-group`).

When selected, task creation now joins an existing open branch group by shared branch name (or creates a `new-task` sourced group when missing), links `branchContext` with `assignmentMode: "shared"`, and derives a per-task working branch from the shared branch instead of running directly on the shared integration branch.
