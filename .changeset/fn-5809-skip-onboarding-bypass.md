---
"@runfusion/fusion": patch
---

Refine onboarding auto-launch bypass behavior by treating `--skip-onboarding` and `FUSION_SKIP_ONBOARDING` as first-class skip paths.

- Parse `FUSION_SKIP_ONBOARDING` with strict truthiness (`1`, `true`, `yes`, `on` only).
- Return distinct auto-launch skip reasons for flag (`skip-flag`) and env (`skip-env`).
- Strip `--skip-onboarding` as a global CLI flag so it never leaks into downstream command parsers while still informing onboarding gate decisions.
