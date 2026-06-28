import { Boxes, Grid3X3 } from "lucide-react";
import { describe, expect, it } from "vitest";
import { getPluginNavIcon } from "../pluginNavIcon";

describe("getPluginNavIcon", () => {
  it("resolves the Compound Engineering Boxes icon to the registered lucide glyph", () => {
    expect(getPluginNavIcon("Boxes")).toBe(Boxes);
  });

  it("falls back to Grid3X3 for empty or unknown icon names", () => {
    expect(getPluginNavIcon()).toBe(Grid3X3);
    expect(getPluginNavIcon("not-a-real-plugin-icon")).toBe(Grid3X3);
  });
});
