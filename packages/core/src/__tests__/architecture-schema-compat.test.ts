import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, getSchemaSqlTableSchemas, MIGRATION_ONLY_TABLE_SCHEMAS } from "../db.js";

function readDbSource(): string {
  return readFileSync(new URL("../db.ts", import.meta.url), "utf8");
}

describe("architecture schema compatibility", () => {
  it("invokes ensureSchemaCompatibility() from init()", () => {
    const source = readDbSource();
    expect(source).toMatch(/private ensureSchemaCompatibility\(options: SchemaCompatibilityOptions = \{\}\): void/);
    expect(source).toMatch(/this\.migrate\(\);\s*[\s\S]*?this\.ensureSchemaCompatibility\([^)]*\);\s*[\s\S]*?this\.ensureRoutinesSchemaCompatibility\([^)]*\);\s*[\s\S]*?this\.ensureInsightRunsSchemaCompatibility\([^)]*\);\s*[\s\S]*?this\.ensureEvalTaskResultsSchemaCompatibility\([^)]*\);/);
  });

  it("restores missing declared columns for SCHEMA_SQL tables", () => {
    const source = readDbSource();
    const versionMatch = source.match(/^const SCHEMA_VERSION = (\d+);/m);
    expect(versionMatch).not.toBeNull();
    const schemaVersion = Number(versionMatch?.[1]);

    const indexedColumnsByTable = new Map<string, Set<string>>();
    for (const match of source.matchAll(/CREATE INDEX IF NOT EXISTS\s+\w+\s+ON\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)/g)) {
      const table = match[1];
      const cols = match[2]
        .split(",")
        .map((column) => column.trim().replace(/\s+(ASC|DESC)$/i, ""));
      const set = indexedColumnsByTable.get(table) ?? new Set<string>();
      cols.forEach((column) => set.add(column));
      indexedColumnsByTable.set(table, set);
    }

    const isSafeToDrop = (definition: string): boolean => {
      const upper = definition.toUpperCase();
      if (upper.includes("PRIMARY KEY")) return false;
      if (upper.includes("NOT NULL") && !upper.includes("DEFAULT")) return false;
      return true;
    };

    for (const [tableName, columns] of getSchemaSqlTableSchemas()) {
      const entries = [...columns.entries()];
      const indexedColumns = indexedColumnsByTable.get(tableName) ?? new Set<string>();
      const removable = entries.find(([name, definition]) => isSafeToDrop(definition) && !indexedColumns.has(name));
      if (!removable) continue;
      const [removedColumnName] = removable;
      const keptColumns = entries.filter(([name]) => name !== removedColumnName);
      const legacyTableSql = keptColumns
        .map(([name, def]) => `  "${name}" ${def}`)
        .join(",\n");

      const fusionDir = mkdtempSync(join(tmpdir(), "kb-schema-compat-"));
      const db = new Database(fusionDir, { inMemory: true });
      db.exec(`CREATE TABLE IF NOT EXISTS __meta (key TEXT PRIMARY KEY, value TEXT)`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (\n${legacyTableSql}\n)`);
      db.exec(`INSERT INTO __meta (key, value) VALUES ('schemaVersion', '${schemaVersion}')`);
      db.exec(`INSERT INTO __meta (key, value) VALUES ('lastModified', '1000')`);

      db.init();

      const actualColumns = new Set(
        (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      expect(
        actualColumns.has(removedColumnName),
        `expected column ${tableName}.${removedColumnName} after init() but it is missing`,
      ).toBe(true);
      db.close();
    }
  });

  it("covers every CREATE TABLE in db.ts via SCHEMA_SQL or MIGRATION_ONLY_TABLE_SCHEMAS", () => {
    const source = readDbSource();
    const discoveredTables = new Set<string>();
    const createTableRegex = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of source.matchAll(createTableRegex)) {
      discoveredTables.add(match[1]);
    }

    // FNXC:WorkflowStepCRUD 2026-06-26-14:00: TRANSIENT migration tables — created by a
    // historical migration and DROPPED by a later one (e.g. `workflow_steps`, created in
    // migration 16, dropped in migration 131) — never reach the final schema, so they must
    // NOT be in SCHEMA_SQL or MIGRATION_ONLY_TABLE_SCHEMAS (which would resurrect them via
    // ensureSchemaCompatibility). Exclude any table that has a `DROP TABLE` in db.ts.
    const droppedTables = new Set<string>();
    for (const match of source.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      droppedTables.add(match[1]);
    }
    for (const dropped of droppedTables) discoveredTables.delete(dropped);

    const coveredTables = new Set<string>([
      ...[...getSchemaSqlTableSchemas().keys()],
      ...Object.keys(MIGRATION_ONLY_TABLE_SCHEMAS),
    ]);

    for (const tableName of discoveredTables) {
      expect(
        coveredTables.has(tableName),
        `Table ${tableName} is created in db.ts but not covered by ensureSchemaCompatibility(). Add it to SCHEMA_SQL or MIGRATION_ONLY_TABLE_SCHEMAS in db.ts.`,
      ).toBe(true);
    }
  });
});
