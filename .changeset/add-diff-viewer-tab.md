---
"@gsxdsm/fusion": minor
---

Add Changes tab to task detail modal showing files modified by the agent and their diffs.

- Track `modifiedFiles` and `baseCommitSha` on tasks during execution
- New API endpoint `GET /tasks/:id/diff` returns file list and patches
- New `TaskChangesTab` component with expandable file diffs
- Changes tab visible for tasks in in-progress, in-review, or done columns
