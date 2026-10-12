import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import path from 'node:path';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository, type NutritionPlanInput } from '../src/data/repository';
import { toMilli } from '../src/domain/nutrients';
import { computeEnergyPlan, type EnergyInputs } from '../src/domain/energy';

const require = createRequire(import.meta.url);

let db: Database;
let repo: SqliteRepository;

const INPUTS: EnergyInputs = {
  sex: 'male',
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activity: 'moderate',
  goal: 'lose',
  rateKgPerWeek: 0.5,
  proteinPerKg: 1.8,
  fatPerKg: 0.6,
  fatPercent: 0.25,
};

function planInput(over: Partial<EnergyInputs> = {}): NutritionPlanInput {
  const inputs = { ...INPUTS, ...over };
  const r = computeEnergyPlan(inputs);
  return {
    ...inputs,
    bmrKcal: r.bmr,
    tdeeKcal: r.tdee,
    targetKcal: r.targetKcal,
    proteinG: r.proteinG,
    fatG: r.fatG,
    carbG: r.carbG,
  };
}

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  repo = new SqliteRepository(db);
});

describe('nutrition plan persistence', () => {
  it('saves a plan, inactive by default', () => {
    const id = repo.saveNutritionPlan(planInput());
    expect(id).toMatch(/^np_/);
    const plans = repo.listNutritionPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(id);
    expect(plans[0].isActive).toBe(false);
    expect(plans[0].goal).toBe('lose');
    expect(repo.getActiveNutritionPlan()).toBeNull();
  });

  it('applies a plan: marks it active and writes calorie/macro targets', () => {
    const input = planInput();
    const id = repo.saveNutritionPlan(input);
    repo.applyNutritionPlan(id, '2026-10-12');

    const active = repo.getActiveNutritionPlan();
    expect(active?.id).toBe(id);

    const targets = repo.getTargets();
    expect(targets.get('energy_kcal')).toBe(toMilli(input.targetKcal));
    expect(targets.get('protein_g')).toBe(toMilli(input.proteinG));
    expect(targets.get('fat_g')).toBe(toMilli(input.fatG));
    expect(targets.get('carb_g')).toBe(toMilli(input.carbG));
  });

  it('records target history with source "plan" and the effective date', () => {
    const hist = repo.getTargetHistory('energy_kcal');
    expect(hist.length).toBeGreaterThanOrEqual(1);
    const last = hist[hist.length - 1];
    expect(last.source).toBe('plan');
    expect(last.effectiveFrom).toBe('2026-10-12');
  });

  it('keeps only one active plan', () => {
    const first = repo.getActiveNutritionPlan()!;
    const secondInput = planInput({ goal: 'gain', rateKgPerWeek: 0.25 });
    const second = repo.saveNutritionPlan(secondInput);
    repo.applyNutritionPlan(second, '2026-10-13');

    expect(repo.getActiveNutritionPlan()?.id).toBe(second);
    expect(repo.listNutritionPlans().filter((p) => p.isActive)).toHaveLength(1);
    expect(repo.listNutritionPlans().find((p) => p.id === first.id)?.isActive).toBe(false);
  });

  it('does not duplicate history when a target value is unchanged', () => {
    const input = planInput();
    const id = repo.saveNutritionPlan(input);
    repo.applyNutritionPlan(id, '2026-10-14');
    const before = repo.getTargetHistory('energy_kcal').length;
    // re-apply a plan with identical calories/macros
    const id2 = repo.saveNutritionPlan(planInput());
    repo.applyNutritionPlan(id2, '2026-10-15');
    expect(repo.getTargetHistory('energy_kcal').length).toBe(before);
  });

  it('logs a manual override without erasing plan history', () => {
    const before = repo.getTargetHistory('energy_kcal');
    repo.setTarget('energy_kcal', toMilli(2600));
    const after = repo.getTargetHistory('energy_kcal');
    expect(after.length).toBe(before.length + 1);
    expect(after.some((h) => h.source === 'manual')).toBe(true);
    expect(after.some((h) => h.source === 'plan')).toBe(true);
    expect(repo.getTargets().get('energy_kcal')).toBe(toMilli(2600));
  });

  it('deletes a plan', () => {
    const id = repo.saveNutritionPlan(planInput({ goal: 'maintain' }));
    repo.deleteNutritionPlan(id);
    expect(repo.listNutritionPlans().some((p) => p.id === id)).toBe(false);
  });

  it('updates an existing plan in place when given an id', () => {
    const id = repo.saveNutritionPlan(planInput({ weightKg: 80 }));
    const countBefore = repo.listNutritionPlans().length;
    repo.saveNutritionPlan({ ...planInput({ weightKg: 82 }), id });
    expect(repo.listNutritionPlans().length).toBe(countBefore);
    const updated = repo.listNutritionPlans().find((p) => p.id === id)!;
    expect(updated.weightKg).toBe(82);
  });
});
