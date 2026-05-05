import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { computeMaxWorkers } from "../core/src/__test-utils__/vitest-workers";

const maxWorkers = computeMaxWorkers({ defaultCap: 3 });

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@fusion/core": resolve(__dirname, "../core/src/index.ts"),
      "@fusion/engine": resolve(__dirname, "../engine/src/index.ts"),
      "@fusion/plugin-sdk": resolve(__dirname, "../plugin-sdk/src/index.ts"),
      "@fusion/test-utils": resolve(__dirname, "../core/src/__test-utils__/workspace.ts"),
      "@fusion-plugin-examples/droid-runtime/probe": resolve(
        __dirname,
        "../../plugins/fusion-plugin-droid-runtime/src/probe.ts",
      ),
      "@fusion-plugin-examples/droid-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-droid-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/hermes-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-hermes-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/openclaw-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-openclaw-runtime/src/index.ts",
      ),
      "@fusion-plugin-examples/paperclip-runtime": resolve(
        __dirname,
        "../../plugins/fusion-plugin-paperclip-runtime/src/index.ts",
      ),
    },
  },
  test: {
    globals: true,
    setupFiles: [
      resolve(__dirname, "../core/src/__test-utils__/vitest-setup.ts"),
      "./vitest.setup.ts",
    ],
    globalSetup: [resolve(__dirname, "../core/src/__test-utils__/vitest-teardown.ts")],
    // Threads share a V8 heap so they're much lighter than forks for jsdom +
    // React suites; forks duplicated the entire renderer per worker (~500MB).
    pool: "threads",
    maxWorkers,
    poolOptions: { threads: { minThreads: 1, maxThreads: maxWorkers } },
    fileParallelism: true,
    isolate: true,
    // Dashboard route and integration-heavy suites can exceed the Vitest
    // 5s default under workspace-concurrent runs.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "dashboard-app",
          environment: "jsdom",
          include: ["app/**/*.test.{ts,tsx}"],
          // Process CSS imports only for jsdom tests that assert on
          // getComputedStyle. Node API tests do not need CSS transforms.
          css: { include: [/app\//] },
        },
      },
      {
        extends: true,
        test: {
          name: "dashboard-api",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          css: { include: [] },
        },
      },
    ],
    coverage: {
      enabled: false,
      reporter: ["text", "html", "json"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "dist/**"],
    },
  },
});
