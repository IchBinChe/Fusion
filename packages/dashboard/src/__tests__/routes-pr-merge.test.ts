import { describe, expect, it } from "vitest";

import { resolvePrMergeMethod } from "../routes/register-git-github.js";

describe("resolvePrMergeMethod", () => {
  it("prefers explicit request method", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, { autoMergeStrategy: "squash" }, "merge")).toBe("merge");
  });

  it("falls back to pr auto strategy", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, { autoMergeStrategy: "squash" })).toBe("squash");
  });

  it("maps settings strategy", () => {
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-rebase" }, null)).toBe("rebase");
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "always-squash" }, null)).toBe("squash");
    expect(resolvePrMergeMethod({ directMergeCommitStrategy: "auto" }, null)).toBe("squash");
  });

  it("hard-falls back to squash", () => {
    expect(resolvePrMergeMethod(undefined, undefined)).toBe("squash");
  });
});
