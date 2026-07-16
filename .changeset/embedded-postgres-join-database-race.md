---
"@runfusion/fusion": patch
---

summary: Fix startup failures and a leaked server when two Fusion processes start embedded Postgres at the same time.
category: fix
dev: A lifecycle joining an already-running instance returned a URL before the owner's `ensureDatabase()` had created the database, so the joiner's first connect failed. Both join paths now verify the database on the joined instance's port (never `getPort()`, which prefers this instance's requested port) and create it if absent. Verification is best-effort so an unreachable/stale-pid join still resolves optimistically as before. `CREATE DATABASE` races tolerate both `42P04` and `23505` on `pg_database_datname_index`. The startup-race join now fires only on a lock-collision error — joining on any failure let a start that took the lock and then failed later join its own postmaster with `ownsProcess=false`, orphaning it — and reaps its own losing wrapper via the new `NonAdminServerHandle.stopWrapperOnly()`, since `stop()`/`pg.stop()` resolve through the shared data dir and would kill the winner.
