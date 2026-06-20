---
"@runfusion/fusion": patch
---

Raise the minimum agent heartbeat staleness floor from 5 to 10 minutes. Agents go silent during long-running but legitimate work (notably a verification step running a multi-minute test command, where the agent is blocked awaiting the command and cannot tick/heartbeat). The 5-minute floor could misread such a busy agent as dead and reclaim its in-progress task mid-run; 10 minutes gives long operations room before the liveness gate acts.
