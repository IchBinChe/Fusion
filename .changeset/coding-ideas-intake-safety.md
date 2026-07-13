---
"@runfusion/fusion": patch
---

summary: Ideas-intake cards no longer auto-process on restart; replan and Retry work from Todo; All-workflows shows every card.
category: fix
dev: Store init now always runs the workflow-aware integrity pass instead of the retired flag-off evacuation (`evacuateCustomColumnsToLegacy` remains toggle-only), with a mis-mapping guard so stale selections are never physically rehomed into auto-triaged lanes; engine replan/stale-spec/fs-validation rebounds resolve `resolveReplanTargetColumn` instead of hardcoding `triage`; `needs-replan` counts as unplanned for hold-release dispatch; triage discovers `needs-replan` todo cards and refinement seed prompts via `isUnplannedSeedPrompt`/`buildRefinementSeedPrompt`; Board's aggregate grouping renders column-orphaned tasks (hidden columns stay hidden) and the FN-7591 refetch also fires on present-but-unrepresentable mappings.
