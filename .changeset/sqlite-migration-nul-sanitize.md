---
"@runfusion/fusion": patch
---

summary: Fix first-boot SQLite→PostgreSQL migration failing on legacy data containing NUL (\u0000) characters.
category: fix
dev: The migrator now strips U+0000 from plain text cells, JSON string values/keys, malformed-JSON scalars, and opaque legacy-preservation cells before insert; content-checksum verification compares sanitized source against sanitized target.
