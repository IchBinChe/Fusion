import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const defaultMaxWorkers = 2;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(2, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);
const coreSourceEntry = fileURLToPath(new URL("../core/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fusion/core": coreSourceEntry,
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    passWithNoTests: true,
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    fileParallelism: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts", "dist/**"],
    },
  },
});
