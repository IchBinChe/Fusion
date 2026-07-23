import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getRepoCapabilities, repoCapabilitiesRoutes } from "../repo-capabilities-routes.js";
import { resetScopeProbeCache } from "../auth.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

const TOKEN = "secret-route-token-abc";

function scopeHeaderResponse(status: number, header: string | null): Response {
  const headers = new Headers();
  if (header !== null) headers.set("x-oauth-scopes", header);
  return new Response("{}", { status, headers });
}

function ctx(settings: Record<string, unknown> = {}): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: {},
  } as unknown as PluginContext;
}

afterEach(() => {
  resetScopeProbeCache();
  vi.unstubAllGlobals();
});

describe("github-pm repo-capabilities routes", () => {
  it("registers exactly the one /repo/capabilities route", () => {
    expect(repoCapabilitiesRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repo/capabilities"]);
  });

  it("400s with validation_error when neither a repo query param nor a selected repo is available", async () => {
    const result = await getRepoCapabilities({ query: {} }, ctx({}));
    expect(result).toMatchObject({ status: 400, body: { ok: false, code: "validation_error" } });
  });

  it("400s on a malformed repo query param, without an unhandled exception", async () => {
    const result = await getRepoCapabilities({ query: { repo: "not-a-valid-repo" } }, ctx({}));
    expect(result).toMatchObject({ status: 400, body: { ok: false, code: "validation_error" } });
  });

  it("resolves capabilities for an explicit repo query param, returning 200 with a tabs map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => scopeHeaderResponse(200, "repo")));
    const result = await getRepoCapabilities(
      { query: { repo: "acme/widgets" } },
      ctx({ personalAccessToken: TOKEN }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, repo: "acme/widgets", authenticated: true });
    expect(result.body.tabs).toBeDefined();
  });

  it("falls back to the persisted selected repo when no repo query param is supplied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => scopeHeaderResponse(200, "repo")));
    const result = await getRepoCapabilities(
      { query: {} },
      ctx({ personalAccessToken: TOKEN, [SELECTED_REPO_SETTING_ID]: "acme/from-settings" }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, repo: "acme/from-settings" });
  });

  it("never echoes the resolved token in the response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => scopeHeaderResponse(200, "repo")));
    const result = await getRepoCapabilities({ query: { repo: "acme/widgets" } }, ctx({ personalAccessToken: TOKEN }));
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });
});
