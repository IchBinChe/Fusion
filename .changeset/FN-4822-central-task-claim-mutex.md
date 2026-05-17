---
"@runfusion/fusion": patch
---

Add central `taskClaims` table (central DB schema v13) and route `AgentStore.checkoutTask` through it when a `CentralClaimStore` is configured, providing the authoritative cross-node task-claim mutex required by FN-4819 §2. Single-node behavior is unchanged when no claim store is wired.
