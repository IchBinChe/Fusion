---
"@runfusion/fusion": patch
---

summary: Fix the standalone `fn` binary failing to boot in both embedded-Postgres and DATABASE_URL modes.
category: fix
dev: Migrations now resolve via FUSION_MIGRATIONS_DIR > module-relative > execPath-relative; embedded-postgres ships as a self-contained bundle + native payload under runtime/<platform>/embedded-postgres (override root with FUSION_EMBEDDED_PG_RUNTIME_DIR); releases add self-contained fn-cli-<platform>.tar.gz assets.
