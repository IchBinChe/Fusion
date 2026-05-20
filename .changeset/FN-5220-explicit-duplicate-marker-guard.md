---
"@runfusion/fusion": patch
---

Block explicit `DUPLICATE: FN-NNNN` redirect tasks from consuming planning
cycles. The triage planning loop now short-circuits when the generated
PROMPT.md is a one-line duplicate marker (bypassing the `fn_review_spec`
APPROVE gate), a self-healing sweep resolves already-stuck duplicate-marker
tasks in `triage`/`todo`, and the dashboard `POST /api/tasks` route
surfaces a `409 duplicate_candidates` with `reason: "explicit-marker"` when
the description is exactly a duplicate redirect. Layered on top of
FN-4829 / FN-4918 / FN-5152; fails open.
