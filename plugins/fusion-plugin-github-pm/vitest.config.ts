import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { computeMaxWorkers } from "../../packages/core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers();

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@fusion/plugin-sdk": fileURLToPath(new URL("../../packages/plugin-sdk/src/index.ts", import.meta.url)),
      "@fusion/dashboard/app/plugins/types": fileURLToPath(new URL("../../packages/dashboard/app/plugins/types.ts", import.meta.url)),
      // FNXC:GithubPmWriteGate 2026-07-24-06:30: FUSI-017 reuses the dashboard's shared confirm-dialog
      // hook (useConfirm) rather than forking a new modal system; alias ahead of any root fallback so
      // vitest resolves the real hook module, not a stub.
      "@fusion/dashboard/app/hooks/useConfirm": fileURLToPath(new URL("../../packages/dashboard/app/hooks/useConfirm.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-setup.ts", import.meta.url))],
    globalSetup: [fileURLToPath(new URL("../../packages/core/src/__test-utils__/vitest-teardown.ts", import.meta.url))],
    pool: "threads",
    maxWorkers,
    minWorkers: 1,
    projects: [
      {
        extends: true,
        test: {
          name: "github-pm-dashboard",
          environment: "jsdom",
          include: ["src/**/__tests__/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "github-pm-node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      },
    ],
  },
});
