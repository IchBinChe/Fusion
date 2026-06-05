---
"@runfusion/fusion": minor
---

Add CLI-agent adapter launch settings, an autonomy approval gate, and workflow
node-editor configuration for the CLI Agent Executor (U15).

A new `cliAgents` slice of global settings holds per-adapter operator launch
config — command override, extra args, autonomy mode, and env allowlist
additions — validated and sanitized at the write boundary (unknown adapter ids
and invalid fields are dropped). Shipped defaults are owned by the adapters.

The autonomy gate closes the "adjacent settings" bypass: elevation requested
through ANY channel (the autonomy field, extra args such as
`--dangerously-skip-permissions`, an autonomy-toggling env var, or a non-default
command override) is detected over the FULLY RESOLVED argv + env via per-adapter
elevation markers plus a shared generic env-pattern set. `resolveEffectivePosture`
derives the posture chip from the resolved invocation — never the autonomy field
alone — and the effective posture is denormalized onto the session record at
spawn. An elevated launch without a stored per-project approval fails with a
typed `CliAutonomyNotApprovedError` instead of stalling. Approvals are per-project
+ per-adapter (mirroring the raw workflow-CLI-command approval precedent) and the
approving principal in v1 is the daemon-token holder.

The dashboard adds daemon-token-authed routes
(`/api/cli-agents`, `/api/cli-agents/settings`,
`/api/cli-agents/:adapterId/approve-autonomy` + revoke), a Settings section for
per-adapter launch config with an explicit confirmation flow before elevated
autonomy is approved, and a workflow node-editor block that surfaces an adapter
picker (with native/hybrid/generic tier labels), an autonomy toggle, and the
waiting-on-input notification mode (banner / banner+notify) when a node's executor
is `cli-agent`. All new strings are localized in the `app` i18n catalog.
