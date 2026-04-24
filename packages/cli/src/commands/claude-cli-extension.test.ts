import { describe, expect, it } from "vitest";
import {
  resolveClaudeCliExtension,
  resolveClaudeCliExtensionPaths,
} from "./claude-cli-extension.js";

describe("resolveClaudeCliExtension", () => {
  it("finds the bundled @fusion/pi-claude-cli package", () => {
    const result = resolveClaudeCliExtension();
    // In the monorepo test environment, the workspace package MUST resolve.
    // If this fails, the vendored package's package.json or pi.extensions
    // entry has been broken — a real regression worth surfacing.
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.path).toMatch(/pi-claude-cli[\/\\]index\.ts$/);
      expect(result.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("resolveClaudeCliExtensionPaths", () => {
  // Post-redesign (2026-04-23): the extension loads unconditionally so the
  // setting only gates the `/api/models` filter, not extension registration.
  // This function now takes no arguments and always returns the resolved
  // workspace path — cleaner contract, no settings coupling.
  it("always returns the resolved workspace path when the package is installed", () => {
    const result = resolveClaudeCliExtensionPaths();
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]).toMatch(/pi-claude-cli[\/\\]index\.ts$/);
    expect(result.resolution.status).toBe("ok");
    expect(result.warning).toBeUndefined();
  });
});

describe("cached resolution roundtrip", () => {
  it("set/get preserves the snapshot", async () => {
    const { setCachedClaudeCliResolution, getCachedClaudeCliResolution } =
      await import("./claude-cli-extension.js");
    setCachedClaudeCliResolution({ status: "not-installed" });
    expect(getCachedClaudeCliResolution()).toEqual({ status: "not-installed" });
    setCachedClaudeCliResolution(null);
    expect(getCachedClaudeCliResolution()).toBeNull();
  });
});

