---
"@runfusion/fusion": patch
---

summary: Fix the Create PR dialog spinner, diff preview default, and stray-click dismissal behavior.
category: fix
dev: PrCreateModal keeps the FloatingWindow no-backdrop-dismiss path, defaults the diff/commit <details> closed, and time-bounds generatePrMetadata with PR_METADATA_TIMEOUT_MS so hangs use the existing error/manual-body fallback.
