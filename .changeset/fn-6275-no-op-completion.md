---
"@runfusion/fusion": minor
---

Add a verified no-op/duplicate task completion path so executors can close already-satisfied tasks without fabricating commits by using an audited `fn_task_done` sentinel summary.
