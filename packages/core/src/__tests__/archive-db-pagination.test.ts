import { describe, expect, it } from "vitest";
import { ArchiveDatabase } from "../archive-db.js";
import type { ArchivedTaskEntry } from "../types.js";

/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * Covers the FN-7659 invariant: the archived read path must return rows
 * ordered `archivedAt DESC` and support bounded `LIMIT/OFFSET` windowing
 * so the dashboard never loads the whole archive in a single pass.
 */
function makeEntry(id: string, archivedAt: string): ArchivedTaskEntry {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    comments: [],
    createdAt: archivedAt,
    updatedAt: archivedAt,
    archivedAt,
    columnMovedAt: archivedAt,
  } as unknown as ArchivedTaskEntry;
}

describe("ArchiveDatabase.listPage", () => {
  it("returns [] and total 0 for an empty archive", () => {
    const db = new ArchiveDatabase("/tmp/fusion-archive-page-empty", { inMemory: true });
    db.init();
    expect(db.listPage(100, 0)).toEqual([]);
    expect(db.getArchivedRowCount()).toBe(0);
  });

  it("orders results by archivedAt DESC (newest first)", () => {
    const db = new ArchiveDatabase("/tmp/fusion-archive-page-order", { inMemory: true });
    db.init();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      db.upsert(makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    const page = db.listPage(100, 0);
    expect(page.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `FN-${9 - i}`),
    );
  });

  it("windows correctly with LIMIT/OFFSET across page boundaries", () => {
    const db = new ArchiveDatabase("/tmp/fusion-archive-page-windows", { inMemory: true });
    db.init();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const total = 250;
    for (let i = 0; i < total; i++) {
      db.upsert(makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(db.getArchivedRowCount()).toBe(total);

    const page1 = db.listPage(100, 0);
    const page2 = db.listPage(100, 100);
    const page3 = db.listPage(100, 200);

    expect(page1).toHaveLength(100);
    expect(page2).toHaveLength(100);
    expect(page3).toHaveLength(50);

    // Newest first: FN-249 is the last-archived (highest archivedAt).
    expect(page1[0]!.id).toBe("FN-249");
    expect(page1[99]!.id).toBe("FN-150");
    expect(page2[0]!.id).toBe("FN-149");
    expect(page2[99]!.id).toBe("FN-50");
    expect(page3[0]!.id).toBe("FN-49");
    expect(page3[49]!.id).toBe("FN-0");

    // No duplicates/gaps across the concatenated pages.
    const allIds = [...page1, ...page2, ...page3].map((e) => e.id);
    expect(new Set(allIds).size).toBe(total);
  });

  it("handles the exact page-boundary cases (total === 100 and 101)", () => {
    const db100 = new ArchiveDatabase("/tmp/fusion-archive-page-100", { inMemory: true });
    db100.init();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 100; i++) {
      db100.upsert(makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(db100.listPage(100, 0)).toHaveLength(100);
    expect(db100.listPage(100, 100)).toHaveLength(0);

    const db101 = new ArchiveDatabase("/tmp/fusion-archive-page-101", { inMemory: true });
    db101.init();
    for (let i = 0; i < 101; i++) {
      db101.upsert(makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(db101.listPage(100, 0)).toHaveLength(100);
    expect(db101.listPage(100, 100)).toHaveLength(1);
  });
});
