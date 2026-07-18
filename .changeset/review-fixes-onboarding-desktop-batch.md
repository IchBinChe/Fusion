---
"@runfusion/fusion": patch
---

summary: Hardening pass over the onboarding, git-preflight, and Windows Postgres lifecycle features from this cycle's review.
category: fix
dev: "Uninstaller kills only the first (numeric) postmaster.pid line; git-missing dialogs render even with skip-confirmations (new ConfirmOptions.alwaysAsk); quit prompt only for embedded-local runtimes and skipped during OS session end; 'leave it running' now disarms the embedded lifecycle's process shutdown hook (detachKeepingEmbedded); wizard double-submit guard; clone route ENOENT invalidate-and-retry; openExternalUrl drops the always-popup-blocked async window.open fallback; DirectoryPicker closes the panel if listing the created folder fails; git status probe bounded to two spawns."
