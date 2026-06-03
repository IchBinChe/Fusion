---
"@runfusion/fusion": minor
---

Mission validation now AI-validates all mission criteria by lazily ensuring a per-feature managed assertion at runtime and removing the zero-assertion auto-pass path. Milestone acceptance criteria are threaded into validator prompts, and the dashboard now presents mission criteria as AI-validated instead of informational-only.