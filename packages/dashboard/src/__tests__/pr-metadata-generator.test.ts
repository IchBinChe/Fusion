import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";

const { execMock, promptMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  promptMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
}));

vi.mock("@fusion/engine", () => ({
  listCliAdapterDescriptors: () => [],
  createFnAgent: vi.fn(async () => ({
    session: {
      prompt: promptMock,
      dispose: vi.fn(),
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

describe("generatePrMetadata", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "pr-metadata-"));
    mkdirSync(join(repoRoot, ".fusion", "tasks", "FN-4991"), { recursive: true });
    writeFileSync(join(repoRoot, ".fusion", "tasks", "FN-4991", "PROMPT.md"), "# Prompt");
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
          dispose: vi.fn(),
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
    vi.clearAllMocks();
  });

  it("returns generated body without template", async () => {
    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
    });

    expect(result.title).toBe("feat: add routes");
    expect(result.body).toContain("## Summary");
    expect(result.body).toContain("## Changes");
    expect(result.body).toContain("## Testing");
    expect(result.body).toContain("## Linked Task");
    expect(result.templateUsed).toBe(false);
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
      settings: {} as never,
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
          dispose: vi.fn(),
        },
      } as never;
    });

    const result = await generatePrMetadata({
      task: createTask(),
      repoRoot,
      settings: {} as never,
    });

    expect(result).toEqual({
      title: "Route contracts",
      body: expect.stringContaining("Closes FN-4991"),
      templateUsed: false,
    });
  });
});
