---
"@runfusion/fusion": minor
---

Workspace mode Phase C (U1): per-repo merge loop. Extract `landOneRepo` from the
`runAiMerge` clean-room land closure (single-repo behavior unchanged) and add
`landWorkspaceTask`, which lands each acquired sub-repo's `fusion/<id>` branch onto
that repo's OWN local integration ref (re-resolved per repo with overrides stripped),
land-as-you-go with no remote push. The engine merge dispatch and the user-facing
CLI/dashboard merge doors now route workspace tasks through this loop instead of
throwing; `store.mergeTask`, `aiMergeTask`, and the `runAiMerge` chokepoint keep
throwing `WorkspaceTaskMergeError` as defense-in-depth.
