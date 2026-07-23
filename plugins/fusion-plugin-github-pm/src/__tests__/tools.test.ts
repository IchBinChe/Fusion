import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { githubPmStatusTool, githubPmTools } from "../tools.js";

function ctx(settings: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {},
  } as unknown as PluginContext;
}

describe("github-pm plugin tools", () => {
  it("registers the placeholder status tool", () => {
    expect(githubPmTools.map((tool) => tool.name)).toEqual(["github_pm_status"]);
  });

  it("reports not configured with no settings", async () => {
    const result = await githubPmStatusTool.execute({}, ctx({}));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("not configured");
    expect(result.details).toMatchObject({ configured: false });
  });

  it("reports configured without leaking the PAT value", async () => {
    const result = await githubPmStatusTool.execute({}, ctx({ personalAccessToken: "ghp_super_secret", defaultRepo: "acme/widgets" }));
    expect(result.content[0].text).toContain("configured");
    expect(result.content[0].text).not.toContain("ghp_super_secret");
    expect(JSON.stringify(result.details)).not.toContain("ghp_super_secret");
    expect(result.details).toMatchObject({ configured: true, defaultRepo: "acme/widgets" });
  });
});
