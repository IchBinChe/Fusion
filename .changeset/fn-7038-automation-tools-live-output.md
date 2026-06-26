---
"@runfusion/fusion": minor
---

summary: Automation AI steps now run with all tools by default, with a per-step tool selector and live run output.
category: feature
dev: Adds AutomationStep.allowedTools + AUTOMATION_SELECTABLE_TOOLS (core); toolsAllowlist on createFnAgent (engine); SSE GET /automations/:id/run/stream and /routines/:id/run/stream (dashboard).
