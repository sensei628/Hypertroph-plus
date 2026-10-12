import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { MIGRATIONS } from '../src/data/db';
import { SqliteRepository } from '../src/data/repository';
import { nutrientGroup, NUTRIENT_GROUP_ORDER, NUTRIENT_GROUP_LABEL } from '../src/domain/nutrientGroups';

const require = createRequire(import.meta.url);

describe('nutrient group metadata', () => {
  it('maps every known nutrient into a declared group', () => {
    const cases: [string, string][] = [
      ['energy_kcal', 'energy'],
      ['protein_g', 'macronutrient'],
      ['fat_saturated_g', 'fat'],
      ['cholesterol_mg', 'fat'],
      ['vitamin_c_mg', 'vitamin'],
      ['vitamin_b12_ug', 'vitamin'],
      ['potassium_mg', 'mineral'],
      ['selenium_ug', 'mineral'],
    ];
    for (const [id, group] of cases) expect(nutrientGroup(id)).toBe(group);
    expect(NUTRIENT_GROUP_ORDER).toContain('vitamin');
    expect(NUTRIENT_GROUP_LABEL.mineral).toBe('Minerals');
  });

  it('falls back to "other" for unknown ids (never invents)', () => {
    expect(nutrientGroup('made_up_nutrient')).toBe('other');
  });
});

describe('micronutrient seed catalogue', () => {
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

  it('registers the full nutrient set', () => {
    const defs = repo.getNutrientDefs();
    expect(defs.length).toBe(36);
    const ids = new Set(defs.map((d) => d.id));
    for (const id of [
      'fat_saturated_g',
      'cholesterol_mg',
      'vitamin_a_ug',
      'vitamin_c_mg',
      'vitamin_d_ug',
      'vitamin_e_mg',
      'vitamin_k_ug',
      'thiamin_mg',
      'riboflavin_mg',
      'niacin_mg',
      'vitamin_b6_mg',
      'folate_ug',
      'vitamin_b12_ug',
      'calcium_mg',
      'iron_mg',
      'magnesium_mg',
      'phosphorus_mg',
      'potassium_mg',
      'zinc_mg',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('carries correct units and targetable flags', () => {
    const byId = new Map(repo.getNutrientDefs().map((d) => [d.id, d]));
    expect(byId.get('vitamin_d_ug')?.unit).toBe('ug');
    expect(byId.get('iron_mg')?.unit).toBe('mg');
    expect(byId.get('vitamin_c_mg')?.targetable).toBe(true);
    expect(byId.get('copper_mg')?.targetable).toBe(false);
  });
});

describe('migration v8 (micronutrient catalogue)', () => {
  it('adds the extra nutrients to an older database idempotently', async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    const d = new SQL.Database();
    // Minimal pre-v8 nutrients table carrying only the original seven rows.
    d.run(`
      CREATE TABLE nutrients (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        unit          TEXT NOT NULL CHECK (unit IN ('kcal','g','mg','ug','iu')),
        kind          TEXT NOT NULL CHECK (kind IN ('macro','energy','micro','fatty_acid','other')),
        display_order INTEGER NOT NULL DEFAULT 0,
        targetable    INTEGER NOT NULL DEFAULT 0 CHECK (targetable IN (0,1))
      );
      INSERT INTO nutrients (id, name, unit, kind, display_order, targetable) VALUES
        ('energy_kcal','Calories','kcal','energy',1,1),('protein_g','Protein','g','macro',2,1);
    `);

    const v8 = MIGRATIONS.find((m) => m.version === 8);
    expect(v8).toBeTruthy();

    d.run(v8!.sql);
    // Running again must not throw or duplicate (INSERT OR IGNORE).
    d.run(v8!.sql);

    const count = d.exec('SELECT COUNT(*) FROM nutrients')[0].values[0][0];
    expect(count).toBe(31);
    const micro = d.exec("SELECT unit, targetable FROM nutrients WHERE id = 'selenium_ug'")[0].values[0];
    expect(micro).toEqual(['ug', 0]);
  });
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refFile = path.join(repoRoot, 'build', 'hypertroph-ref.sqlite');
const hasRef = fs.existsSync(refFile);

describe.skipIf(!hasRef)('reference pack micronutrients', () => {
  let db: Database;
  let ref: Database;
  let repo: SqliteRepository;

  beforeAll(async () => {
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
    db = new SQL.Database();
    db.run(schemaSql);
    db.run(seedSql);
    ref = new SQL.Database(new Uint8Array(fs.readFileSync(refFile)));
    repo = new SqliteRepository(db, ref);
  });

  it('surfaces micronutrients on reference food details', () => {
    const hit = repo.searchFoods('chicken breast', 8).find((f) => f.id.startsWith('usda:'));
    expect(hit).toBeTruthy();
    const detail = repo.getFood(hit!.id)!;
    const micros = detail.nutrients.filter((n) =>
      ['potassium_mg', 'phosphorus_mg', 'zinc_mg', 'iron_mg', 'selenium_ug', 'niacin_mg', 'vitamin_b6_mg'].includes(
        n.nutrientId,
      ),
    );
    expect(micros.length).toBeGreaterThan(0);
    expect(micros.some((n) => (n.amountMilli ?? 0) > 0)).toBe(true);
  });

  it('snapshots micronutrients when a reference food is logged', () => {
    const hit = repo.searchFoods('chicken breast', 8).find((f) => f.id.startsWith('usda:'))!;
    repo.logFood({ foodId: hit.id, quantityG: 150, mealSection: 'lunch', localDate: '2026-10-11' });
    const item = repo.getDayItems('2026-10-11')[0];
    const ids = new Set(item.nutrients.map((n) => n.nutrientId));
    expect(ids.has('potassium_mg') || ids.has('phosphorus_mg') || ids.has('zinc_mg')).toBe(true);
  });
});
