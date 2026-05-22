---
"@fusion/dashboard": patch
---

fix(dashboard): keep Android keyboard open in main chat; disable kanban pinch-zoom

Two Android-specific fixes:

1. **Keyboard dismissing in main chat.** `mobileKeyboardOpen` in `App.tsx` (derived from `useMobileKeyboard`) gates `project-content--with-mobile-nav` / `--with-footer` className assignment and MobileNavBar rendering. When the soft keyboard opened, those classes were removed and the nav unmounted, shrinking padding-bottom by ~80px in a single render. Android Chrome treats the resulting jump of the focused chat input as the focus target moving and instantly dismisses the keyboard. With `interactive-widget=resizes-content` set on Android, the layout viewport itself shrinks with the keyboard, so the hide-nav-on-keyboard behavior was redundant on Android (and harmful). The whole pattern is now gated to iOS via `isIOS()`. iOS path is unchanged.

2. **Pinch-zoom on kanban.** Android Chrome ignores `user-scalable=no` for accessibility, and the kanban board's `overflow-x: auto` columns combined with the inflated ICB produce a broken visual when the user zooms out. Adds `touch-action: pan-x pan-y` to `html, body` inside the mobile media query, which keeps scroll panning but disables pinch-zoom (Chat and MissionManager were unaffected because they don't expose a wide horizontal scrollable region).
