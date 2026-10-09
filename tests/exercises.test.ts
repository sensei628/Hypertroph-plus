import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import exercisesSql from '../db/exercises.sql?raw';
import { SqliteRepository } from '../src/data/repository';

const require = createRequire(import.meta.url);
let db: Database;
let repo: SqliteRepository;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  db.run(exercisesSql);
  repo = new SqliteRepository(db);
});

describe('Free Exercise DB catalogue (Unlicense)', () => {
  it('imports the full catalogue alongside the app-authored seed', () => {
    expect(repo.searchExercises('', 5000).length).toBeGreaterThan(800);
  });

  it('finds imported exercises by name and tags provenance', () => {
    const results = repo.searchExercises('lateral raise', 25);
    expect(results.length).toBeGreaterThan(0);
    const imported = results.find((e) => e.id.startsWith('e_'));
    expect(imported).toBeTruthy();
    expect(imported!.primaryMuscles.length).toBeGreaterThan(0);
  });

  it('maps imported muscle ids to human names', () => {
    const names = repo.getMuscleNames();
    expect(names.get('calves')).toBe('Calves');
    expect(names.get('lats')).toBe('Lats');
  });

  it('is idempotent when the SQL runs twice', () => {
    const before = repo.searchExercises('', 5000).length;
    db.run(exercisesSql);
    expect(repo.searchExercises('', 5000).length).toBe(before);
  });
});
