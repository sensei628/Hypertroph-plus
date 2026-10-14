import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository } from '../src/data/repository';
import { MIGRATIONS } from '../src/data/db';

const require = createRequire(import.meta.url);

function newSqlJs() {
  return initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
}

let db: Database;
let repo: SqliteRepository;

beforeAll(async () => {
  const SQL = await newSqlJs();
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

describe('diet-plan seed data', () => {
  it('seeds the protein sources (and only once)', () => {
    const sources = repo.listProteinSources();
    const names = sources.map((s) => s.name);
    for (const expected of [
      'Egg',
      'Chicken breast',
      'Chicken thigh',
      'Salmon',
      'Tuna',
      'Paneer',
      'Tofu',
      'Soy chunks',
      'Greek yogurt',
      'Lentils, cooked',
      'Whey protein',
    ]) {
      expect(names).toContain(expected);
    }
    expect(sources.every((s) => !s.isCustom)).toBe(true);
  });

  it('seeds the micronutrient reference targets', () => {
    const targets = repo.getMicroTargets();
    const keys = targets.map((t) => t.key);
    for (const expected of [
      'fiber_g',
      'sodium_mg',
      'potassium_mg',
      'calcium_mg',
      'iron_mg',
      'magnesium_mg',
      'zinc_mg',
      'vitamin_a_ug',
      'vitamin_c_mg',
      'vitamin_d_ug',
      'vitamin_b12_ug',
      'folate_ug',
    ]) {
      expect(keys).toContain(expected);
    }
    expect(targets.every((t) => t.userValue === null && t.defaultValue > 0)).toBe(true);
  });
});

describe('diet-plan repository', () => {
  let planId: string;
  let mealId: string;

  it('creates a plan that is inactive until activated', () => {
    planId = repo.createPlan({ name: 'Cut A', mode: 'whole' });
    expect(planId).toMatch(/^dp_/);
    expect(repo.getActivePlan()).toBeNull();
    repo.setActivePlan(planId);
    const active = repo.getActivePlan();
    expect(active?.id).toBe(planId);
    expect(active?.mode).toBe('whole');
    expect(active?.meals).toEqual([]);
  });

  it('upserts a meal with its foods', () => {
    mealId = repo.upsertPlanMeal({
      planId,
      dayOfWeek: 1,
      mealType: 'lunch',
      sortOrder: 0,
      items: [
        { foodId: 'f_chicken', grams: 200 },
        { foodId: 'f_rice', grams: 150 },
      ],
    });
    expect(mealId).toMatch(/^dpm_/);
    const active = repo.getActivePlan();
    expect(active?.meals).toHaveLength(1);
    expect(active?.meals[0].dayOfWeek).toBe(1);
    expect(active?.meals[0].items.map((i) => i.foodId)).toEqual(['f_chicken', 'f_rice']);
    expect(active?.meals[0].items.map((i) => i.grams)).toEqual([200, 150]);
  });

  it('replaces a meal\u2019s items wholesale with setPlanItems', () => {
    repo.setPlanItems(mealId, [{ foodId: 'f_oats', grams: 80 }]);
    const meal = repo.getActivePlan()!.meals[0];
    expect(meal.items).toHaveLength(1);
    expect(meal.items[0].foodId).toBe('f_oats');
    expect(meal.items[0].grams).toBe(80);
  });

  it('rejects an unknown food id', () => {
    expect(() => repo.setPlanItems(mealId, [{ foodId: 'nope', grams: 1 }])).toThrow();
  });

  it('checking a meal logs its foods and unchecking removes them', () => {
    const date = '2026-03-02';
    expect(repo.getDayItems(date)).toHaveLength(0);

    const checked = repo.toggleMealCheck(mealId, date);
    expect(checked).toBe(true);

    const items = repo.getDayItems(date);
    expect(items).toHaveLength(1);
    expect(items[0].mealSection).toBe('lunch');
    expect(items[0].quantityG).toBe(80);
    expect(items[0].nutrients.length).toBeGreaterThan(0);

    const checks = repo.getChecksForDate(date);
    expect(checks).toHaveLength(1);
    expect(checks[0].planMealId).toBe(mealId);
    expect(checks[0].logEntryId).toHaveLength(1);

    const unchecked = repo.toggleMealCheck(mealId, date);
    expect(unchecked).toBe(false);
    expect(repo.getDayItems(date)).toHaveLength(0);
    expect(repo.getChecksForDate(date)).toHaveLength(0);
  });

  it('keeps checks isolated per day', () => {
    repo.toggleMealCheck(mealId, '2026-03-03');
    expect(repo.getChecksForDate('2026-03-03')).toHaveLength(1);
    expect(repo.getChecksForDate('2026-03-04')).toHaveLength(0);
    repo.toggleMealCheck(mealId, '2026-03-03');
  });

  it('adds a custom protein source', () => {
    const before = repo.listProteinSources().length;
    const id = repo.addCustomProteinSource({
      name: 'TVP mince',
      kcal100g: 300,
      protein100g: 50,
      carbs100g: 30,
      fat100g: 1,
    });
    expect(id).toMatch(/^ps_/);
    const after = repo.listProteinSources();
    expect(after).toHaveLength(before + 1);
    expect(after.find((s) => s.id === id)?.isCustom).toBe(true);
  });

  it('saves and resets a micronutrient override', () => {
    repo.saveMicroTarget('fiber_g', 40);
    expect(repo.getMicroTargets().find((t) => t.key === 'fiber_g')?.userValue).toBe(40);
    repo.resetMicroTarget('fiber_g');
    expect(repo.getMicroTargets().find((t) => t.key === 'fiber_g')?.userValue).toBeNull();
  });

  it('clears every override with resetAllMicroTargets', () => {
    repo.saveMicroTarget('fiber_g', 40);
    repo.saveMicroTarget('sodium_mg', 3000);
    repo.resetAllMicroTargets();
    expect(repo.getMicroTargets().every((t) => t.userValue === null)).toBe(true);
  });
});

describe('migration v11 (diet plans)', () => {
  it('adds the tables + seeds on an existing database without data loss', async () => {
    const SQL = await newSqlJs();
    const d = new SQL.Database();
    d.run('CREATE TABLE schema_migrations (version INTEGER, applied_at INTEGER, checksum TEXT)');
    d.run("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (10, 1, 'v10')");
    d.run('CREATE TABLE log_items (id TEXT PRIMARY KEY, meal_section TEXT, is_deleted INTEGER DEFAULT 0)');
    d.run("INSERT INTO log_items VALUES ('keep','lunch',0)");

    const v11 = MIGRATIONS.find((m) => m.version === 11);
    expect(v11).toBeTruthy();
    d.run('BEGIN');
    d.run(v11!.sql);
    d.run('COMMIT');

    const tables = d
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('diet_plan','diet_plan_meal','diet_plan_item','diet_plan_check','protein_source','micronutrient_target')",
      )[0]
      .values.map((r) => r[0]);
    expect(tables.sort()).toEqual([
      'diet_plan',
      'diet_plan_check',
      'diet_plan_item',
      'diet_plan_meal',
      'micronutrient_target',
      'protein_source',
    ]);
    expect(d.exec('SELECT COUNT(*) FROM protein_source')[0].values[0][0]).toBe(11);
    expect(d.exec('SELECT COUNT(*) FROM micronutrient_target')[0].values[0][0]).toBe(12);
    expect(d.exec("SELECT is_deleted FROM log_items WHERE id = 'keep'")[0].values[0][0]).toBe(0);
    expect(d.exec('PRAGMA user_version')[0].values[0][0]).toBe(11);

    // Re-running is a no-op (idempotent seeds).
    d.run(v11!.sql);
    expect(d.exec('SELECT COUNT(*) FROM protein_source')[0].values[0][0]).toBe(11);
  });
});

describe('diet-plan list and delete', () => {
  let r: SqliteRepository;

  beforeAll(async () => {
    const SQL = await newSqlJs();
    const d = new SQL.Database();
    d.run(schemaSql);
    d.run(seedSql);
    r = new SqliteRepository(d);
  });

  it('lists all plans, active first', () => {
    const a = r.createPlan({ name: 'A', mode: 'whole' });
    r.setActivePlan(a);
    r.createPlan({ name: 'B', mode: 'protein' });
    const plans = r.listDietPlans();
    expect(plans.map((p) => p.name)).toEqual(['A', 'B']);
    expect(plans[0].isActive).toBe(true);
    expect(plans[1].isActive).toBe(false);
  });

  it('deletes a single meal and its checks but keeps logged foods', () => {
    const plan = r.getActivePlan()!;
    const mealId = r.upsertPlanMeal({
      planId: plan.id,
      mealType: 'dinner',
      dayOfWeek: null,
      items: [{ foodId: 'f_chicken', grams: 100 }],
    });
    r.toggleMealCheck(mealId, '2026-04-01');
    expect(r.getDayItems('2026-04-01')).toHaveLength(1);
    expect(r.getChecksForDate('2026-04-01')).toHaveLength(1);

    r.deletePlanMeal(mealId);
    expect(r.getActivePlan()!.meals.find((m) => m.id === mealId)).toBeUndefined();
    expect(r.getChecksForDate('2026-04-01')).toHaveLength(0);
    expect(r.getDayItems('2026-04-01')).toHaveLength(1);
  });

  it('deletes a plan with its meals, leaving no active plan', () => {
    const plan = r.getActivePlan()!;
    r.deletePlan(plan.id);
    expect(r.listDietPlans().find((p) => p.id === plan.id)).toBeUndefined();
    expect(r.getActivePlan()).toBeNull();
  });
});

describe('diet-plan protein mode', () => {
  let db: Database;
  let repo: SqliteRepository;
  let planId: string;
  let mealId: string;
  let eggId: string;

  beforeAll(async () => {
    const SQL = await newSqlJs();
    db = new SQL.Database();
    db.run(schemaSql);
    db.run(seedSql);
    repo = new SqliteRepository(db);
    eggId = repo.listProteinSources().find((s) => s.name === 'Egg')!.id;
    planId = repo.createPlan({ name: 'Protein', mode: 'protein' });
    repo.setActivePlan(planId);
    mealId = repo.upsertPlanMeal({ planId, mealType: 'breakfast', dayOfWeek: null });
  });

  it('creates and reads a plan in protein mode', () => {
    expect(repo.getActivePlan()!.mode).toBe('protein');
  });

  it('switches modes with setPlanMode', () => {
    repo.setPlanMode(planId, 'whole');
    expect(repo.getActivePlan()!.mode).toBe('whole');
    repo.setPlanMode(planId, 'protein');
    expect(repo.getActivePlan()!.mode).toBe('protein');
  });

  it('stores protein sources for a meal and returns them in order', () => {
    repo.setPlanProteinItems(mealId, [
      { sourceId: eggId, grams: 100 },
      { sourceId: eggId, grams: 50 },
    ]);
    const meal = repo.getActivePlan()!.meals.find((m) => m.id === mealId)!;
    expect(meal.proteinItems.map((i) => i.grams)).toEqual([100, 50]);
    expect(meal.proteinItems.every((i) => i.proteinSourceId === eggId)).toBe(true);
  });

  it('replaces protein items wholesale and supports removal', () => {
    repo.setPlanProteinItems(mealId, [{ sourceId: eggId, grams: 150 }]);
    let meal = repo.getActivePlan()!.meals.find((m) => m.id === mealId)!;
    expect(meal.proteinItems).toHaveLength(1);
    expect(meal.proteinItems[0].grams).toBe(150);

    repo.setPlanProteinItems(mealId, []);
    meal = repo.getActivePlan()!.meals.find((m) => m.id === mealId)!;
    expect(meal.proteinItems).toHaveLength(0);
  });

  it('rejects an unknown protein source id', () => {
    expect(() => repo.setPlanProteinItems(mealId, [{ sourceId: 'nope', grams: 1 }])).toThrow(
      /Unknown protein source/,
    );
  });

  it('removes protein items when the meal is deleted', () => {
    repo.setPlanProteinItems(mealId, [{ sourceId: eggId, grams: 100 }]);
    repo.deletePlanMeal(mealId);
    const remaining = db.exec('SELECT COUNT(*) FROM diet_plan_protein_item')[0].values[0][0];
    expect(remaining).toBe(0);
  });
});

describe('migration v12 (diet protein items)', () => {
  it('adds the table on an existing database and is idempotent', async () => {
    const SQL = await newSqlJs();
    const d = new SQL.Database();
    d.run('CREATE TABLE schema_migrations (version INTEGER, applied_at INTEGER, checksum TEXT)');
    d.run("INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (11, 1, 'v11')");
    d.run('CREATE TABLE diet_plan_meal (id TEXT PRIMARY KEY)');

    const v12 = MIGRATIONS.find((m) => m.version === 12);
    expect(v12).toBeTruthy();
    d.run('BEGIN');
    d.run(v12!.sql);
    d.run('COMMIT');

    const tables = d
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'diet_plan_protein_item'")[0]
      .values;
    expect(tables).toHaveLength(1);
    expect(d.exec('PRAGMA user_version')[0].values[0][0]).toBe(12);

    d.run(v12!.sql);
    expect(d.exec('PRAGMA user_version')[0].values[0][0]).toBe(12);
  });
});
