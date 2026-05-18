---
"@runfusion/fusion": patch
---

Wire the redesigned Create-PR modal into the task detail modal and the merge/review tab so
PrPanel's Create button and a new review-tab Create-PR action open the same flow. Fixes the
FN-4758 follow-up where PrPanel was mounted with `onRequestCreatePr={undefined}`.
