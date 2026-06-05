---
"@runfusion/fusion": patch
---

Add the Codex, Droid, and Pi CLI agent adapters (U5).

Three new launch adapters join the engine's CLI agent executor, each declaring honest, verified capability flags so surfaces can render tier differences:

- **Codex** (hybrid tier): native turn-complete via the session-scoped `notify` config program (`-c notify=[…]`), capturing `thread-id` as the native session id; waiting-on-input is inferred from ANSI-stripped PTY prompt-pattern heuristics (approval menus, idle composer markers, with a spinner/working override) because Codex has no native waiting signal; resume via `codex resume <thread-id>`; rollout JSONL transcript tailed by probing (not hardcoding) the sessions directory for the file matching the thread-id.
- **Droid** (native tier): Claude-style hooks (`SessionStart`, `Stop`, `Notification`, tool-activity) delivering `session_id`/`transcript_path`/`permission_mode`; a message classifier splits the conflated `Notification` event into permission-request vs idle sub-reasons (both treated as waiting-on-input); resume via interactive `droid --resume <id>` or headless `droid exec -s <id>` — never the bare `-r` that means `--reasoning-effort` in exec mode.
- **Pi** (native tier): telemetry and transcript from session-JSONL tailing under a session-scoped `--session-dir`; lifecycle events (turn/agent start→busy, end→done, input-request→waiting) plus message rows→transcript; resume via `pi --session <path|partial-uuid>`.

A new `session-jsonl` transcript source is added to the adapter capability union for Pi.
