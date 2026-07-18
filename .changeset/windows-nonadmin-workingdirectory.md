---
"@runfusion/fusion": patch
---

summary: Fix elevated Windows desktop boot failing with "The directory name is invalid" when starting embedded PostgreSQL.
category: fix
dev: "Start-Process -Credential (CreateProcessWithLogonW) validates the working directory as the target non-admin user; the launcher inherited the desktop app's cwd (admin profile / install dir) which fusion-pg cannot access. launch.ps1 now pins -WorkingDirectory to the granted .pgrunner run dir, passed as a -File param (buildNonAdminLauncherPs1 in packages/core embedded-windows-admin.ts)."
