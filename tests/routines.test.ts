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

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

describe('workout plans: CRUD', () => {
  it('saves a plan and lists it with an exercise count', () => {
    const id = repo.saveRoutine({
      name: 'Push day',
      exercises: [
        { exerciseId: 'e_bench', targetSets: 4, targetReps: '6-8', targetRir: 2 },
        { exerciseId: 'e_ohp', targetSets: 3, targetReps: '8-12', targetRir: 1 },
      ],
    });
    const detail = repo.getRoutine(id);
    expect(detail?.name).toBe('Push day');
    expect(detail?.exercises.map((e) => e.exerciseId)).toEqual(['e_bench', 'e_ohp']);
    expect(detail?.exercises[0].targetSets).toBe(4);
    expect(detail?.exercises[0].targetReps).toBe('6-8');
    expect(detail?.exercises[1].name).toBe('Overhead Press');

    const summary = repo.listRoutines().find((r) => r.id === id);
    expect(summary?.exerciseCount).toBe(2);
  });

  it('updates an existing plan and replaces its exercises in order', () => {
    const id = repo.saveRoutine({ name: 'Leg day', exercises: [{ exerciseId: 'e_squat' }] });
    repo.saveRoutine({
      id,
      name: 'Leg day v2',
      exercises: [{ exerciseId: 'e_rdl' }, { exerciseId: 'e_squat' }],
    });
    const detail = repo.getRoutine(id)!;
    expect(detail.name).toBe('Leg day v2');
    expect(detail.exercises.map((e) => e.exerciseId)).toEqual(['e_rdl', 'e_squat']);
    expect(repo.listRoutines().filter((r) => r.id === id)).toHaveLength(1);
  });

  it('soft-deletes a plan so it disappears from list and get', () => {
    const id = repo.saveRoutine({ name: 'Temp', exercises: [{ exerciseId: 'e_row' }] });
    repo.deleteRoutine(id);
    expect(repo.getRoutine(id)).toBeNull();
    expect(repo.listRoutines().some((r) => r.id === id)).toBe(false);
    const rows = db.exec(`SELECT COUNT(*) FROM routines WHERE id = '${id}'`)[0].values[0][0];
    expect(rows).toBe(1);
  });
});

describe('workout plans: starting a workout', () => {
  it('creates an active workout from a plan, carrying its targets', () => {
    const id = repo.saveRoutine({
      name: 'Pull day',
      exercises: [
        { exerciseId: 'e_pullup', targetSets: 3, targetReps: '8-10', targetRir: 2 },
        { exerciseId: 'e_row', targetSets: 4, targetReps: '8', targetRir: 1 },
      ],
    });
    const DATE = '2026-10-11';
    const woId = repo.startWorkoutFromRoutine(id, DATE);
    expect(woId).toBeTruthy();

    const wo = repo.getActiveWorkout(DATE);
    expect(wo?.name).toBe('Pull day');
    expect(wo?.routineId).toBe(id);
    expect(wo?.exercises.map((e) => e.exerciseId)).toEqual(['e_pullup', 'e_row']);
    expect(wo?.exercises[0].targetSets).toBe(3);
    expect(wo?.exercises[0].targetReps).toBe('8-10');
    expect(wo?.exercises[0].targetRir).toBe(2);
  });

  it('returns null for an unknown plan id', () => {
    expect(repo.startWorkoutFromRoutine('rt_missing', '2026-10-12')).toBeNull();
  });
});

describe('workout plans: last-set prefill hint', () => {
  it('returns the most recent completed working set and ignores warm-ups', () => {
    const DATE = '2026-10-13';
    const woId = repo.startWorkout('Test', DATE);
    const weId = repo.addExercise(woId, 'e_bench');
    repo.logSet(weId, { setType: 'working', reps: 5, loadG: kgToG(100), rir: 2, isBodyweight: false });
    repo.logSet(weId, { setType: 'warmup', reps: 15, loadG: kgToG(40), rir: null, isBodyweight: false });
    expect(repo.getLastSetForExercise('e_bench')).toEqual({ loadG: kgToG(100), reps: 5, rir: 2 });
  });

  it('returns null when the exercise has no completed working set', () => {
    expect(repo.getLastSetForExercise('e_rdl')).toBeNull();
  });
});
