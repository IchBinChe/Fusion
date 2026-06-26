# Test velocity baseline

> Weekly FN-6612 signal-per-second baseline. Measure and report feedback-loop velocity; do **not** add slow tests or wire this report into blocking PR checks. The merge gate remains the existing thin Lint, Typecheck, Build, and Gate path.

## Latest baseline

- Cycle: **2026-W26**
- Captured at: **2026-06-25T05:47:54.804Z**
- Timing snapshot: `scripts/test-timings.json` captured at **2026-06-25T05:45:08.116Z**
- Quarantine ledger: `scripts/lib/test-quarantine.json`

## Metrics

| Metric | Current | Delta vs previous |
|---|---:|---:|
| Merge gate wall-time (`pnpm test:gate`) | 7.5s | -9.3s |
| Boot smoke wall-time (`pnpm smoke:boot`) | 18.2s | -4.7s |
| Changed-only test wall-time (`pnpm test`) | 9.4s | -10.2s |
| Quarantine / flake count | 0 | 0 |
| Deletion-due quarantines | 0 | n/a |

## Measurement failures

- None recorded.

## Timing snapshot notes

- No stale or missing timing metadata detected in the rendered slowest-file rows.

## Slowest 20 test files

| Rank | File | Package | Duration |
|---:|---|---|---:|
| 1 | `packages/dashboard/app/components/__tests__/SettingsModal.test.tsx` | @fusion/dashboard | 1m 01s |
| 2 | `packages/dashboard/src/__tests__/insights-routes.test.ts` | @fusion/dashboard | 26.5s |
| 3 | `packages/engine/src/runtimes/__tests__/in-process-runtime.test.ts` | @fusion/engine | 24.7s |
| 4 | `packages/dashboard/app/components/__tests__/ChatView.test.tsx` | @fusion/dashboard | 24.4s |
| 5 | `packages/dashboard/src/__tests__/workflow-routes.test.ts` | @fusion/dashboard | 22.0s |
| 6 | `packages/core/src/__tests__/db.test.ts` | @fusion/core | 21.2s |
| 7 | `packages/dashboard/app/components/__tests__/GitManagerModal.test.tsx` | @fusion/dashboard | 16.9s |
| 8 | `packages/core/src/__tests__/mission-store.test.ts` | @fusion/core | 16.0s |
| 9 | `packages/cli/src/__tests__/extension.test.ts` | @runfusion/fusion | 15.7s |
| 10 | `packages/dashboard/app/components/__tests__/AgentPromptsManager.test.tsx` | @fusion/dashboard | 14.8s |
| 11 | `packages/dashboard/app/components/__tests__/App.test.tsx` | @fusion/dashboard | 14.6s |
| 12 | `packages/dashboard/app/components/__tests__/TaskDetailModal.inline-editing-and-integrations.test.tsx` | @fusion/dashboard | 14.1s |
| 13 | `packages/dashboard/app/components/__tests__/TaskDetailModal.rendering.test.tsx` | @fusion/dashboard | 13.7s |
| 14 | `packages/dashboard/src/__tests__/routes-auth.test.ts` | @fusion/dashboard | 13.6s |
| 15 | `packages/core/src/__tests__/agent-store.test.ts` | @fusion/core | 13.4s |
| 16 | `packages/engine/src/__tests__/workspace-merger-idempotency.test.ts` | @fusion/engine | 12.7s |
| 17 | `packages/engine/src/__tests__/self-healing-workspace.test.ts` | @fusion/engine | 11.8s |
| 18 | `packages/engine/src/__tests__/pr-response-run.test.ts` | @fusion/engine | 11.6s |
| 19 | `packages/dashboard/app/components/__tests__/ListView.test.tsx` | @fusion/dashboard | 11.3s |
| 20 | `plugins/fusion-plugin-compound-engineering/src/__tests__/sync.test.ts` | @fusion-plugin-examples/compound-engineering | 11.0s |

## Quarantine age buckets

| Age bucket | Count |
|---|---:|
| 0-6 days | 0 |
| 7-13 days | 0 |
| deletion due (>=14 days) | 0 |
| unknown/future | 0 |

### Deletion-due entries

| File | Quarantined at | Age (days) |
|---|---:|---:|
| — | — | — |

## Before / after trend

| Row | Captured at | Gate | Boot smoke | `pnpm test` | Quarantine count |
|---|---|---:|---:|---:|---:|
| Previous | 2026-06-23T18:43:21.941Z | 16.8s | 22.8s | 19.6s | 0 |
| Latest | 2026-06-25T05:47:54.804Z | 7.5s | 18.2s | 9.4s | 0 |
| Delta | — | -9.3s | -4.7s | -10.2s | 0 |

_Future weekly rows append to `scripts/test-velocity-history.json`; compare the latest row against the previous row before posting to #leads._

## Post to #leads

```text
FN-6612 weekly test velocity: gate 7.5s (-9.3s), boot smoke 18.2s (-4.7s), pnpm test 9.4s (-10.2s), quarantine ledger 0 (0). Slowest file: packages/dashboard/app/components/__tests__/SettingsModal.test.tsx at 1m 01s. Deletion-due quarantines: 0.
```

## How to refresh

```bash
pnpm test:velocity -- --measure --write-report
```

In measure mode, the script runs a non-measured `pnpm build` preflight before timing `pnpm test:gate`, `pnpm smoke:boot`, or `pnpm test`. The preflight time is setup only and is excluded from lane metrics; if it fails, the Measurement failures section records `Build preflight (pnpm build)` as the reason. Use `--skip-build-preflight` only when the workspace is already built by CI.

Report-only regeneration is cheap and does not run any suite:

```bash
pnpm test:velocity
```
