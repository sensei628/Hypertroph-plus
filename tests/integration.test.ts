import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository } from '../src/data/repository';
import { sumNutrients } from '../src/domain/nutrition';
import { kgToG } from '../src/domain/training';

const require = createRequire(import.meta.url);

let db: Database;
let repo: SqliteRepository;
const DATE = '2026-10-09';

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

describe('schema, seed & search', () => {
  it('loads the schema and seed data', () => {
    expect(repo.getNutrientDefs().length).toBe(7);
    expect(repo.searchFoods('').length).toBeGreaterThanOrEqual(7);
  });

  it('finds foods by name', () => {
    const results = repo.searchFoods('oat');
    expect(results[0]?.id).toBe('f_oats');
  });

  it('finds foods by alias', () => {
    const results = repo.searchFoods('oatmeal');
    expect(results.some((f) => f.id === 'f_oats')).toBe(true);
  });

  it('finds exercises by alias', () => {
    const results = repo.searchExercises('ohp');
    expect(results.some((e) => e.id === 'e_ohp')).toBe(true);
  });

  it('carries provenance and preparation state on foods', () => {
    const food = repo.getFood('f_chicken');
    expect(food?.prepState).toBe('cooked');
    expect(food?.sourceId).toBe('s_app');
    expect(food?.quality).toBe('derived');
  });
});

describe('logging with snapshots', () => {
  it('logs a food by grams and computes the daily total', () => {
    repo.logFood({ foodId: 'f_greek', quantityG: 170, mealSection: 'breakfast', localDate: DATE });
    const items = repo.getDayItems(DATE);
    expect(items.length).toBe(1);
    const totals = sumNutrients(
      items.map((r) => ({ foodId: null, label: r.label, quantityG: r.quantityG, nutrients: r.nutrients })),
    );
    expect(totals.get('energy_kcal')?.sumMilli).toBe(124100); // 73 kcal/100g * 170g
  });

  it('flags partial data for a food with an unknown nutrient, never zero', () => {
    repo.logFood({ foodId: 'f_chicken', quantityG: 100, mealSection: 'dinner', localDate: DATE });
    const chicken = repo.getDayItems(DATE).find((i) => i.label.startsWith('Chicken'));
    expect(chicken).toBeTruthy();
    const fiber = chicken!.nutrients.find((n) => n.nutrientId === 'fiber_g');
    expect(fiber?.amountMilli).toBeNull();
    expect(fiber?.wasUnknown).toBe(true);
  });

  it('does not change logged snapshots when the source food is edited', () => {
    const before = repo.getDayItems(DATE).find((i) => i.label.startsWith('Greek'))!.nutrients.find(
      (n) => n.nutrientId === 'energy_kcal',
    )!.amountMilli;
    db.run("UPDATE food_nutrients SET amount_milli = 99000 WHERE food_id = 'f_greek' AND nutrient_id = 'energy_kcal'");
    const after = repo.getDayItems(DATE).find((i) => i.label.startsWith('Greek'))!.nutrients.find(
      (n) => n.nutrientId === 'energy_kcal',
    )!.amountMilli;
    expect(after).toBe(before);
  });
});

describe('custom meals', () => {
  it('accepts user-defined meal sections and surfaces them', () => {
    repo.logFood({ foodId: 'f_chicken', quantityG: 100, mealSection: 'late-night snack', localDate: DATE });
    expect(repo.getUsedMealSections()).toContain('late-night snack');
    const rows = db.exec("SELECT COUNT(*) FROM log_items WHERE meal_section = 'late-night snack'")[0].values[0][0];
    expect(rows).toBe(1);
  });

  it('persists the meal list round-trip through preferences', () => {
    repo.setPreference('meals', ['breakfast', 'lunch', 'dinner', 'snack']);
    expect(JSON.parse(repo.getPreference('meals', ''))).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
  });
});

describe('training, PRs and volume', () => {
  it('logs a workout, detects a PR, and reports weekly volume', () => {
    const workoutId = repo.startWorkout('Push', DATE);
    const weId = repo.addExercise(workoutId, 'e_bench');
    const { prs } = repo.logSet(weId, {
      setType: 'working',
      reps: 5,
      loadG: kgToG(100),
      rir: 2,
      isBodyweight: false,
    });
    expect(prs).toContain('e1rm');
    repo.logSet(weId, { setType: 'warmup', reps: 10, loadG: kgToG(60), rir: null, isBodyweight: false });
    repo.finishWorkout(workoutId);

    const vol = repo.getWeeklyVolume(DATE, DATE, 0.5);
    expect(vol.get('chest')).toBe(1); // only the working set counts
    expect(vol.get('triceps')).toBe(0.5);
  });
});
