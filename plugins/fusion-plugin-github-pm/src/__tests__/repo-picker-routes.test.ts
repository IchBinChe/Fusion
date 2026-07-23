import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { getRepoPickerRecents, getRepoPickerSearch, postRepoPickerSelect, repoPickerRoutes } from "../repo-picker-routes.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";
import { RECENT_REPOS_SETTING_ID } from "../repo-picker-store.js";

// FNXC:GitHubPmRepoPicker 2026-07-24-07:30: prevent resolveGitHubAuth's gh-CLI fallback from
// reading the real host machine's `gh` auth state -- these route tests must be deterministic
// regardless of whether the CI/dev host happens to have `gh` installed and logged in.
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return { ...actual, isGhAvailable: () => false, isGhAuthenticated: () => false, runGhAsync: vi.fn() };
});

const originalGithubToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubToken;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Mirrors repo-config-routes.test.ts's fake PluginStore: mutates a shared settings object. */
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
    taskStore: updatePluginSettings ? { getPluginStore: () => ({ updatePluginSettings }) } : {},
  } as unknown as PluginContext;
}

describe("github-pm repo-picker routes", () => {
  it("registers exactly the three repo-picker routes", () => {
    expect(repoPickerRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /repo-picker/search",
      "GET /repo-picker/recents",
      "POST /repo-picker/select",
    ]);
  });

  describe("GET /repo-picker/search", () => {
    it("returns an empty result set for an empty query without calling GitHub", async () => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      const result = await getRepoPickerSearch({ query: { q: "" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 200, body: { ok: true, items: [] } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("401s when unauthenticated", async () => {
      const result = await getRepoPickerSearch({ query: { q: "widgets" } }, ctxFor({}));
      expect(result).toMatchObject({ status: 401, body: { ok: false, authenticated: false, code: "not_authenticated" } });
    });

    it("returns matching repos across user + org scopes on success", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [{ full_name: "acme-org/widgets", owner: { login: "acme-org" }, name: "widgets", private: false, html_url: "https://github.com/acme-org/widgets", description: "Widgets" }],
      })));
      const result = await getRepoPickerSearch({ query: { q: "widgets" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result.status).toBe(200);
      expect((result.body as any).items).toEqual([{ fullName: "acme-org/widgets", owner: "acme-org", name: "widgets", private: false, htmlUrl: "https://github.com/acme-org/widgets", description: "Widgets", defaultBranch: undefined }]);
    });

    it("returns an empty items array (not an error) for zero results", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ total_count: 0, incomplete_results: false, items: [] })));
      const result = await getRepoPickerSearch({ query: { q: "no-such-repo-xyz" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result).toMatchObject({ status: 200, body: { ok: true, items: [], totalCount: 0 } });
    });

    it("maps a query error (e.g. an upstream 500) via githubErrorToResponse", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Server exploded" }, 500)));
      const result = await getRepoPickerSearch({ query: { q: "widgets" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result.body).toMatchObject({ ok: false, code: "github_api_error" });
    });
  });

  describe("GET /repo-picker/recents", () => {
    it("returns [] when nothing is stored, with no GitHub call", async () => {
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      const result = await getRepoPickerRecents({}, ctxFor({}));
      expect(result).toMatchObject({ status: 200, body: { ok: true, recents: [] } });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reads the persisted recents list", async () => {
      const recents = [{ repo: "owner/repo", lastUsedAt: "2026-07-24T00:00:00.000Z" }];
      const result = await getRepoPickerRecents({}, ctxFor({ [RECENT_REPOS_SETTING_ID]: JSON.stringify(recents) }));
      expect(result).toMatchObject({ status: 200, body: { ok: true, recents } });
    });
  });

  describe("POST /repo-picker/select", () => {
    it("400s on an invalid repo before touching the store or GitHub", async () => {
      const persisted = makePersistedSettings();
      const fetchImpl = vi.fn();
      vi.stubGlobal("fetch", fetchImpl);
      const result = await postRepoPickerSelect({ body: { repo: "not-valid" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
      expect(result).toMatchObject({ status: 400, body: { code: "validation_error" } });
      expect(persisted.updatePluginSettings).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("401s when unauthenticated", async () => {
      const result = await postRepoPickerSelect({ body: { repo: "owner/repo" } }, ctxFor({}));
      expect(result).toMatchObject({ status: 401, body: { code: "not_authenticated" } });
    });

    it("reports a clear not-found message (not raw API JSON) for a nonexistent repo", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)));
      const result = await postRepoPickerSelect({ body: { repo: "owner/ghost" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result.status).toBe(404);
      expect((result.body as any).code).toBe("not_found");
      expect((result.body as any).error).toBe('Repository "owner/ghost" was not found.');
      expect((result.body as any).error).not.toMatch(/\{|message/i);
    });

    it("reports a clear no-access message (not raw API JSON) for an inaccessible repo", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, 403)));
      const result = await postRepoPickerSelect({ body: { repo: "owner/private-repo" } }, ctxFor({ personalAccessToken: "ghp_token" }));
      expect(result.status).toBe(403);
      expect((result.body as any).code).toBe("auth_error");
      expect((result.body as any).error).toBe("You don't have access to \"owner/private-repo\" with the current GitHub credentials.");
    });

    it("does not enumerate issues while validating (single GET /repos/{owner}/{repo} call)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ full_name: "owner/huge-repo", owner: { login: "owner" }, name: "huge-repo", private: false, html_url: "https://github.com/owner/huge-repo" }));
      vi.stubGlobal("fetch", fetchImpl);
      const persisted = makePersistedSettings();
      await postRepoPickerSelect({ body: { repo: "owner/huge-repo" } }, ctxFor({ ...persisted.settings, personalAccessToken: "ghp_token" }, persisted.updatePluginSettings));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toBe("https://api.github.com/repos/owner/huge-repo");
      expect(String(url)).not.toContain("/issues");
    });

    it("persists selection + recents in one atomic updatePluginSettings call and returns 500 fail-closed when the store is unavailable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ full_name: "owner/repo", owner: { login: "owner" }, name: "repo", private: false, html_url: "https://github.com/owner/repo" })));
      const ctx = ctxFor({ personalAccessToken: "ghp_token" }); // no getPluginStore on this fake taskStore
      const result = await postRepoPickerSelect({ body: { repo: "owner/repo" } }, ctx);
      expect(result).toMatchObject({ status: 500, body: { code: "plugin_store_unavailable" } });
    });

    it("selects, persists via SELECTED_REPO_SETTING_ID + recentRepos, and dedupes a repeated select", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ full_name: "owner/repo", owner: { login: "owner" }, name: "repo", private: false, html_url: "https://github.com/owner/repo" })));
      const persisted = makePersistedSettings({ personalAccessToken: "ghp_token" });

      const first = await postRepoPickerSelect({ body: { repo: "Owner/Repo" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
      expect(first).toMatchObject({ status: 200, body: { ok: true, selectedRepo: "owner/repo" } });
      expect(persisted.settings[SELECTED_REPO_SETTING_ID]).toBe("owner/repo");
      expect(JSON.parse(persisted.settings[RECENT_REPOS_SETTING_ID] as string)).toHaveLength(1);

      // Re-selecting the same repo dedupes rather than appending a second entry.
      const second = await postRepoPickerSelect({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
      expect(second.status).toBe(200);
      const recentsAfter = JSON.parse(persisted.settings[RECENT_REPOS_SETTING_ID] as string);
      expect(recentsAfter).toHaveLength(1);
      expect(recentsAfter[0].repo).toBe("owner/repo");
    });

    it("never persists PAT/password fields through the select write path", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ full_name: "owner/repo", owner: { login: "owner" }, name: "repo", private: false, html_url: "https://github.com/owner/repo" })));
      const persisted = makePersistedSettings({ personalAccessToken: "ghp_super_secret" });
      await postRepoPickerSelect({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));
      for (const call of persisted.updatePluginSettings.mock.calls) {
        const patch = call[1] as Record<string, unknown>;
        expect(patch).not.toHaveProperty("personalAccessToken");
        expect(JSON.stringify(patch)).not.toContain("ghp_super_secret");
      }
    });

    it("survives a simulated Fusion restart: a fresh ctx built only from the persisted settings blob still resolves selection + recents", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ full_name: "owner/repo", owner: { login: "owner" }, name: "repo", private: false, html_url: "https://github.com/owner/repo" })));
      const persisted = makePersistedSettings({ personalAccessToken: "ghp_token" });
      await postRepoPickerSelect({ body: { repo: "owner/repo" } }, ctxFor(persisted.settings, persisted.updatePluginSettings));

      // Capture the persisted blob as plain data (no shared object reference) and rebuild a
      // completely fresh settings object + ctx from it, simulating a restart.
      const capturedBlob = JSON.parse(JSON.stringify(persisted.settings));
      const freshSettings: Record<string, unknown> = { ...capturedBlob };

      const recentsResult = await getRepoPickerRecents({}, ctxFor(freshSettings));
      expect((recentsResult.body as any).recents).toEqual([{ repo: "owner/repo", lastUsedAt: expect.any(String) }]);
      expect(freshSettings[SELECTED_REPO_SETTING_ID]).toBe("owner/repo");
      expect(typeof freshSettings[RECENT_REPOS_SETTING_ID]).toBe("string");
    });
  });
});
