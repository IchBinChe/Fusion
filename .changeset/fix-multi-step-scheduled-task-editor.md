---
"@gsxdsm/fusion": patch
---

Fix Add Command Step and Add AI Prompt Step buttons in scheduled task editor

- Added client-side validation for multi-step schedules to ensure all steps have required content before submission
- ScheduleStepsEditor now exposes editing state via `onEditingChange` callback for parent form validation
- Form validation prevents submission when steps are incomplete or being edited
- Added specific error messages for incomplete steps (e.g., "Step 1: Command is required")
- Added integration tests for multi-step flow
