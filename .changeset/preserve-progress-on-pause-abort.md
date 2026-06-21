---
"@runfusion/fusion": patch
---

Preserve task progress when a single-session run is hard-cancelled mid-execution. When the engine aborted in-flight work and bounced the task back to `todo`, the single-session teardown cleared the task `branch` and re-queued without `preserveResumeState` — resetting every step to `pending` and dropping the pointer to commits already on the task branch, so the next dispatch re-planned from Step 0 and the committed work was stranded (observed as a task that "lost all progress" and got stuck). The teardown now keeps the branch and moves with `preserveResumeState` whenever the task has resumable step progress, matching the step-session and pause-park paths, so execution resumes onto the existing branch from the first incomplete step. The worktree is still removed to free its concurrency slot — only the durable pointers (branch + step state) are kept.
