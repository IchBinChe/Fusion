---
"@runfusion/fusion": patch
---

summary: Fix push to remote after merge never running; pick the push remote and target branch from dropdowns in settings.
category: fix
dev: The `pushAfterMerge` setting only existed in the soft-deprecated legacy `aiMergeTask` pipeline; `runAiMerge` (the sole merge path since master-plan U0) now runs a post-finalize push step — ref-to-ref fast path, clean-room detached rebase with AI conflict resolution on remote divergence (non-FF local ref CAS advance + merge-advance auto-sync), `push:origin` run-audit events, non-fatal failures. New `GET /api/git/remotes/:name/branches` endpoint backs the settings dropdowns; the `pushRemote` setting string ("origin" / "origin main") is unchanged.
