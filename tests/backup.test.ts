import { describe, it, expect, beforeAll, vi } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { inspectBackup, importBackup, importSqlBackup, buildAiPrompt } from '../src/data/backup';
import { migrateToLatest, LATEST_SCHEMA_VERSION } from '../src/data/db';
import { storage } from '../src/data/storage';

const require = createRequire(import.meta.url);

function locate(file: string): string {
  return path.join(path.dirname(require.resolve('sql.js')), file);
}

let SQL: SqlJsStatic;
let validBytes: Uint8Array;

function freshImage(fn?: (db: Database) => void): Uint8Array {
  const db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  fn?.(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: locate });
  const db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  validBytes = db.export();
});

describe('backup validation (offline restore safety)', () => {
  it('accepts a real hypertroph+ database image', async () => {
    const report = await inspectBackup(validBytes);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(report.tables).toContain('log_items');
  });

  it('rejects a non-SQLite file before it can overwrite data', async () => {
    const junk = new Uint8Array(200);
    junk.fill(65);
    const report = await inspectBackup(junk);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/sqlite/i);
  });

  it('rejects a file too small to be a database', async () => {
    const report = await inspectBackup(new Uint8Array([1, 2, 3]));
    expect(report.ok).toBe(false);
  });

  it('rejects a valid SQLite file that is not one of our backups', async () => {
    const db: Database = new SQL.Database();
    db.run('CREATE TABLE unrelated (id INTEGER)');
    const bytes = db.export();
    const report = await inspectBackup(bytes);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('log_items');
  });
});

describe('backup versioning', () => {
  it('flags older backups as needing migration and upgrades them', async () => {
    const report = await inspectBackup(freshImage());
    expect(report.ok).toBe(true);
    expect(report.willMigrate).toBe(true);
    // The diet tables are added by migration, so they pass validation.
    expect(report.missing).toEqual([]);
  });

  it('refuses a backup from a newer app version', async () => {
    const bytes = freshImage((db) => db.run('PRAGMA user_version = 999'));
    const report = await inspectBackup(bytes);
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/newer/i);
  });
});

describe('backup import modes', () => {
  it('merges new records and skips duplicates on a second import', async () => {
    const save = vi.spyOn(storage, 'save').mockImplementation(() => {});
    try {
      const current = freshImage();
      const imported = freshImage((db) => {
        db.run(
          "INSERT INTO workouts (id, name, started_at, local_date, created_at) VALUES ('wo_x','Imported session',1,'2026-02-02',1)",
        );
      });

      const first = await importBackup(imported, 'merge', current);
      expect(first.ok).toBe(true);
      expect(first.inserted).toBeGreaterThanOrEqual(1);
      expect(save).toHaveBeenCalled();

      const mergedBytes = save.mock.calls[0][0] as Uint8Array;
      const second = await importBackup(imported, 'merge', mergedBytes);
      expect(second.ok).toBe(true);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBeGreaterThanOrEqual(1);
    } finally {
      save.mockRestore();
    }
  });

  it('reports a failure and writes nothing for an invalid file', async () => {
    const save = vi.spyOn(storage, 'save').mockImplementation(() => {});
    try {
      const junk = new Uint8Array(300);
      junk.fill(66);
      const report = await importBackup(junk, 'replace', freshImage());
      expect(report.ok).toBe(false);
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });
});

describe('SQL script import', () => {
  const script = () => `${schemaSql}\n${seedSql}\nPRAGMA user_version = ${LATEST_SCHEMA_VERSION};`;

  it('imports a valid .sql script through the same pipeline', async () => {
    const save = vi.spyOn(storage, 'save').mockImplementation(() => {});
    try {
      const report = await importSqlBackup(script(), 'replace', freshImage());
      expect(report.ok).toBe(true);
      expect(save).toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it('rejects malformed SQL without writing', async () => {
    const save = vi.spyOn(storage, 'save').mockImplementation(() => {});
    try {
      const report = await importSqlBackup('CREATE TABLE oops (;', 'replace', freshImage());
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/invalid sql/i);
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });
});

describe('AI prompt builder', () => {
  it('embeds the live schema, version and the required closing line', () => {
    const db = new SQL.Database();
    db.run(schemaSql);
    db.run(seedSql);
    migrateToLatest(db);

    const prompt = buildAiPrompt(db);
    expect(prompt).toContain('CREATE TABLE');
    expect(prompt).toContain(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    expect(prompt).toContain('INSERT INTO');
    expect(
      prompt.trimEnd().endsWith('create a .sqlite file with this exact schema containing my meal plan: <describe your needs>'),
    ).toBe(true);
    db.close();
  });
});
