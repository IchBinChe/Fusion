---
"@runfusion/fusion": patch
---

summary: Keep the mobile top header on a single line after a foldable phone is unfolded and refolded.
category: fix
dev: `.header` now pins `flex-wrap: nowrap` explicitly and `.header-left`/`.header-actions` get an explicit `flex`/`min-width: 0` shrink-and-truncate contract promoted to the base rule (not gated to the `@media (max-width: 768px)` block), so the row cannot wrap even while a foldable's CSS layout viewport lags its `visualViewport` pane mid fold/unfold/refold. `useViewportMode` was audited and already recomputes correctly on that resize sequence (regression test added; no hook change needed).
