---
"@runfusion/fusion": minor
---

Add CLI-agent one-shot sessions for the validator, planning, and CE plugin
surfaces (U9). A one-shot session runs an adapter's non-interactive invocation
(`claude -p`, `codex exec --json`, `droid exec --output-format json`,
`pi --print`) to completion in a working directory, streams output to a
read-only terminal (input disabled server-side via the durable
`autonomyPosture.readOnly` flag the transport's `isReadOnlySession` honors),
parses the adapter's structured JSON result, and reaps the PTY on exit.

The new `cli-agent/one-shot-session.ts` returns a typed result: a success with
the parsed payload, or a typed failure (`nonzero-exit` / `unparseable` /
`spawn-failed`) carrying a bounded output tail. The validator integration
(`cli-agent-validator.ts`) maps results into the existing
pass/fail/blocked/error verdict contract — a malformed or unparseable result
maps to `error`, NEVER a silent pass. A planning seam (`runCliAgentPlanning`)
maps one-shot output into the same `PlanningResponse` shape a model run
produces, and the CE plugin's orchestrator threads an `executor` option
(`model` | `cli-agent`) end-to-end to its resolver.
