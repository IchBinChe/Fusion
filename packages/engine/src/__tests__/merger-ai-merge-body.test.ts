import { describe, expect, it, vi } from "vitest";

vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  describeModel: vi.fn(() => "mock-provider/mock-model"),
  promptWithFallback: vi.fn(),
  compactSessionContext: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => ""),
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import {
  composeMergeCommitBody,
  __testOnlyBuildDeterministicMergeMessage as buildDeterministicMergeMessage,
} from "../merger.js";

describe("composeMergeCommitBody", () => {
  const commitLog = "- feat: one";
  const diffStat = "1 file changed";

  it("uses deterministic fallback when AI summary and AI body are absent", () => {
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat })).toBe(
      "Commits merged:\n- feat: one\n\nFiles changed:\n1 file changed",
    );
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat, aiBody: undefined })).toBe(
      "Commits merged:\n- feat: one\n\nFiles changed:\n1 file changed",
    );
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat, aiBody: null })).toBe(
      "Commits merged:\n- feat: one\n\nFiles changed:\n1 file changed",
    );
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat, aiBody: "   " })).toBe(
      "Commits merged:\n- feat: one\n\nFiles changed:\n1 file changed",
    );
  });

  it("combines AI narrative + bullets + files changed", () => {
    expect(composeMergeCommitBody({
      branch: "fusion/FN-1",
      commitLog,
      diffStat,
      aiSummary: "Narrative summary.",
      aiBody: "- bullet one\n- bullet two",
    })).toBe("Narrative summary.\n\n- bullet one\n- bullet two\n\nFiles changed:\n1 file changed");
  });

  it("keeps AI narrative with files changed when bullets are absent", () => {
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat, aiSummary: "Narrative summary." }))
      .toBe("Narrative summary.\n\nFiles changed:\n1 file changed");
  });

  it("keeps AI bullet body with files changed when narrative is absent", () => {
    expect(composeMergeCommitBody({ branch: "fusion/FN-1", commitLog, diffStat, aiBody: "- bullet one" }))
      .toBe("- bullet one\n\nFiles changed:\n1 file changed");
  });
});

describe("buildDeterministicMergeMessage", () => {
  const decodeArg = (arg: string) => arg.replace(/^-m\s+"/, "").replace(/"$/, "").replace(/\\(["\\$`])/g, "$1");

  it("preserves AI body bullets in canonical merge body", async () => {
    const { bodyArg } = await buildDeterministicMergeMessage({
      taskId: "FN-1",
      branch: "fusion/FN-1",
      commitLog: "- feat: one",
      diffStat: "1 file changed",
      includeTaskId: true,
      aiSummary: "Narrative summary.",
      aiBody: "- bullet one\n- bullet two",
      aiSubject: "tighten canonical merge message",
    });
    const body = decodeArg(bodyArg);
    expect(body).toContain("- bullet one\n- bullet two");
    expect(body).toContain("Files changed:\n1 file changed");
  });

  it("falls back deterministically when aiBody is null/empty", async () => {
    for (const aiBody of [undefined, null, "   "] as const) {
      const { bodyArg } = await buildDeterministicMergeMessage({
        taskId: "FN-3",
        branch: "fusion/FN-3",
        commitLog: "- feat: one",
        diffStat: "1 file changed",
        includeTaskId: true,
        aiSummary: "Narrative summary.",
        aiBody,
        aiSubject: "subject",
      });
      expect(decodeArg(bodyArg)).toBe("Narrative summary.\n\nFiles changed:\n1 file changed");
    }
  });

  it("keeps subject behavior unchanged when aiBody is present", async () => {
    const withSubject = await buildDeterministicMergeMessage({
      taskId: "FN-1",
      branch: "fusion/FN-1",
      commitLog: "- feat: one",
      diffStat: "1 file changed",
      includeTaskId: true,
      aiSummary: "Narrative",
      aiBody: "- bullet",
      aiSubject: "custom subject",
    });
    expect(withSubject.subjectArg).toContain("feat(FN-1): custom subject");

    const fallbackSubject = await buildDeterministicMergeMessage({
      taskId: "FN-2",
      branch: "fusion/FN-2",
      commitLog: "",
      diffStat: "",
      includeTaskId: false,
      aiSummary: null,
      aiBody: "- bullet",
      aiSubject: null,
    });
    expect(fallbackSubject.subjectArg).toContain("feat: merge fusion/FN-2");
  });
});
