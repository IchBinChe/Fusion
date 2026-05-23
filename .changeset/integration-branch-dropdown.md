---
"@fusion/dashboard": patch
---

feat(dashboard): Integration branch setting is now a dropdown of local branches with Custom… fallback

Replaces the plain text input with a `<select>` that lists the project's local branches (loaded via `fetchGitBranches` when the Merge section becomes visible) plus an `(auto-detect — origin/HEAD → main)` default and a `Custom…` option for branches that don't exist locally yet.

Branch list is deduplicated and sorted with common integration names (`main`, `master`, `trunk`, `develop`) pinned to the top so the typical case is one click. Choosing `Custom…` swaps in a text input with a `Use dropdown` link to revert.

A previously-saved value that isn't in the loaded list (e.g. branch deleted locally, or initial load before branches fetch resolved) falls through to the custom text input automatically so the operator can still see and edit it.
