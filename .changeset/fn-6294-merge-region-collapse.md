---
"@runfusion/fusion": patch
---

Fix workflow graph execution for the built-in coding workflow's merge-policy primitive region by collapsing any merge-region entry back to the legacy `merge` seam until the workflow interpreter owns merge policy execution.
