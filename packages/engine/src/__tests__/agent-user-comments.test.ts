import { describe, expect, it } from "vitest";
import type { TaskComment } from "@fusion/core";
import { buildUserCommentsPromptSection, selectUserCommentsForAgentContext } from "../agent-user-comments.js";

function comment(overrides: Partial<TaskComment>): TaskComment {
  return {
    id: overrides.id ?? "c1",
    text: overrides.text ?? "Please keep the old API export",
    author: overrides.author ?? "user",
    createdAt: overrides.createdAt ?? "2026-06-21T10:00:00.000Z",
    updatedAt: overrides.updatedAt,
  };
}

describe("agent user comments prompt helper", () => {
  it("returns no comments and no section for undefined comments", () => {
    const selected = selectUserCommentsForAgentContext({});

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("returns no comments and no section for an empty comment array", () => {
    const selected = selectUserCommentsForAgentContext({ comments: [] });

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("filters out agent-authored comments", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "agent-1", author: "agent", text: "internal note" })],
    });

    expect(selected).toEqual([]);
    expect(buildUserCommentsPromptSection(selected)).toBe("");
  });

  it("formats populated user comments with author, timestamp, and text", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [comment({ id: "user-1", text: "Please keep the old API export", createdAt: "2026-06-21T12:34:00.000Z" })],
    });

    const section = buildUserCommentsPromptSection(selected);

    expect(section).toContain("## User Comments");
    expect(section).toContain("**user** — 2026-06-21T12:34:00.000Z");
    expect(section).toContain("> Please keep the old API export");
  });

  it("dedupes duplicate ids", () => {
    const selected = selectUserCommentsForAgentContext({
      comments: [
        comment({ id: "dup", text: "old duplicate", createdAt: "2026-06-21T10:00:00.000Z" }),
        comment({ id: "dup", text: "new duplicate", createdAt: "2026-06-21T11:00:00.000Z" }),
      ],
    });

    const section = buildUserCommentsPromptSection(selected);

    expect(selected).toHaveLength(1);
    expect(section).toContain("new duplicate");
    expect(section).not.toContain("old duplicate");
  });

  it("caps a large history to the newest comments in chronological order", () => {
    const comments = Array.from({ length: 25 }, (_, index) => comment({
      id: `user-${index}`,
      text: `comment ${index}`,
      createdAt: `2026-06-21T10:${String(index).padStart(2, "0")}:00.000Z`,
    }));

    const selected = selectUserCommentsForAgentContext({ comments }, { limit: 3 });
    const section = buildUserCommentsPromptSection(selected);

    expect(selected.map((c) => c.id)).toEqual(["user-22", "user-23", "user-24"]);
    expect(section).not.toContain("comment 21");
    expect(section.indexOf("comment 22")).toBeLessThan(section.indexOf("comment 23"));
    expect(section.indexOf("comment 23")).toBeLessThan(section.indexOf("comment 24"));
  });
});
