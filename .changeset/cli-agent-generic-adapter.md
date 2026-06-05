---
"@runfusion/fusion": patch
---

Add the generic heuristic-tier CLI agent adapter (U6).

Arbitrary user-configured CLI commands can now run as engine-owned PTY sessions. The generic adapter declares every native capability disabled (no native done/waiting signal, no transcript) and infers state purely from the terminal byte stream: busy while output progresses or a spinner animates, and a synthetic idle after a configurable quiet window when a prompt-like glyph is showing and no spinner overrides it. Per the completion-gating decision (origin R20) the generic tier NEVER reports done — idle surfaces a "looks idle — confirm to advance" affordance via a new busy-equivalent idle sub-state and never advances the pipeline.
