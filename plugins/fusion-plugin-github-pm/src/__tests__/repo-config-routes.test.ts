import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getRepoConfig, putRepoConfig, selectRepoConfig, repoConfigRoutes } from "../repo-config-routes.js";
import { REPO_CONFIG_STATE_SETTING_ID, SELECTED_REPO_SETTING_ID } from "../repo-config.js";

/**
 * A fake PluginStore whose updatePluginSettings mutates a shared in-memory
 * settings object -- simulating the durable central.plugin_installs.settings
 * merge semantics of PluginStore.updatePluginSettings without a real DB.
 */
function makePersistedSettings(initial: Record<string, unknown> = {}) {
  const settings: Record<string, unknown> = { ...initial };
  const updatePluginSettings = vi.fn(async (_pluginId: string, patch: Record<string, unknown>) => {
    Object.assign(settings, patch);
    return settings;
  });
  return { settings, updatePluginSettings };
}

function ctxFor(settings: Record<string, unknown>, updatePluginSettings?: ReturnType<typeof vi.fn>): PluginContext {
  return {
    pluginId: "fusion-plugin-github-pm",
    settings,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitEvent: vi.fn(),
    taskStore: updatePluginSettings
      ? { getPluginStore: () => ({ updatePluginSettings }) }
      : {},
  } as unknown as PluginContext;
}

describe("github-pm repo-config routes", () => {
  it("registers exactly the three repo-config routes", () => {
    expect(repoConfigRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repo-config",
      "PUT /repo-config",
      "PUT /repo-config/select",
    ]);
  });

  it("GET returns defaults with no config/selection when nothing is stored", async () => {
    const result = await getRepoConfig({}, ctxFor({}));
    expect(result).toMatchObject({ status: 200, body: { ok: true, selectedRepo: null, config: null, repoConfigs: {} } });
  });

  it("PUT validates repo before touching the store", async () => {
    const persisted = makePersistedSettings();
    const result = await putRepoConfig({ body: { repo: "not-valid" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
    expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    expect(persisted.updatePluginSettings).not.toHaveBeenCalled();
  });

  it("select validates repo before touching the store", async () => {
    const persisted = makePersistedSettings();
    const result = await selectRepoConfig({ body: { repo: "" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
    expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
    expect(persisted.updatePluginSettings).not.toHaveBeenCalled();
  });

  it("returns a stable 500 when getPluginStore is unavailable, without throwing", async () => {
    const ctx = ctxFor({}); // no getPluginStore on this fake taskStore
    await expect(putRepoConfig({ body: { repo: "owner/repo", config: { autonomyMode: "auto" } } }, ctx)).resolves.toMatchObject({
      status: 500,
      body: { code: "plugin_store_unavailable" },
    });
    await expect(selectRepoConfig({ body: { repo: "owner/repo" } }, ctx)).resolves.toMatchObject({
      status: 500,
      body: { code: "plugin_store_unavailable" },
    });
  });

  it("never persists PAT/password fields through the repo-config write path", async () => {
    const persisted = makePersistedSettings({ personalAccessToken: "ghp_super_secret" });
    const ctx = ctxFor(persisted.settings, persisted.updatePluginSettings);
    await putRepoConfig({ body: { repo: "owner/repo", config: { autonomyMode: "auto" } } }, ctx);
    for (const call of persisted.updatePluginSettings.mock.calls) {
      const patch = call[1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty("personalAccessToken");
      expect(JSON.stringify(patch)).not.toContain("ghp_super_secret");
    }
  });

  it("configure A, switch to B, and return to A restores A exactly (acceptance criterion)", async () => {
    const persisted = makePersistedSettings();

    // Configure repo A.
    const ctxA1 = ctxFor(persisted.settings, persisted.updatePluginSettings);
    const selectA = await selectRepoConfig({ body: { repo: "Owner/RepoA" } }, ctxA1);
    expect(selectA).toMatchObject({ status: 200, body: { ok: true, selectedRepo: "owner/repoa" } });

    const ctxA2 = ctxFor(persisted.settings, persisted.updatePluginSettings);
    const putA = await putRepoConfig(
      { body: { repo: "owner/repoA", config: { autonomyMode: "auto", approvedTaxonomyVersion: 3, viewPreferences: { sort: "priority" } } } },
      ctxA2,
    );
    expect(putA).toMatchObject({ status: 200, body: { ok: true, repo: "owner/repoa" } });
    const configA = (putA.body as any).config;
    expect(configA).toMatchObject({ autonomyMode: "auto", approvedTaxonomyVersion: 3, viewPreferences: { sort: "priority" } });

    // Switch to repo B with a different config.
    const ctxB1 = ctxFor(persisted.settings, persisted.updatePluginSettings);
    await selectRepoConfig({ body: { repo: "owner/repoB" } }, ctxB1);
    const ctxB2 = ctxFor(persisted.settings, persisted.updatePluginSettings);
    const putB = await putRepoConfig(
      { body: { repo: "owner/repoB", config: { autonomyMode: "suggest", approvedTaxonomyVersion: 7 } } },
      ctxB2,
    );
    expect(putB).toMatchObject({ status: 200, body: { ok: true, repo: "owner/repob" } });

    // Return to repo A.
    const ctxA3 = ctxFor(persisted.settings, persisted.updatePluginSettings);
    const selectBackToA = await selectRepoConfig({ body: { repo: "owner/repoA" } }, ctxA3);
    expect(selectBackToA).toMatchObject({ status: 200, body: { ok: true, selectedRepo: "owner/repoa" } });

    // GET now must show A's original config restored, untouched by B's write.
    const ctxRead = ctxFor(persisted.settings);
    const finalGet = await getRepoConfig({}, ctxRead);
    expect(finalGet).toMatchObject({
      status: 200,
      body: {
        ok: true,
        selectedRepo: "owner/repoa",
        config: { autonomyMode: "auto", approvedTaxonomyVersion: 3, viewPreferences: { sort: "priority" } },
      },
    });
    // B's config independently persisted, unaffected by returning to A.
    expect((finalGet.body as any).repoConfigs["owner/repob"]).toMatchObject({ autonomyMode: "suggest", approvedTaxonomyVersion: 7 });
    expect((finalGet.body as any).repoConfigs["owner/repoa"]).toMatchObject({ autonomyMode: "auto", approvedTaxonomyVersion: 3 });
  });

  it("survives a simulated Fusion restart: a fresh ctx built only from the persisted settings blob still resolves both repos", async () => {
    const persisted = makePersistedSettings();
    await selectRepoConfig({ body: { repo: "owner/repoA" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
    await putRepoConfig(
      { body: { repo: "owner/repoA", config: { autonomyMode: "auto", approvedTaxonomyVersion: 3 } } },
      ctxFor(persisted.settings, persisted.updatePluginSettings),
    );
    await selectRepoConfig({ body: { repo: "owner/repoB" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
    await putRepoConfig(
      { body: { repo: "owner/repoB", config: { autonomyMode: "suggest", approvedTaxonomyVersion: 7 } } },
      ctxFor(persisted.settings, persisted.updatePluginSettings),
    );
    await selectRepoConfig({ body: { repo: "owner/repoA" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));

    // Capture the persisted blob as plain data (no shared object/process-memory reference)
    // and rebuild a completely fresh settings object + ctx from it, simulating a restart.
    const capturedBlob = JSON.parse(JSON.stringify(persisted.settings));
    const freshSettings: Record<string, unknown> = { ...capturedBlob };
    const freshCtx = ctxFor(freshSettings);

    const result = await getRepoConfig({}, freshCtx);
    expect(result).toMatchObject({
      status: 200,
      body: {
        ok: true,
        selectedRepo: "owner/repoa",
        config: { autonomyMode: "auto", approvedTaxonomyVersion: 3 },
      },
    });
    expect((result.body as any).repoConfigs["owner/repob"]).toMatchObject({ autonomyMode: "suggest", approvedTaxonomyVersion: 7 });
    expect(typeof freshSettings[REPO_CONFIG_STATE_SETTING_ID]).toBe("string");
    expect(freshSettings[SELECTED_REPO_SETTING_ID]).toBe("owner/repoa");
  });
});
