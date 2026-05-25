import { describe, expect, it, vi } from "vitest";
import { Database, SCHEMA_COMPAT_FINGERPRINT } from "../db.js";

function createInMemoryDatabase(): Database {
  return new Database("/tmp/fn-db-init-perf", { inMemory: true });
}

function getMetaValue(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM __meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function getColumnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

describe("Database.init() schema compatibility performance", () => {
  it("writes schemaCompatFingerprint to __meta for a fresh database", () => {
    const db = createInMemoryDatabase();

    try {
      db.init();

      expect(getMetaValue(db, "schemaCompatFingerprint")).toBe(SCHEMA_COMPAT_FINGERPRINT);
    } finally {
      db.close();
    }
  });

  it("skips ALTER TABLE work and keeps PRAGMA table_info calls under a strict ceiling on unchanged-schema re-init", () => {
    const db = createInMemoryDatabase();

    try {
      db.init();

      const execSpy = vi.spyOn((db as any).db, "exec");
      const prepareSpy = vi.spyOn((db as any).db, "prepare");

      db.init();

      const alterTableStatements = execSpy.mock.calls.filter(([sql]) => sql.includes("ALTER TABLE"));
      expect(alterTableStatements).toHaveLength(0);

      const pragmaTableInfoCalls = prepareSpy.mock.calls.filter(([sql]) => sql.includes("PRAGMA table_info("));
      // Current-schema re-init may probe tasks metadata a few times via legacy
      // migration guards; the fingerprint hit should still prevent broad sweeps.
      expect(pragmaTableInfoCalls.length).toBeLessThanOrEqual(5);
    } finally {
      db.close();
    }
  });

  it("restores a missing declared column when the fingerprint is absent", () => {
    const db = createInMemoryDatabase();

    try {
      db.init();
      db.exec("ALTER TABLE tasks DROP COLUMN modifiedFiles");
      db.exec("DELETE FROM __meta WHERE key = 'schemaCompatFingerprint'");

      expect(getColumnNames(db, "tasks")).not.toContain("modifiedFiles");

      db.init();

      expect(getColumnNames(db, "tasks")).toContain("modifiedFiles");
      expect(getMetaValue(db, "schemaCompatFingerprint")).toBe(SCHEMA_COMPAT_FINGERPRINT);
    } finally {
      db.close();
    }
  });

  it("restores a missing declared column when the fingerprint is stale", () => {
    const db = createInMemoryDatabase();

    try {
      db.init();
      db.exec("ALTER TABLE tasks DROP COLUMN modifiedFiles");
      db.exec("INSERT OR REPLACE INTO __meta (key, value) VALUES ('schemaCompatFingerprint', 'stale-fingerprint')");

      expect(getColumnNames(db, "tasks")).not.toContain("modifiedFiles");

      db.init();

      expect(getColumnNames(db, "tasks")).toContain("modifiedFiles");
      expect(getMetaValue(db, "schemaCompatFingerprint")).toBe(SCHEMA_COMPAT_FINGERPRINT);
    } finally {
      db.close();
    }
  });

  it("keeps repeated unchanged-schema init() calls comfortably below the coarse perf guard", () => {
    const db = createInMemoryDatabase();

    try {
      db.init();

      const durationsMs: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        const startedAt = process.hrtime.bigint();
        db.init();
        const endedAt = process.hrtime.bigint();
        durationsMs.push(Number(endedAt - startedAt) / 1_000_000);
      }

      // Coarse local/CI-safe guard: unchanged-schema re-init should stay well below
      // tens of milliseconds once the fingerprint short-circuits reconciliation.
      expect(median(durationsMs)).toBeLessThan(50);
    } finally {
      db.close();
    }
  });
});
