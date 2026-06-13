---
"@runfusion/fusion": minor
---

Fast-mode triage is now expressed as workflow-declared policy: the lean prompt lives in the built-in `default-triage-fast` agent prompt and `planning-fast` seam, while `leanPlanning` and `autoApproveSpec` are workflow-native settings for prompt selection and spec-review auto-approval.

The internal `FAST_TRIAGE_SYSTEM_PROMPT` engine constant was removed. Existing `executionMode: "fast"` tasks remain byte-equivalent through a single legacy execution-mode-to-resolved-policy bridge.
