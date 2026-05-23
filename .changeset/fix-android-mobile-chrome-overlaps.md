---
"@runfusion/fusion": patch
---

Mobile (Android Chrome edge-to-edge): the top brand header no longer sits underneath the system status bar — its mobile `padding-top` is now additive (`var(--space-md) + env(safe-area-inset-top)`) instead of `max(...)`, so the row keeps its normal breathing room *below* the system inset. The executor status footer also no longer bleeds into the bottom-nav padding band: its `bottom` offset now uses the same `max(env(safe-area-inset-bottom), 12px)` floor that `MobileNavBar` already applies, so the two surfaces meet flush even when Chrome under-reports the bottom inset. Bare `TypeError: Failed to fetch` toasts (raised by in-flight requests aborted on tab background/resume) are now swallowed at the toast layer; toasts with additional context still surface.
