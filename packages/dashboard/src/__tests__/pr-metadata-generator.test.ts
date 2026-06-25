import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const { execMock, promptMock, disposeMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  promptMock: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    exec: execMock,
  };
});

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  createFnAgent: vi.fn(async () => ({
    session: {
      prompt: promptMock,
      dispose: disposeMock,
    },
  })),
}));

import { createFnAgent } from "@fusion/engine";
import { generatePrMetadata } from "../pr-metadata-generator.js";

function createTask(): Task {
  return {
    id: "FN-4991",
    title: "Route contracts",
    description: "Implement route contracts",
    status: "todo",
    column: "in-progress",
    priority: "normal",
    dependencies: [],
    size: "M",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function setupExec(outputs: Record<string, string>) {
  execMock.mockImplementation((command: string, _options: unknown, callback: (err: unknown, out: { stdout: string; stderr: string }) => void) => {
    const key = Object.keys(outputs).find((k) => command.includes(k));
    if (!key) {
      callback(null, { stdout: "", stderr: "" });
      return;
    }
    callback(null, { stdout: outputs[key], stderr: "" });
  });
}

function expectFallbackBody(body: string) {
  expect(body).toContain("## Summary");
  expect(body).toContain("## Changes");
  expect(body).toContain("## Testing");
  expect(body).toContain("## Linked Task");
  expect(body).toContain("Closes FN-4991");
}

describe("generatePrMetadata", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "pr-metadata-"));
    mkdirSync(join(repoRoot, ".fusion", "tasks", "FN-4991"), { recursive: true });
    writeFileSync(join(repoRoot, ".fusion", "tasks", "FN-4991", "PROMPT.md"), "# Prompt");
    promptMock.mockResolvedValue(undefined);
    disposeMock.mockReset();
    vi.mocked(createFnAgent).mockImplementation(async ({ onText }: { onText?: (t: string) => void }) => {
      onText?.(JSON.stringify({
        title: "feat: add routes",
        summary: "Summary text",
        changes: "- Change A",
        testing: "- pnpm test",
        linkedTask: "FN-4991",
      }));
      return {
        session: {
          prompt: promptMock,
          dispose: disposeMock,
        },
      } as never;
    });
    setupExec({
      "gh repo view": "main",
      "git log": "commit",
      "git diff --stat": "1 file changed",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("uses the summarizer model lane for PR generation", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
        planningProvider: "openai",
        planningModelId: "gpt-4o",
      } as never,
    });

    expect(vi.mocked(createFnAgent)).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultProvider: "anthropic",
        defaultModelId: "claude-haiku",
      }),
    );
    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
    expect(result.body).toContain("## Testing");
    expect(result.body).toContain("## Linked Task");
    expect(result.templateUsed).toBe(false);
    expect(promptMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("fills known sections when template exists and preserves unknown headings", async () => {
    mkdirSync(join(repoRoot, ".github"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".github", "pull_request_template.md"),
      ["## Summary", "old", "## Unknown", "keep this", "## Testing", "old"].join("\n"),
    );

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      } as never,
    });

    expect(result.templateUsed).toBe(true);
    expect(result.body).toContain("## Unknown");
    expect(result.body).toContain("keep this");
    expect(result.body).toContain("Summary text");
  });

  it("falls back deterministically when model output is invalid json", async () => {
    vi.mocked(createFnAgent).mockImplementation(async ({ onText }: { onText?: (t: string) => void }) => {
      onText?.("not json");
      return {
        session: {
          prompt: promptMock,
          dispose: disposeMock,
        },
      } as never;
    });

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {
        titleSummarizerProvider: "anthropic",
        titleSummarizerModelId: "claude-haiku",
      } as never,
    });

    expect(result).toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    expectFallbackBody(result.body);
  });

  it("returns fallback when createFnAgent times out before a session exists", async () => {
    vi.useFakeTimers();
    vi.mocked(createFnAgent).mockImplementationOnce(() => new Promise(() => undefined) as never);

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
    expect(promptMock).not.toHaveBeenCalled();
    expect(disposeMock).not.toHaveBeenCalled();
  });

  it("returns fallback when prompt times out", async () => {
    vi.useFakeTimers();
    promptMock.mockImplementation(() => new Promise(() => undefined));

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      timeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
  });

  it("returns fallback immediately when caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      signal: controller.signal,
    });

    expect(result).toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    expect(createFnAgent).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("returns fallback when caller aborts mid-generation", async () => {
    const controller = new AbortController();
    vi.mocked(createFnAgent).mockImplementationOnce(() => new Promise(() => undefined) as never);

    const resultPromise = generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
      signal: controller.signal,
    });

    controller.abort();

    await expect(resultPromise).resolves.toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
    const result = await resultPromise;
    expectFallbackBody(result.body);
  });
});
