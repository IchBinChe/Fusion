---
"@runfusion/fusion": patch
---

Fix a daemon startup ordering regression by deferring the peer-exchange global-settings read until after the primary task store is created, resolving `TS2448`/`TS2454` typecheck failures in `packages/cli/src/commands/daemon.ts`.
