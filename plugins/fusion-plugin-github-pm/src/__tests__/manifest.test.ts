import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "@fusion/core";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { githubPmSettingsSchema } from "../settings.js";

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

  it("declares the FUSI-004 plugin-managed repo-config settings as strings, not secrets", () => {
    expect(manifest.settingsSchema.selectedRepo.type).toBe("string");
    expect(manifest.settingsSchema.repoConfigState.type).toBe("string");
    expect(manifest.settingsSchema.repoConfigState.multiline).toBe(true);
  });

  it("declares the FUSI-005 plugin-managed taxonomyProposalState setting as a multiline string, not a secret", () => {
    expect(manifest.settingsSchema.taxonomyProposalState.type).toBe("string");
    expect(manifest.settingsSchema.taxonomyProposalState.multiline).toBe(true);
  });

  it("declares a single github-pm dashboard view", () => {
    expect(manifest.dashboardViews).toHaveLength(1);
    expect(manifest.dashboardViews[0]).toMatchObject({
      viewId: "github-pm",
      componentPath: "./dashboard-view",
      placement: "more",
    });
  });

  it("FUSI-017: declares confirmWrites as a boolean setting defaulting ON", () => {
    expect(manifest.settingsSchema.confirmWrites.type).toBe("boolean");
    expect(manifest.settingsSchema.confirmWrites.defaultValue).toBe(true);
  });

  it("FUSI-017: manifest.json settingsSchema keys stay in parity with settings.ts's githubPmSettingsSchema", () => {
    expect(Object.keys(manifest.settingsSchema).sort()).toEqual(Object.keys(githubPmSettingsSchema).sort());
    for (const key of Object.keys(githubPmSettingsSchema)) {
      expect(manifest.settingsSchema[key].type).toBe(githubPmSettingsSchema[key].type);
      expect(manifest.settingsSchema[key].defaultValue).toEqual(githubPmSettingsSchema[key].defaultValue);
    }
  });
});
