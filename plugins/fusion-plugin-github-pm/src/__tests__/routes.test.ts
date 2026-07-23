import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getGitHubPmStatus, githubPmRoutes } from "../routes.js";

function ctx(settings: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {},
  } as unknown as PluginContext;
}

describe("github-pm plugin routes", () => {
  it("reports not configured on a fresh install with no settings", async () => {
    const result = await getGitHubPmStatus({}, ctx({}));
    expect(result).toMatchObject({ status: 200, body: { ok: true, configured: false, autonomy: "approve-all", defaultRepo: null } });
  });

  it("FUSI-017: /status reports confirmWrites true by default (unset settings)", async () => {
    const result = await getGitHubPmStatus({}, ctx({}));
    expect(result.body).toMatchObject({ confirmWrites: true });
  });

  it("FUSI-017: /status reports confirmWrites false only when explicitly disabled", async () => {
    const result = await getGitHubPmStatus({}, ctx({ confirmWrites: false }));
    expect(result.body).toMatchObject({ confirmWrites: false });
  });

  it("reports configured when a default repo is set", async () => {
    const result = await getGitHubPmStatus({}, ctx({ defaultRepo: "acme/widgets" }));
    expect(result).toMatchObject({ status: 200, body: { ok: true, configured: true, defaultRepo: "acme/widgets" } });
  });

  it("reports configured when a personal access token is set, without echoing it", async () => {
    const result = await getGitHubPmStatus({}, ctx({ personalAccessToken: "ghp_super_secret" }));
    expect(result.body).toMatchObject({ ok: true, configured: true });
    expect(JSON.stringify(result.body)).not.toContain("ghp_super_secret");
  });

  it("does not call fetch (no live GitHub calls in the scaffold)", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await getGitHubPmStatus({}, ctx({ personalAccessToken: "token" }));
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("registers the /status, /auth/diagnostics, FUSI-004 repo-config, FUSI-009 repo capabilities, FUSI-005 taxonomy, FUSI-013 issue-detail, FUSI-012 issues-list, FUSI-014 issue-write, KB-002 label, and KB-003 milestone routes", () => {
    expect(githubPmRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /status",
      "GET /auth/diagnostics",
      "GET /repo-config",
      "PUT /repo-config",
      "PUT /repo-config/select",
      "GET /repo/capabilities",
      "POST /taxonomy/propose",
      "GET /taxonomy/proposals",
      "PUT /taxonomy/proposals/accept",
      "PUT /taxonomy/proposals/reject",
      "PUT /taxonomy/proposals/edit",
      "GET /issues/detail",
      "GET /issues/comments",
      "GET /issues/list",
      "GET /issues/filter-options",
      "POST /issues/create",
      "PUT /issues/update",
      "PUT /issues/state",
      "POST /issues/comments",
      "PUT /issues/comments",
      "GET /labels/list",
      "POST /labels/create",
      "PUT /labels/update",
      "POST /labels/delete",
      "GET /milestones/list",
      "POST /milestones/create",
      "PUT /milestones/update",
      "PUT /milestones/state",
      "POST /milestones/delete",
      "POST /milestones/reassign-open-issues",
    ]);
  });
});
