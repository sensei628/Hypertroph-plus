import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { inspectBackup } from '../src/data/backup';

const require = createRequire(import.meta.url);

function locate(file: string): string {
  return path.join(path.dirname(require.resolve('sql.js')), file);
}

let validBytes: Uint8Array;

beforeAll(async () => {
  const SQL = await initSqlJs({ locateFile: locate });
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
    const SQL = await initSqlJs({ locateFile: locate });
    const db: Database = new SQL.Database();
    db.run('CREATE TABLE unrelated (id INTEGER)');
    const bytes = db.export();
    const report = await inspectBackup(bytes);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('log_items');
  });
});
