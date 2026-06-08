---
"@runfusion/fusion": patch
---

Fix mission→goal link write paths to return `400 { code: "GOAL_NOT_FOUND" }` instead of 404 for unknown goals, aligning the API, CLI, and pi tool contract.
