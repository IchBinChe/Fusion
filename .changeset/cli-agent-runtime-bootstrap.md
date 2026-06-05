---
"@runfusion/fusion": minor
---

Bootstrap the CLI Agent Executor runtime and wire it end-to-end.

A new `createCliAgentRuntime` factory (engine) constructs the per-project bundle — a `CliSessionStore` over the project's existing core Database, a per-runtime adapter registry with all five bundled adapters, the `CliSessionManager` (PTY lifecycle), the `TelemetryHub` (per-session token registry rebuilt from live records), and the `CliResumeCoordinator` (relaunch re-mints a hook token + rewrites hook scripts) — returning the executor bundle, the `isWorktreeResumeReserved` / `isCliSessionWaitingOnInput` predicates, and a scoped `dispose`.

The runtime is instantiated per project in `InProcessRuntime` behind the `experimentalFeatures.cliAgentExecutor` flag (opt-in, matching the `workflowGraphExecutor` precedent): the bundle threads into `TaskExecutorOptions.cliAgentRuntime`, the predicates feed the self-healing idle-worktree sweep and the stuck-task detector, and `resumeCoordinator.recoverOnStart()` runs non-blocking after engine start (errors logged, never thrown). The dashboard hook endpoint URL is derived from a server-threaded option, falling back to a localhost URL from `FUSION_DASHBOARD_PORT` (default 4040).

The dashboard now resolves the project's `TelemetryHub` via `cliAgentHubResolver`, mounts the cli-sessions transport from the runtime's manager + store, and brokers cli-backed chat sends: a chat session with a `cliExecutorAdapterId` routes composer sends to a `CliChatSessionRunner` (instead of the model agent loop), and the hub's sanitized telemetry is routed per-session into the runner's transcript handler.
