---
"@runfusion/fusion": patch
---

Fix terminal input/output doubling triggered by creating a new tab. The connect-effect's `contextChanged` dependency flips true→false in the same render cycle as the new connection, re-running the effect and closing the still-CONNECTING WebSocket. Because `cleanup()` and `connect()`'s pre-close paths weren't nulling `ws.onopen`/`onmessage`/`onclose`/`onerror`, the ghost socket's `onmessage` continued to fire on the shared callback Set, delivering each pty data chunk (including keystroke echo) twice to xterm.
