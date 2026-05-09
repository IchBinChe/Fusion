---
"@runfusion/fusion": patch
---

Agent messaging via `fn_send_message` can no longer be deadlocked by an approval policy interposing on it. The messaging primitive now bypasses both the action gate and the permanent-agent gate by reference, so even a misconfigured policy or classification-table regression cannot strand inter-agent coordination, wake-on-message replies, or agent-to-user escalations. No user-visible behavior change for correctly classified deployments.
