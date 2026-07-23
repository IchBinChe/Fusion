import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

describe("github-pm manifest", () => {
  it("passes validatePluginManifest", () => {
    const result = validatePluginManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("declares the id and version required by host registration", () => {
    expect(manifest.id).toBe("fusion-plugin-github-pm");
    expect(typeof manifest.version).toBe("string");
  });

  it("declares personalAccessToken as a password setting", () => {
    expect(manifest.settingsSchema.personalAccessToken.type).toBe("password");
    expect(manifest.settingsSchema.personalAccessToken.required).toBeFalsy();
  });

  it("declares defaultAutonomy as an enum with a default", () => {
    expect(manifest.settingsSchema.defaultAutonomy.type).toBe("enum");
    expect(manifest.settingsSchema.defaultAutonomy.enumValues).toEqual(["approve-all", "suggest", "auto"]);
    expect(manifest.settingsSchema.defaultAutonomy.defaultValue).toBe("approve-all");
  });

  it("declares defaultRepo as a string setting", () => {
    expect(manifest.settingsSchema.defaultRepo.type).toBe("string");
  });

  it("declares a single github-pm dashboard view", () => {
    expect(manifest.dashboardViews).toHaveLength(1);
    expect(manifest.dashboardViews[0]).toMatchObject({
      viewId: "github-pm",
      componentPath: "./dashboard-view",
      placement: "more",
    });
  });
});
