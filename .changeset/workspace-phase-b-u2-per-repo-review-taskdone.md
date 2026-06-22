---
"@runfusion/fusion": minor
---

Workspace mode (Phase B, U2): per-repo review at both review entry points plus per-repo `fn_task_done` completion + scope-leak verification. In workspace mode both review call sites (the in-session `fn_review_step` tool and the step-inversion review seam) now loop the single-cwd `reviewStep` once per acquired sub-repo (cwd = each repo's worktree) and aggregate the repo-tagged verdicts as a conjunction — the task is reviewed only when every sub-repo approves, and the first failing sub-repo's verdict (with repo-tagged findings) drives the existing verdict→edge mapping. `fn_task_done` now verifies worktree invariants per acquired repo and iterates the scope-leak guard per sub-repo (cwd = repo worktree, repo `baseCommitSha`), blocking completion on any sub-repo carrying off-scope changes and naming the repo. Adds a minimal shared repo-prefix-derivation helper (`workspace-paths.ts`). Single-repo behavior is unchanged.
