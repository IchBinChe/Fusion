import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const defaultMaxWorkers = 2;
const requestedMaxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? String(defaultMaxWorkers), 10);
const maxWorkers = Math.max(1, Math.min(2, Number.isFinite(requestedMaxWorkers) ? requestedMaxWorkers : defaultMaxWorkers));
process.env.VITEST_MAX_WORKERS = String(maxWorkers);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["app/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers }, forks: { minForks: 1, maxForks: maxWorkers } },
    fileParallelism: true,
    isolate: true,
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "dist/**"],
    },
  },
});
