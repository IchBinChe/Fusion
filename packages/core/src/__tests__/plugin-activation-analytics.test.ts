import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { aggregatePluginActivations } from "../plugin-activation-analytics.js";
import { createTaskStoreTestHarness } from "./store-test-helpers.js";

describe("aggregatePluginActivations", () => {
  const harness = createTaskStoreTestHarness();

  beforeEach(harness.beforeEach);
  afterEach(harness.afterEach);

  it("counts in-range activations and groups by plugin descending", () => {
    const store = harness.store();
    store.recordPluginActivation({ pluginId: "plugin.alpha", source: "plugin", activatedAt: "2026-06-19T10:00:00.000Z" });
    store.recordPluginActivation({ pluginId: "plugin.beta", source: "plugin", activatedAt: "2026-06-19T11:00:00.000Z" });
    store.recordPluginActivation({ pluginId: "plugin.alpha", source: "plugin", activatedAt: "2026-06-19T12:00:00.000Z" });
    store.recordPluginActivation({ pluginId: "plugin.outside", source: "plugin", activatedAt: "2026-06-20T00:00:00.000Z" });

    const result = aggregatePluginActivations(store.getDatabase(), {
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-19T23:59:59.999Z",
    });

    expect(result).toEqual({
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-19T23:59:59.999Z",
      activations: 3,
      byPlugin: [
        { pluginId: "plugin.alpha", count: 2 },
        { pluginId: "plugin.beta", count: 1 },
      ],
      unavailable: false,
    });
  });

  it("returns the unavailable sentinel shape when no activation rows exist in range", () => {
    const store = harness.store();
    store.recordPluginActivation({ pluginId: "plugin.alpha", source: "plugin", activatedAt: "2026-06-18T23:59:59.999Z" });

    const result = aggregatePluginActivations(store.getDatabase(), {
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-19T23:59:59.999Z",
    });

    expect(result).toEqual({
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-19T23:59:59.999Z",
      activations: 0,
      byPlugin: [],
      unavailable: true,
    });
  });

  it("treats from and to bounds as inclusive", () => {
    const store = harness.store();
    store.recordPluginActivation({ pluginId: "plugin.boundary", source: "plugin", activatedAt: "2026-06-19T00:00:00.000Z" });
    store.recordPluginActivation({ pluginId: "plugin.boundary", source: "plugin", activatedAt: "2026-06-19T23:59:59.999Z" });

    const result = aggregatePluginActivations(store.getDatabase(), {
      from: "2026-06-19T00:00:00.000Z",
      to: "2026-06-19T23:59:59.999Z",
    });

    expect(result.activations).toBe(2);
    expect(result.byPlugin).toEqual([{ pluginId: "plugin.boundary", count: 2 }]);
    expect(result.unavailable).toBe(false);
  });
});
