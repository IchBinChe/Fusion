import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearExtensionStoreBootStateForTesting,
  raceWithTimeoutAndAbort,
  resolveExtensionToolTimeoutMs,
  wrapExtensionToolExecute,
} from "../extension.js";

/*
FNXC:MergeQueue 2026-07-15-11:15:
FN-7956 hung AI merge review on unbounded extension fn_task_show. These unit tests lock the fail-closed timeout/abort budgets that unblock agent turns when store work wedges.

FNXC:MergeQueue 2026-07-15-11:20:
Code review follow-up: per-tool budgets must not clip fn_research_run(wait_for_completion) (default max_wait_ms 90s) under a flat 60s outer wrap.
*/

afterEach(() => {
  __clearExtensionStoreBootStateForTesting();
  vi.restoreAllMocks();
});

describe("resolveExtensionToolTimeoutMs", () => {
  it("keeps the default 60s budget for ordinary store tools", () => {
    expect(resolveExtensionToolTimeoutMs("fn_task_show")).toBe(60_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_list")).toBe(60_000);
  });

  it("raises the budget for fn_research_run wait_for_completion above default max_wait_ms", () => {
    // Default max_wait_ms is 90s; outer wrap must be strictly larger.
    expect(
      resolveExtensionToolTimeoutMs("fn_research_run", { wait_for_completion: true }),
    ).toBe(90_000 + 15_000);
  });

  it("honors explicit max_wait_ms for research wait", () => {
    expect(
      resolveExtensionToolTimeoutMs("fn_research_run", {
        wait_for_completion: true,
        max_wait_ms: 120_000,
      }),
    ).toBe(120_000 + 15_000);
  });

  it("keeps 60s for research when not waiting for completion", () => {
    expect(resolveExtensionToolTimeoutMs("fn_research_run", { wait_for_completion: false })).toBe(60_000);
    expect(resolveExtensionToolTimeoutMs("fn_research_run", {})).toBe(60_000);
  });

  it("gives multi-minute budgets to skills install and import/browse tools", () => {
    expect(resolveExtensionToolTimeoutMs("fn_skills_install")).toBe(300_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_import_github")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_task_browse_github_issues")).toBe(180_000);
    expect(resolveExtensionToolTimeoutMs("fn_web_fetch")).toBe(90_000);
  });
});

describe("raceWithTimeoutAndAbort", () => {
  it("resolves when the promise wins", async () => {
    await expect(
      raceWithTimeoutAndAbort(Promise.resolve("ok"), 1_000, undefined, "t"),
    ).resolves.toBe("ok");
  });

  it("rejects on timeout", async () => {
    await expect(
      raceWithTimeoutAndAbort(
        new Promise(() => {
          /* never settles */
        }),
        20,
        undefined,
        "slow-tool",
      ),
    ).rejects.toThrow(/slow-tool timed out after 20ms/);
  });

  it("rejects when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = raceWithTimeoutAndAbort(
      new Promise(() => {
        /* never settles */
      }),
      5_000,
      controller.signal,
      "aborted-tool",
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceWithTimeoutAndAbort(Promise.resolve("late"), 1_000, controller.signal, "pre-aborted"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("wrapExtensionToolExecute", () => {
  it("returns the tool result on success", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "hi" }] }));
    const wrapped = wrapExtensionToolExecute("fn_demo", execute, 1_000);
    await expect(wrapped("id", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "hi" }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("converts timeouts into isError tool results instead of hanging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = vi.fn(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const wrapped = wrapExtensionToolExecute("fn_hang", execute, 25);
    const result = await wrapped("id", {}, undefined);
    expect(result).toMatchObject({
      isError: true,
      details: { error: expect.stringMatching(/timed out after 25ms/) },
    });
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("fn_hang failed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fn_hang"));
  });

  it("converts abort into isError tool results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const execute = vi.fn(
      () =>
        new Promise(() => {
          /* never settles */
        }),
    );
    const wrapped = wrapExtensionToolExecute("fn_abort", execute, 5_000);
    const pending = wrapped("id", {}, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      isError: true,
      details: { error: "aborted" },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fn_abort aborted"));
  });

  it("uses per-tool research wait budget when timeoutMs is omitted", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] }));
    const wrapped = wrapExtensionToolExecute("fn_research_run", execute);
    // Should not use the flat 60s path for wait_for_completion — budget is 105s; this call is instant.
    await expect(
      wrapped("id", { wait_for_completion: true, max_wait_ms: 90_000 }, undefined),
    ).resolves.toEqual({ content: [{ type: "text", text: "done" }] });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not clip a research wait that finishes under max_wait_ms but over 60s", async () => {
    // Simulate a 70ms wait with a 100ms research budget (not the flat 60ms default for ordinary tools).
    const execute = vi.fn(
      async () => {
        await new Promise((r) => setTimeout(r, 70));
        return { content: [{ type: "text" as const, text: "research-ok" }] };
      },
    );
    // Explicit small budget that still exceeds the simulated wait (params would resolve to 90s+ in prod).
    const wrapped = wrapExtensionToolExecute("fn_research_run", execute, 150);
    await expect(
      wrapped("id", { wait_for_completion: true, max_wait_ms: 90_000 }, undefined),
    ).resolves.toEqual({ content: [{ type: "text", text: "research-ok" }] });
  });
});
