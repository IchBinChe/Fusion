---
"@runfusion/fusion": patch
---

Clear the stale `failed` status when a pause/resume abort is reclassified as a benign todo re-queue, so the task no longer surfaces as failed on the board and the deferred failure notification is suppressed. Previously a pause-abort parked `status:"failed"` on an earlier non-todo observation stayed dispatchable (the scheduler filters on column+paused, not status), re-entered the benign-todo branch, and was logged benign while the row stayed failed — firing a contradictory failure alert during global pause when self-healing recovery was suppressed.
