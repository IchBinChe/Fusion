---
"@runfusion/fusion": patch
---

summary: Preserve migrated workflow settings when project identity is assigned later.
category: fix
dev: Backfills rootDir-keyed workflow_settings rows into the durable project identity row, keeping identity values on conflicts.
