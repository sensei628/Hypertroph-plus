import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository } from '../src/data/repository';
import {
  addDaysISO,
  dailyRange,
  dailySeries,
  macroEnergySplit,
  mean,
  mondayOf,
  recentWeekStarts,
  shortLabel,
  sumByWeek,
} from '../src/domain/stats';
import { kgToG } from '../src/domain/training';

const require = createRequire(import.meta.url);

let db: Database;
let repo: SqliteRepository;

describe('stats date helpers', () => {
  it('finds the Monday of a week', () => {
    expect(mondayOf('2026-01-07')).toBe('2026-01-05'); // Wed -> Mon
    expect(mondayOf('2026-01-05')).toBe('2026-01-05'); // Mon -> itself
  });

  it('lists consecutive week starts (oldest first)', () => {
    expect(recentWeekStarts(3, '2026-01-07')).toEqual(['2025-12-22', '2025-12-29', '2026-01-05']);
  });

  it('builds an inclusive daily range', () => {
    expect(dailyRange('2026-01-05', '2026-01-07')).toEqual(['2026-01-05', '2026-01-06', '2026-01-07']);
    expect(addDaysISO('2026-01-05', 2)).toBe('2026-01-07');
  });

  it('sums values into week buckets', () => {
    const rows = [
      { date: '2026-01-05', value: 2 },
      { date: '2026-01-07', value: 3 },
      { date: '2025-12-29', value: 5 },
      { date: '2026-01-06', value: 1 },
    ];
    expect(sumByWeek(rows, ['2025-12-29', '2026-01-05'])).toEqual([5, 6]);
  });

  it('aligns per-day values, filling gaps with zero', () => {
    expect(dailySeries('2026-01-05', '2026-01-07', [{ date: '2026-01-06', value: 9 }])).toEqual([
      { date: '2026-01-05', value: 0 },
      { date: '2026-01-06', value: 9 },
      { date: '2026-01-07', value: 0 },
    ]);
  });

  it('averages and splits macro energy', () => {
    expect(mean([])).toBe(0);
    expect(mean([2, 4])).toBe(3);
    expect(macroEnergySplit(100, 50, 200)).toEqual({ protein: 400, fat: 450, carb: 800 });
    expect(shortLabel('2026-01-07')).toBe('1/7');
  });
});

describe('statistics queries', () => {
  beforeAll(async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    db = new SQL.Database();
    db.run(schemaSql);
    db.run(seedSql);
    repo = new SqliteRepository(db);
  });

  it('returns per-day nutrient totals for logged days', () => {
    repo.logFood({ foodId: 'f_greek', quantityG: 170, mealSection: 'breakfast', localDate: '2026-01-05' });
    repo.logFood({ foodId: 'f_oats', quantityG: 50, mealSection: 'breakfast', localDate: '2026-01-06' });

    const days = repo.getNutritionDailySince('2026-01-01');
    expect(days.map((d) => d.localDate).sort()).toEqual(['2026-01-05', '2026-01-06']);

    const d5 = days.find((d) => d.localDate === '2026-01-05')!;
    expect(d5.totalsMilli.get('energy_kcal')).toBeGreaterThan(0);
    expect(d5.totalsMilli.get('protein_g')).toBeGreaterThan(0);

    // A later lower bound excludes earlier days.
    expect(repo.getNutritionDailySince('2026-01-06')).toHaveLength(1);
  });

  it('flattens logged sets and lists logged exercises', () => {
    const workoutId = repo.startWorkout('Stats', '2026-01-05');
    const weId = repo.addExercise(workoutId, 'e_bench');
    repo.logSet(weId, { setType: 'warmup', reps: 10, loadG: kgToG(60), rir: 4, isBodyweight: false });
    repo.logSet(weId, { setType: 'working', reps: 5, loadG: kgToG(100), rir: 2, isBodyweight: false });

    const sets = repo.getTrainingSets();
    const working = sets.filter((s) => s.completed && s.setType === 'working');
    expect(working).toHaveLength(1);
    expect(working[0].exerciseId).toBe('e_bench');
    expect(working[0].loadG).toBe(100000);
    expect(working[0].reps).toBe(5);

    const exercises = repo.listLoggedExercises();
    expect(exercises.map((e) => e.id)).toContain('e_bench');
    expect(exercises.find((e) => e.id === 'e_bench')?.name).toBeTruthy();
  });
});
