// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = join(__dirname, "..", "..");
const dashboardPackageJsonPath = join(dashboardRoot, "package.json");
const vitestConfigPath = join(dashboardRoot, "vitest.config.ts");

function readDashboardPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(dashboardPackageJsonPath, "utf8"));
}

describe("dashboard test config guard", () => {
  it("keeps the dashboard quality gate split into sequential sub-runs", () => {
    const { scripts } = readDashboardPackageJson();

    expect(scripts.test).toBe("pnpm run test:quality:app && pnpm run test:quality:api");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:foundation-api");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:foundation-ui");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:foundation-hooks-utils");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:components-a");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:components-b");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:app");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:chat");
    expect(scripts["test:quality:app"]).toContain("test:quality:app:settings");
    expect(scripts["test:quality:app"]).not.toContain("dashboard-app-quality --project dashboard-api-quality");
  });

  it("pins every app-quality shard to the heap wrapper and keeps split settings shards", () => {
    const { scripts } = readDashboardPackageJson();

    for (const key of [
      "test:quality:app:foundation-api",
      "test:quality:app:foundation-ui",
      "test:quality:app:foundation-hooks-utils",
      "test:quality:app:components-a",
      "test:quality:app:components-b",
      "test:quality:app:app",
      "test:quality:app:chat",
      "test:quality:app:settings-a1",
      "test:quality:app:settings-a2",
      "test:quality:app:settings-a3",
      "test:quality:app:settings-b",
      "test:quality:app:settings-c",
      "test:quality:app:settings-d",
    ]) {
      expect(scripts[key]).toContain("node scripts/run-vitest-with-heap.mjs --heap=6144");
    }

    expect(scripts["test:quality:app:settings"]).toContain("settings-a1");
    expect(scripts["test:quality:app:settings"]).toContain("settings-d");
  });

  it("keeps the split quality projects declared in vitest config", () => {
    const vitestConfig = readFileSync(vitestConfigPath, "utf8");

    for (const projectName of [
      "dashboard-app-quality-foundation-api",
      "dashboard-app-quality-foundation-ui",
      "dashboard-app-quality-foundation-hooks-utils",
      "dashboard-app-quality-components-a",
      "dashboard-app-quality-components-b",
      "dashboard-app-quality-app",
      "dashboard-app-quality-chat",
      "dashboard-app-quality-settings",
      "dashboard-api-quality",
    ]) {
      expect(vitestConfig).toContain(`name: \"${projectName}\"`);
    }

    expect(vitestConfig).toContain('"app/__tests__/spinner-animation.css.test.ts"');
    expect(vitestConfig).toContain('"scripts/__tests__/run-vitest-with-heap.test.ts"');
  });
});
