---
"@runfusion/fusion": patch
---

summary: Stop the false "OAuth token expired" push notification on startup.
category: fix
dev: In ProjectEngine.start, OAuthRefreshScheduler.start() now runs before OAuthExpiryMonitor.start() so the proactive refresh renews a stale-but-refreshable access token before the refresh-blind monitor's first awaited check() reads `expires`. Ordering locked by an invocationCallOrder assertion in project-engine.test.ts.
