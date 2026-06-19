import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("TaskStore plugin activation persistence", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("round-trips activation rows through the project database", () => {
    const activatedAt = "2026-06-19T01:02:03.000Z";

    const persisted = harness.store().recordPluginActivation({
      pluginId: "plugin.alpha",
      source: "plugin",
      pluginVersion: "1.2.3",
      activatedAt,
    });

    expect(persisted).toEqual({
      id: expect.any(Number),
      pluginId: "plugin.alpha",
      source: "plugin",
      pluginVersion: "1.2.3",
      activatedAt,
    });

    const row = harness.store().getDatabase().prepare("SELECT * FROM plugin_activations WHERE id = ?").get(persisted.id);
    expect(row).toEqual({
      id: persisted.id,
      pluginId: "plugin.alpha",
      source: "plugin",
      pluginVersion: "1.2.3",
      activatedAt,
    });
  });

  it("persists an undefined pluginVersion as NULL", () => {
    const persisted = harness.store().recordPluginActivation({
      pluginId: "extension.beta",
      source: "extension",
      activatedAt: "2026-06-19T04:05:06.000Z",
    });

    const row = harness.store().getDatabase().prepare("SELECT pluginVersion FROM plugin_activations WHERE id = ?").get(persisted.id) as
      | { pluginVersion: string | null }
      | undefined;

    expect(persisted.pluginVersion).toBeNull();
    expect(row?.pluginVersion).toBeNull();
  });
});
