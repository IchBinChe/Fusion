---
"@runfusion/fusion": patch
---

Self-heal orphaned `agentRuns` rows left in `status='active'` when the dashboard process crashes mid-heartbeat. The trigger scheduler treats any active run as "still running" and silently skips every subsequent tick, so a single crashed run could leave an agent without heartbeats for hours. SelfHealingManager now reconciles these on startup and during periodic maintenance, terminating runs whose `processPid` does not match the current process or whose age exceeds 6 hours.
