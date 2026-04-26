# Dashboard API route registrars

`packages/dashboard/src/routes.ts` remains the single public entrypoint (`createApiRoutes(store, options)`), but route definitions are registered by domain modules in this directory.

## Shared context contract

All registrars receive `ApiRoutesContext` from `./types.ts`, built by `createApiRoutesContext()` in `./context.ts`.

Registrars should be typed as `ApiRouteRegistrar` so modules share one explicit registration contract.

The context centralizes cross-cutting dependencies so registrars preserve behavior without re-implementing plumbing:

- Request/project scoping: `getProjectIdFromRequest`, `getScopedStore`, `getProjectContext`
  - These are also exported from `context.ts` as canonical helpers for future extraction tasks.
- Engine-aware fallback behavior for project-bound and root-store APIs
- Runtime loggers and diagnostics emitters (`runtimeLogger`, `planningLogger`, `proxyLogger`, `chatLogger`)
- Proxy/auth/audit helpers (`proxyToRemoteNode`, `emitRemoteRouteDiagnostic`, `emitAuthSyncAuditLog`)
- Automation/routine resolvers and scope parsing helpers
- Shared error normalization (`rethrowAsApiError`)

## Registrar module map

- `register-settings-memory.ts` — settings, memory backend, memory file APIs
- `register-tasks.ts` — tasks, comments, documents, activity, task lifecycle operations
- `register-planning-chat.ts` — planning sessions, subtasks, chat session routes
- `register-messaging-scripts.ts` — scripts API and mailbox/message routes
- `register-git-github.ts` — git/GitHub workflows and related helpers
- `register-files-terminal-workspaces.ts` — files, terminal, workspace file operations
- `register-agents-projects-nodes.ts` — agents, project metadata, node routes
- `register-plugins-automation.ts` — plugin CRUD, automation, routines/webhooks
- `register-proxy.ts` — remote-node proxy forwarding and SSE proxy routes

## Ordering rules (critical)

Express matches in registration order. Keep registrar and in-registrar route ordering stable:

1. **Specific operation routes before generic parameterized routes** (`/runs`, `/runs/:id`, `/copy`, `/delete` before `/:id` style handlers)
2. **Specific operation routes before wildcard paths** (`/files/{*filepath}/copy|move|delete` before catch-all file write routes)
3. **Do not move proxy/script/message/file wildcards ahead of specific routes**

If adding a new endpoint, place it in the domain registrar and verify it does not shadow existing handlers.

## Integrated routers

Integrated routers are mounted through `register-integrated-routers.ts` and intentionally called from `routes.ts` at precedence-sensitive points:

- `registerIntegratedRouters(...)` mounts:
  - `createMissionRouter` → `/api/missions`
  - `createRoadmapRouter` → `/api/roadmaps`
  - `createInsightsRouter` → `/api/insights`
- `registerIntegratedDevServerRouter(...)` mounts:
  - `createDevServerRouter` → `/api/dev-server`

Keep these calls in their current positions inside `createApiRoutes()` unless an explicit route-ordering migration is planned and regression-tested.
