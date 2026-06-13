---
"@runfusion/fusion": patch
---

Fix the Quick Chat FAB not opening on iOS Safari. The drag hook calls `setPointerCapture()` in `pointerdown`, which makes WebKit swallow the synthetic `click`, so the FAB never toggled on iPhone. The open/close toggle now fires from the drag hook's `pointerup` (a real user gesture, so the stealth-input focus still raises the keyboard), with the trailing synthetic click de-duped so mouse and test click paths are unaffected.
