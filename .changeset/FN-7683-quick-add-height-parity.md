---
"@runfusion/fusion": patch
---

summary: Quick Add action-row controls now resolve one identical box height, not just a min-height floor.
category: fix
dev: Upgraded `.quick-entry-actions .btn, .quick-entry-actions .wf-optional-steps-dropdown-trigger` in QuickEntryBox.css from a bare min-height floor to a fixed box height (min-height paired with an equal max-height) plus tokenized line-height and centered alignment, at both the desktop base rule and the <=768px touch-target media block. Follow-up: a mobile-only Save-specific override (no vertical padding, line-height:1) further corrects Save's mobile sizing to match siblings without affecting desktop/tablet.
