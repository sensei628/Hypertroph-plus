import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository, REF_CATEGORY_TO_FOOD_TYPE } from '../src/data/repository';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refFile = path.join(repoRoot, 'build', 'hypertroph-ref.sqlite');
const hasRef = fs.existsSync(refFile);

let db: Database;
let ref: Database | null;
let repo: SqliteRepository;

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
  });
  db = new SQL.Database();
  db.run(schemaSql);
  db.run(seedSql);
  ref = hasRef ? new SQL.Database(new Uint8Array(fs.readFileSync(refFile))) : null;
  repo = new SqliteRepository(db, ref);
});

describe('food taxonomy facets', () => {
  it('classifies seed foods by type and entry kind', () => {
    const oats = repo.searchFoods('oats', 5).find((f) => f.id === 'f_oats')!;
    expect(oats.foodTypeId).toBe('grains');
    expect(oats.entryType).toBe('generic');
    const chicken = repo.searchFoods('chicken breast', 5).find((f) => f.id === 'f_chicken')!;
    expect(chicken.foodTypeId).toBe('meat');
    expect(chicken.prepState).toBe('cooked');
  });

  it('filters local foods by food type, entry kind, prep state', () => {
    expect(repo.searchFoods('', 50, { foodTypeId: 'grains' }).some((f) => f.id === 'f_oats')).toBe(true);
    expect(repo.searchFoods('', 50, { foodTypeId: 'grains' }).some((f) => f.id === 'f_chicken')).toBe(false);
    expect(repo.searchFoods('', 50, { entryType: 'generic' }).every((f) => f.entryType === 'generic')).toBe(true);
    expect(repo.searchFoods('', 50, { prepState: 'cooked' }).some((f) => f.id === 'f_chicken')).toBe(true);
    expect(repo.searchFoods('', 50, { prepState: 'cooked' }).some((f) => f.id === 'f_oats')).toBe(false);
  });

  it('custom foods are entry type custom and facet counts include zeros', () => {
    repo.createCustomFood('Test Bar', [
      { nutrientId: 'energy_kcal', amountMilli: 200000 },
      { nutrientId: 'protein_g', amountMilli: 20000 },
    ]);
    const hit = repo.searchFoods('test bar', 5).find((f) => f.name === 'Test Bar')!;
    expect(hit.entryType).toBe('custom');
    const facets = repo.getFoodFacets('');
    const custom = facets.entryTypes.find((f) => f.id === 'custom')!;
    expect(custom.count).toBeGreaterThanOrEqual(1);
    // Branded is a supported but empty facet (kept visible, never inferred).
    const branded = facets.entryTypes.find((f) => f.id === 'branded')!;
    expect(branded).toBeTruthy();
    expect(branded.count).toBe(0);
  });
});

describe('exercise taxonomy facets', () => {
  it('filters exercises by category', () => {
    const res = repo.searchExercises('', 50, { categoryId: 'resistance' });
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((e) => e.categoryId === 'resistance')).toBe(true);
    expect(res.some((e) => e.id === 'e_bench')).toBe(true);
    // A supported-but-empty category is a valid query result.
    expect(repo.searchExercises('', 50, { categoryId: 'stretching' })).toEqual([]);
  });

  it('filters exercises by equipment and muscle', () => {
    const barbell = repo.searchExercises('', 50, { equipmentId: 'barbell' });
    expect(barbell.some((e) => e.id === 'e_bench')).toBe(true);
    expect(barbell.some((e) => e.id === 'e_latraise')).toBe(false);
    const chest = repo.searchExercises('', 50, { muscleId: 'chest' });
    expect(chest.some((e) => e.id === 'e_bench')).toBe(true);
  });

  it('reports exercise facet counts for the vocabulary', () => {
    const facets = repo.getExerciseFacets('');
    // Seed-only DB: every exercise is app-authored resistance work.
    const resistance = facets.categories.find((c) => c.id === 'resistance')!;
    expect(resistance.count).toBeGreaterThanOrEqual(9);
    const cardio = facets.categories.find((c) => c.id === 'cardio')!;
    expect(cardio.count).toBe(0); // legitimate empty facet, kept visible
  });
});

describe('favorites and recent uses', () => {
  it('toggles favorites and lists them', () => {
    repo.toggleFavorite('food', 'f_oats');
    expect(repo.favoriteIds('food').has('f_oats')).toBe(true);
    repo.toggleFavorite('food', 'f_oats');
    expect(repo.favoriteIds('food').has('f_oats')).toBe(false);
    repo.toggleFavorite('exercise', 'e_bench');
    expect(repo.favoriteIds('exercise').has('e_bench')).toBe(true);
  });

  it('tracks recent uses on log food and add exercise', () => {
    repo.logFood({ foodId: 'f_berry', quantityG: 100, mealSection: 'breakfast', localDate: '2026-10-10' });
    expect(repo.recentUses('food')).toContain('f_berry');
    const wo = repo.startWorkout('W', '2026-10-10');
    repo.addExercise(wo, 'e_bench');
    expect(repo.recentUses('exercise')).toContain('e_bench');
  });
});

describe('body metrics', () => {
  it('adds, reads, and deletes a metric time series', () => {
    repo.addBodyMetric({ metricType: 'weight_kg', value: 82.5, localDate: '2026-10-01', note: 'morning' });
    repo.addBodyMetric({ metricType: 'weight_kg', value: 81.9, localDate: '2026-10-03' });
    const series = repo.getBodyMetrics('weight_kg');
    expect(series.length).toBe(2);
    expect(series[0].value).toBe(81.9); // newest first
    repo.deleteBodyMetric(series[1].id);
    expect(repo.getBodyMetrics('weight_kg').length).toBe(1);
  });
});

describe.skipIf(!hasRef)('reference taxonomy mapping', () => {
  it('maps USDA data_type/category onto app taxonomy for ref foods', () => {
    // Pick a deterministic Foundation/SR-Legacy food from a named category in
    // the pack itself, then resolve it through the app repository.
    const pick = ref!.exec(
      "SELECT fdc_id FROM foods WHERE food_category = 'Cereal Grains and Pasta' AND data_type != 'Survey (FNDDS)' LIMIT 1",
    )[0].values[0][0] as number;
    const oats = repo.getFood(`usda:${pick}`)!;
    expect(oats.foodTypeId).toBe('grains');
    expect(oats.entryType).toBe('generic');
    expect(oats.name.length).toBeGreaterThan(0);
  });

  it('maps survey foods to prepared entry type', () => {
    const pick = ref!.exec(
      "SELECT fdc_id FROM foods WHERE data_type = 'Survey (FNDDS)' LIMIT 1",
    )[0].values[0][0] as number;
    const survey = repo.getFood(`usda:${pick}`)!;
    expect(survey.entryType).toBe('prepared');
  });

  it('filters reference foods by app food type', () => {
    const dairy = repo.searchFoods('cheese', 25, { foodTypeId: 'dairy' });
    expect(dairy.length).toBeGreaterThan(0);
    expect(dairy.every((f) => f.foodTypeId === 'dairy')).toBe(true);
  });

  it('entry-type facet reflects the survey/prepared vs generic split', () => {
    const facets = repo.getFoodFacets('cheese');
    const generic = facets.entryTypes.find((f) => f.id === 'generic')!;
    const prepared = facets.entryTypes.find((f) => f.id === 'prepared')!;
    expect(generic.count + prepared.count).toBeGreaterThan(0);
  });

  it('maps the real USDA category vocabulary onto food types', () => {
    // The app mapping covers the categories actually present in the pack.
    const mapped = Object.keys(REF_CATEGORY_TO_FOOD_TYPE);
    expect(mapped.length).toBeGreaterThanOrEqual(10);
    expect(mapped).toContain('Beef Products');
    expect(mapped).toContain('Finfish and Shellfish Products');
  });
});