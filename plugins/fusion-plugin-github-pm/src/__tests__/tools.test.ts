import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@fusion/plugin-sdk";
import { githubPmCommentIssueTool, githubPmCreateIssueTool, githubPmEditIssueTool, githubPmSetIssueStateTool, githubPmStatusTool, githubPmTools } from "../tools.js";
import { SELECTED_REPO_SETTING_ID } from "../repo-config.js";

// FNXC:GithubPmIssues 2026-07-24-05:20: same deterministic gh-CLI suppression as issue-write-routes.test.ts.
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
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

describe("github-pm plugin tools", () => {
  it("registers the status tool plus the FUSI-014 write tools", () => {
    expect(githubPmTools.map((tool) => tool.name)).toEqual([
      "github_pm_status",
      "github_pm_create_issue",
      "github_pm_edit_issue",
      "github_pm_comment_issue",
      "github_pm_set_issue_state",
    ]);
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

/*
FNXC:GithubPmIssues 2026-07-24-05:20:
FUSI-014 write-tool tests: each performs its mutation against a mocked fetch and returns a
non-error result; an auth/permission error yields isError:true with a readable, token-free
message.
*/
describe("github-pm write tools (FUSI-014)", () => {
  // FUSI-017: confirmWrites explicitly OFF below to assert the exact FUSI-014 unconfirmed
  // behavior is preserved byte-for-byte when the gate is disabled.
  it("github_pm_create_issue performs the mutation and returns a non-error result (confirmWrites OFF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 9, title: "New", state: "open", html_url: "https://x" })));
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "New" }, ctx({ personalAccessToken: "ghp_token", confirmWrites: false }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("#9");
    vi.unstubAllGlobals();
  });

  it("github_pm_create_issue 400s (isError) on a missing title", async () => {
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets" }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBe(true);
  });

  it("github_pm_edit_issue resolves the selected repo when omitted and returns the updated issue (confirmWrites OFF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "Edited", state: "open", html_url: "https://x" })));
    const result = await githubPmEditIssueTool.execute({ number: 5, title: "Edited" }, ctx({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token", confirmWrites: false }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Edited");
    vi.unstubAllGlobals();
  });

  it("github_pm_comment_issue posts a comment (confirmWrites OFF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 1, user: { login: "octocat" }, body: "Hi" })));
    const result = await githubPmCommentIssueTool.execute({ repo: "acme/widgets", number: 5, body: "Hi" }, ctx({ personalAccessToken: "ghp_token", confirmWrites: false }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Commented");
    vi.unstubAllGlobals();
  });

  it("github_pm_set_issue_state closes with a reason (confirmWrites OFF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "closed", html_url: "https://x" })));
    const result = await githubPmSetIssueStateTool.execute({ repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed" }, ctx({ personalAccessToken: "ghp_token", confirmWrites: false }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("closed");
    vi.unstubAllGlobals();
  });

  it("an unauthenticated repo/token yields isError:true with an actionable message (confirmWrites OFF)", async () => {
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "X" }, ctx({ confirmWrites: false }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not authenticated");
  });

  it("a mocked 403 permission error yields isError:true without leaking the token (confirmWrites OFF)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration secret-tok" }, 403)));
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "X" }, ctx({ personalAccessToken: "secret-tok", confirmWrites: false }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("secret-tok");
    vi.unstubAllGlobals();
  });

  /*
  FNXC:GithubPmWriteGate 2026-07-24-06:20:
  FUSI-017: confirmWrites ON gates every one of the 4 write tools. Missing `confirmed` blocks
  with isError:true and ZERO fetch calls; confirmed:true lets the write proceed identically
  to the OFF-path tests above.
  */
  it("github_pm_create_issue: confirmWrites ON + missing confirmed → isError, zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "New" }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires confirmation");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("github_pm_create_issue: confirmWrites ON + confirmed:true → the write proceeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 9, title: "New", state: "open", html_url: "https://x" })));
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "New", confirmed: true }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("#9");
    vi.unstubAllGlobals();
  });

  it("github_pm_edit_issue: confirmWrites ON + missing confirmed → isError, zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await githubPmEditIssueTool.execute({ number: 5, title: "Edited" }, ctx({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" }));
    expect(result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("github_pm_edit_issue: confirmWrites ON + confirmed:true → the write proceeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "Edited", state: "open", html_url: "https://x" })));
    const result = await githubPmEditIssueTool.execute({ number: 5, title: "Edited", confirmed: true }, ctx({ [SELECTED_REPO_SETTING_ID]: "acme/widgets", personalAccessToken: "ghp_token" }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Edited");
    vi.unstubAllGlobals();
  });

  it("github_pm_comment_issue: confirmWrites ON + missing confirmed → isError, zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await githubPmCommentIssueTool.execute({ repo: "acme/widgets", number: 5, body: "Hi" }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("github_pm_comment_issue: confirmWrites ON + confirmed:true → the write proceeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 1, user: { login: "octocat" }, body: "Hi" })));
    const result = await githubPmCommentIssueTool.execute({ repo: "acme/widgets", number: 5, body: "Hi", confirmed: true }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Commented");
    vi.unstubAllGlobals();
  });

  it("github_pm_set_issue_state: confirmWrites ON + missing confirmed → isError, zero fetch calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await githubPmSetIssueStateTool.execute({ repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed" }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("github_pm_set_issue_state: confirmWrites ON + confirmed:true → the write proceeds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ number: 5, title: "X", state: "closed", html_url: "https://x" })));
    const result = await githubPmSetIssueStateTool.execute({ repo: "acme/widgets", number: 5, state: "closed", stateReason: "completed", confirmed: true }, ctx({ personalAccessToken: "ghp_token" }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("closed");
    vi.unstubAllGlobals();
  });

  it("confirmWrites ON + confirmed:true never leaks the token, even on a mocked auth failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration secret-tok" }, 403)));
    const result = await githubPmCreateIssueTool.execute({ repo: "acme/widgets", title: "X", confirmed: true }, ctx({ personalAccessToken: "secret-tok" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("secret-tok");
    vi.unstubAllGlobals();
  });
});
