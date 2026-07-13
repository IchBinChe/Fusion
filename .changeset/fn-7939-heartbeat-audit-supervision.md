---
"@runfusion/fusion": patch
---

summary: Fix agents silently going stale for hours even though the heartbeat repair audit was running.
category: fix
dev: HeartbeatTriggerScheduler now supervises its own audit setInterval (a stalled/dropped audit driver is re-armed within a bounded window) and bounds/escalates non-advancing zombie-timer re-arms instead of churning silently, closing the ~62,348s silent-heartbeat window that survived the FN-7645/FN-7718 fixes (FN-7939).
