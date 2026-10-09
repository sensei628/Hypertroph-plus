import { describe, it, expect, beforeAll } from 'vitest';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import schemaSql from '../db/schema.sql?raw';
import seedSql from '../db/seed.sql?raw';
import { SqliteRepository } from '../src/data/repository';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const refFile = path.join(repoRoot, 'build', 'hypertroph-ref.sqlite');
const hasRef = fs.existsSync(refFile);

const DATE = '2026-10-10';
let db: Database;
let ref: Database;
let repo: SqliteRepository;

describe.skipIf(!hasRef)('reference pack integration (USDA CC0)', () => {
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

  it('searches the reference pack alongside local foods', () => {
    const results = repo.searchFoods('chicken breast', 25);
    expect(results.some((f) => f.id.startsWith('usda:'))).toBe(true);
    // local matches still rank first
    const oat = repo.searchFoods('oat');
    expect(oat[0]?.id).toBe('f_oats');
  });

  it('maps reference nutrients to app nutrient ids', () => {
    const hit = repo.searchFoods('chicken breast', 5).find((f) => f.id.startsWith('usda:'))!;
    const detail = repo.getFood(hit.id)!;
    expect(detail.sourceId).toBe('s_usda');
    expect(detail.quality).toBe('verified');
    const energy = detail.nutrients.find((n) => n.nutrientId === 'energy_kcal');
    const protein = detail.nutrients.find((n) => n.nutrientId === 'protein_g');
    expect(energy?.amountMilli).toBeGreaterThan(0);
    expect(protein?.amountMilli).toBeGreaterThan(0);
  });

  it('materializes a reference food once on log and snapshots it', () => {
    const hit = repo.searchFoods('banana', 5).find((f) => f.id.startsWith('usda:'))!;
    repo.logFood({ foodId: hit.id, quantityG: 118, mealSection: 'snack', localDate: DATE });
    repo.logFood({ foodId: hit.id, quantityG: 50, mealSection: 'snack', localDate: DATE });

    const items = repo.getDayItems(DATE);
    expect(items.length).toBe(2);
    expect(items.every((i) => i.nutrients.some((n) => n.nutrientId === 'energy_kcal'))).toBe(true);

    const fdc = hit.id.slice('usda:'.length);
    const copies = db.exec(
      "SELECT COUNT(*) FROM foods WHERE source_id = 's_usda' AND source_record_id = ?",
      [fdc],
    )[0].values[0][0];
    expect(copies).toBe(1);

    expect(repo.recentFoods(10).some((f) => f.name === hit.name)).toBe(true);
  });
});
