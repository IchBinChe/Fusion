---
"@runfusion/fusion": minor
---

Wire the CLI Agent Executor as a selectable executor kind for the task execute
path (U7). A workflow node with `config.executor === "cli-agent"` (plus
`cliAdapterId` and optional `cliAutonomy`/`cliNotify`) now drives an engine-owned
CLI coding agent (Claude Code / Codex / Droid / Pi / generic) through the execute
step inside the task worktree.

The new `cli-agent/task-session.ts` orchestrates the task↔session lifecycle:
spawn in the worktree, mint the per-session hook token and write the hook scripts,
inject the task prompt after readiness, subscribe to the authoritative state
machine, and resolve on a positive completion signal (origin R20 gating — a
native `done` advances the pipeline; the generic tier never auto-advances on idle
and exposes a `confirmAdvance()` affordance instead). The resolved executor config
is snapshotted at launch, so a mid-run node-config edit applies to the next run
only. The PTY is reaped (recorded `completed`) at the execute→in-review handoff.

Lifecycle semantics honor the existing contracts: a hard cancel
(`moveTask(in-progress→todo)` / column-exit abort) SIGKILLs the CLI session via
the same dispose/abort path API sessions use and marks it `killed` (never
resume-eligible); a re-plan/RETHINK re-entry kills any prior live session and
launches fresh; a follow-up to a done task resumes the recorded native session id
when the adapter supports resume, else launches fresh. A PTY-pool ceiling
(`CliConcurrencyLimitError`) surfaces as a clear queued/rejected task state rather
than a silent stall.
