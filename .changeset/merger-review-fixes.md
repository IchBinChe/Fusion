---
"@runfusion/fusion": patch
---

Address code-review findings on the merger autostash work:

- `parsePorcelainZ` now correctly handles rename/copy entries (`R` / `C` status), which emit two NUL-separated entries for one logical change. Previously the old name was treated as an independent dirty path, causing `runObservedDestructiveSyncOp` to emit spurious "cleared N path(s)" warnings whenever a rename was in flight.
- The race-rescue loop in `stashUnrelatedRootDirChanges` now runs `git reset` between attempts so each `git add -A` starts from a clean index, preventing iteration-2+ stashes from drifting due to stale staging rather than genuine new writes.
- `writeActiveMergerStatus` now writes the advisory file via temp-path + atomic `renameSync` so dashboard readers can't observe a partial write.
- `deriveDeterministicSubjectSummary`'s Step regex switched from `[—\-:]` to `(?:—|-|:)` — same matches, but the em-dash intent is obvious to anyone auditing.
