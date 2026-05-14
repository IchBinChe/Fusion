---
"@runfusion/fusion": patch
---

Remove `agentMemoryInclusionMode` from `ProjectSettings` and make memory inclusion mode global-only by default resolution (`agent.runtimeConfig.agentMemoryInclusionMode` → `GlobalSettings.agentMemoryInclusionMode` → default).

Per-agent `runtimeConfig.agentMemoryInclusionMode` override behavior is unchanged, and `GlobalSettings.agentMemoryInclusionMode` remains the default source when no agent override is set.

If you previously set `agentMemoryInclusionMode` in project `.fusion/config.json`, move that setting to global `~/.fusion/settings.json`; project-level values are now ignored.

Also tighten heartbeat memory-mode transition log fallback to use `taskId ?? "heartbeat"`.
