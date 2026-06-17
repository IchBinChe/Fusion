import { describe, expect, it } from "vitest";
import { formatRelativeTimeAgo } from "../relativeTimeAgo";

describe("formatRelativeTimeAgo", () => {
  const now = Date.parse("2026-06-17T15:40:00.000Z");

  it("formats timestamps under one minute as just now", () => {
    expect(formatRelativeTimeAgo("2026-06-17T15:39:30.000Z", now)).toBe("just now");
  });

  it("formats timestamps under one hour as minutes ago", () => {
    expect(formatRelativeTimeAgo("2026-06-17T15:35:00.000Z", now)).toBe("5m ago");
  });

  it("formats timestamps under one day as hours ago", () => {
    expect(formatRelativeTimeAgo("2026-06-17T13:40:00.000Z", now)).toBe("2h ago");
  });

  it("formats timestamps under seven days as days ago", () => {
    expect(formatRelativeTimeAgo("2026-06-14T15:40:00.000Z", now)).toBe("3d ago");
  });

  it("falls back to a locale date string for older timestamps", () => {
    const iso = "2026-06-01T15:40:00.000Z";
    expect(formatRelativeTimeAgo(iso, now)).toBe(new Date(iso).toLocaleDateString());
  });

  it("returns an empty string for invalid or empty timestamps", () => {
    expect(formatRelativeTimeAgo("", now)).toBe("");
    expect(formatRelativeTimeAgo("not-a-date", now)).toBe("");
  });
});
