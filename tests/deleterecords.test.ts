import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository } from '../src/data/repository';
import { kgToG } from '../src/domain/training';

const require = createRequire(import.meta.url);

let db: Database;
let repo: SqliteRepository;

const D1 = '2026-01-02';
const D2 = '2026-01-05';
const D3 = '2026-01-08';

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

function count(table: string): number {
  return db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0] as number;
}

describe('record stats', () => {
  it('reports counts and spans per scope, empty at first', () => {
    const stats = repo.getRecordStats();
    expect(stats).toEqual({
      nutrition: { count: 0, firstDate: null, lastDate: null },
      training: { count: 0, firstDate: null, lastDate: null },
      body: { count: 0, firstDate: null, lastDate: null },
    });
  });
});

describe('nutrition log deletion', () => {
  it('deletes log entries on a specific date, keeping others', () => {
    repo.logFood({ foodId: 'f_greek', quantityG: 100, mealSection: 'breakfast', localDate: D1 });
    repo.logFood({ foodId: 'f_oats', quantityG: 100, mealSection: 'breakfast', localDate: D2 });
    repo.logFood({ foodId: 'f_oats', quantityG: 100, mealSection: 'dinner', localDate: D2 });
    repo.logFood({ foodId: 'f_chicken', quantityG: 100, mealSection: 'dinner', localDate: D3 });

    expect(repo.countRecords('nutrition', 'on', D2)).toBe(2);
    const n = repo.deleteRecords('nutrition', 'on', D2);
    expect(n).toBe(2);
    expect(repo.countRecords('nutrition', 'all')).toBe(2);
    expect(repo.getDayItems(D1)).toHaveLength(1);
    expect(repo.getDayItems(D2)).toHaveLength(0);
  });

  it('deletes everything before a date (from the beginning)', () => {
    expect(repo.countRecords('nutrition', 'before', D3)).toBe(1);
    const n = repo.deleteRecords('nutrition', 'before', D3);
    expect(n).toBe(1);
    expect(repo.countRecords('nutrition', 'all')).toBe(1);
  });

  it('cleans up empty log_days rows', () => {
    expect(count('log_days')).toBe(1); // only D3 remains
  });

  it('deletes only the most recent entry', () => {
    repo.logFood({ foodId: 'f_greek', quantityG: 100, mealSection: 'breakfast', localDate: D1 });
    expect(repo.countRecords('nutrition', 'last')).toBe(1);
    const n = repo.deleteRecords('nutrition', 'last');
    expect(n).toBe(1);
    expect(repo.countRecords('nutrition', 'all')).toBe(1);
    expect(repo.getDayItems(D3)).toHaveLength(1); // latest record was D3
    expect(repo.getDayItems(D1)).toHaveLength(0);
  });

  it('erases all nutrition entries', () => {
    const n = repo.deleteRecords('nutrition', 'all');
    expect(n).toBe(1);
    expect(repo.countRecords('nutrition', 'all')).toBe(0);
    expect(count('log_items')).toBe(0);
    expect(count('log_item_nutrients')).toBe(0);
  });
});

describe('training deletion', () => {
  it('deletes workouts on a date together with their sets and PRs', () => {
    const w1 = repo.startWorkout('Push', D1);
    const we1 = repo.addExercise(w1, 'e_bench');
    repo.logSet(we1, { setType: 'working', reps: 5, loadG: kgToG(100), rir: 2, isBodyweight: false });
    repo.finishWorkout(w1);

    const w2 = repo.startWorkout('Push', D2);
    const we2 = repo.addExercise(w2, 'e_bench');
    repo.logSet(we2, { setType: 'working', reps: 5, loadG: kgToG(100), rir: 2, isBodyweight: false });
    repo.finishWorkout(w2);

    expect(repo.countRecords('training', 'on', D1)).toBe(1);
    const n = repo.deleteRecords('training', 'on', D1);
    expect(n).toBe(1);
    expect(repo.countRecords('training', 'on', D1)).toBe(0);
    expect(repo.countRecords('training', 'all')).toBe(1);
    expect(count('sets')).toBe(1);
    expect(
      db.exec(
        `SELECT COUNT(*) FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id JOIN workouts w ON w.id = we.workout_id WHERE w.local_date = '${D1}'`,
      )[0].values[0][0],
    ).toBe(0);
  });

  it('deletes the most recent workout', () => {
    const n = repo.deleteRecords('training', 'last');
    expect(n).toBe(1);
    expect(repo.countRecords('training', 'all')).toBe(0);
  });
});

describe('body metric deletion', () => {
  it('deletes metrics before a date and erases all', () => {
    repo.addBodyMetric({ metricType: 'weight_kg', value: 78.2, localDate: D1 });
    repo.addBodyMetric({ metricType: 'weight_kg', value: 77.9, localDate: D2 });

    const n = repo.deleteRecords('body', 'before', D2);
    expect(n).toBe(1);
    expect(repo.countRecords('body', 'all')).toBe(1);

    expect(repo.deleteRecords('body', 'all')).toBe(1);
    expect(repo.countRecords('body', 'all')).toBe(0);
  });
});