---
"@runfusion/fusion": patch
---

summary: Fix global settings (including the global concurrency cap) intermittently resetting to defaults.
category: fix
dev: Several production call sites built `new CentralCore(store.getFusionDir())`, pointing the central/global DB at the project's `.fusion/` instead of `~/.fusion/` and spawning stray per-project central DBs seeded with default global settings that shadowed real global state. Added `TaskStore.getGlobalSettingsDir()`, routed the secrets store plus the secrets/proxy/node/secrets-sync/settings-sync dashboard routes through it, and added a `resolveGlobalDir()` guard that throws on a project-local `.fusion/` dir (parent is a git repo) so the regression can't silently recur. Existing stray DBs were operator-quarantined.
