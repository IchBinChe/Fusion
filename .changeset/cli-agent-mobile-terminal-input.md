---
"@runfusion/fusion": minor
---

Mobile terminal interaction for cli-agent sessions (U13). `SessionTerminal` now
detects mobile viewports via the canonical breakpoint
(`(max-width: 768px), (max-height: 480px)`) and renders a bottom input model in
place of relying on xterm's hidden-textarea (unreliable on mobile): a visible
text input that forwards typed text + `\r` as input frames on submit, plus an
accessory key bar emitting exact control sequences — Esc (`0x1B`), Tab (`0x09`),
a dedicated Ctrl-C (`0x03`), ANSI CSI cursor arrows (`CSI A/B/C/D`), and a sticky
Ctrl modifier whose next key combines into a control byte (Ctrl-C `0x03`,
Ctrl-D `0x04`, Ctrl-Z `0x1A`) with a visible active state.

Bar keys apply the iOS composer survival pattern (pointerdown/mousedown
preventDefault, action on click) so the input keeps focus, and the bar behaves as
a fixed footer that lifts above the virtual keyboard via `useMobileKeyboard`
(including its pinch-zoom `vv.scale > 1` guard, which is not treated as
keyboard-open). xterm `onData` input stays attached (the bar is primary, not
exclusive). Bar keys and the input are deliberate user keystrokes routed straight
to the session input path. All new strings are localized in the `app` i18n
catalog.
