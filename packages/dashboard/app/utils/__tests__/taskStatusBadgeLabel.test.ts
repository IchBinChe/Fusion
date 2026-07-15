import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { getTaskStatusBadgeLabel } from "../taskStatusBadgeLabel";

const t = ((key: string, fallback?: string) => fallback ?? key) as TFunction<"app">;

describe("getTaskStatusBadgeLabel", () => {
  it("maps the full AI merge pipeline to Merging…", () => {
    for (const status of ["merging", "merging-pr", "reviewing", "landing"]) {
      expect(getTaskStatusBadgeLabel(status, t)).toBe("Merging…");
    }
  });

  it("keeps merging-fix distinct", () => {
    expect(getTaskStatusBadgeLabel("merging-fix", t)).toBe("Merging fixes…");
  });

  it("passes through non-merge statuses", () => {
    expect(getTaskStatusBadgeLabel("planning", t)).toBe("planning");
    expect(getTaskStatusBadgeLabel("failed", t)).toBe("failed");
    expect(getTaskStatusBadgeLabel(null, t)).toBe("");
  });
});
