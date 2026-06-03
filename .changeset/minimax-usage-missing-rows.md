---
"@runfusion/fusion": patch
---

Fix missing model rows in the Minimax provider usage panel. The primary `general` model meters quota purely via `current_interval_remaining_percent` (its count fields are `0`), so the previous count-based visibility filter dropped it entirely.

Minimax usage now prefers the authoritative `*_remaining_percent` field (with a count-based fallback) and renders a window only when a model exposes any quota signal. Each model's separate weekly quota window (`current_weekly_remaining_percent`, `weekly_*` timing) is now surfaced as its own indicator alongside the interval window.
