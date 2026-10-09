#!/usr/bin/env node
// USDA FoodData Central bulk importer.
//
// Builds / appends to the read-only reference SQLite database used by the app.
// Consumes the OFFICIAL downloadable JSON archives (no per-food API calls).
//
// Usage:
//   node tools/import/import-usda.mjs \
//     --in  <path-to-FDC-*-json-file> --out public/hypertroph-ref.sqlite \
//     --source usda_fdc --datatype "Foundation" --release 2026-04-30 \
//     --version usda_foundation_2026-04-30
//
// Idempotent + resumable: re-running for the same --version replaces only that
// dataset's rows. Safe to run dataset-by-dataset; the file is opened if present.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const inFile = arg('in');
const outFile = path.resolve(repoRoot, arg('out', 'public/hypertroph-ref.sqlite'));
const sourceId = arg('source', 'usda_fdc');
const dataType = arg('datatype');
const release = arg('release', '');
const versionId = arg('version');
const arrayOverride = arg('array');
const force = flag('force');

if (!inFile || !dataType || !versionId) {
  console.error('Missing required args: --in --datatype --version');
  process.exit(2);
}
if (!fs.existsSync(inFile)) {
  console.error(`Input file not found: ${inFile}`);
  process.exit(2);
}

const nutrientMap = new Map(
  JSON.parse(fs.readFileSync(path.join(__dirname, 'nutrients.json'), 'utf8')).nutrients.map((n) => [n.id, n]),
);

function normalizeKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Pseudo "nutrients" that are not nutrition data (e.g. Specific Gravity is a
// conversion factor; Footnote rows carry metadata). Excluded from import.
const SKIP_NUTRIENT = /specific gravity|^footnote$|moisture changes/i;

function pickArray(json) {
  if (arrayOverride) return json[arrayOverride];
  const key = Object.keys(json).find((k) => Array.isArray(json[k]));
  return key ? json[key] : null;
}

function categoryOf(food) {
  const c = food.foodCategory;
  if (!c) return { id: null, desc: null };
  if (typeof c === 'string') return { id: null, desc: c };
  return { id: c.id ?? null, desc: c.description ?? null };
}

async function main() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(repoRoot, 'node_modules', 'sql.js', 'dist', f),
  });

  let db;
  if (fs.existsSync(outFile)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(outFile)));
    console.log(`Opened existing DB (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
  } else {
    db = new SQL.Database();
    db.run(fs.readFileSync(path.join(__dirname, 'ref_schema.sql'), 'utf8'));
    console.log('Created new reference DB from schema');
  }

  db.run(`INSERT OR IGNORE INTO sources (id,name,short_name,license,license_url,url,retrieved_at)
          VALUES ('usda_fdc','USDA FoodData Central','USDA FDC','Public domain (CC0 / US Government work)','https://fdc.nal.usda.gov/data-license.html','https://fdc.nal.usda.gov/',?)`,
    [Date.now()]);

  // Idempotency: clear any prior import for this dataset version.
  const existing = db.exec(`SELECT record_count FROM dataset_versions WHERE id = ?`, [versionId]);
  if (existing.length && existing[0].values.length && !force) {
    console.log(`Dataset ${versionId} already present with ${existing[0].values[0][0]} records. Use --force to replace.`);
  }

  console.log(`Loading ${inFile} ...`);
  const t0 = Date.now();
  const json = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const foods = pickArray(json);
  if (!Array.isArray(foods)) {
    console.error('Could not find a food array in the JSON. Use --array <key>.');
    process.exit(2);
  }
  console.log(`Parsed ${foods.length} foods in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  db.run('BEGIN');
  db.run('DELETE FROM food_nutrients WHERE food_id IN (SELECT fdc_id FROM foods WHERE dataset_version_id = ?)', [versionId]);
  db.run('DELETE FROM food_portions  WHERE food_id IN (SELECT fdc_id FROM foods WHERE dataset_version_id = ?)', [versionId]);
  db.run('DELETE FROM foods WHERE dataset_version_id = ?', [versionId]);
  db.run('DELETE FROM dataset_versions WHERE id = ?', [versionId]);
  db.run('COMMIT');

  const insFood = db.prepare(
    `INSERT INTO foods (fdc_id,description,data_type,food_class,food_category,food_category_id,ndb_number,publication_date,source_id,dataset_version_id,search_key,is_historical)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insNut = db.prepare(
    `INSERT INTO nutrients (id,number,name,unit,rank,role,code) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, unit=excluded.unit, rank=excluded.rank, role=excluded.role, code=excluded.code`,
  );
  const insFn = db.prepare(
    `INSERT OR REPLACE INTO food_nutrients (food_id,nutrient_id,amount,derivation_code,derivation_desc) VALUES (?,?,?,?,?)`,
  );
  const insPortion = db.prepare(
    `INSERT INTO food_portions (id,food_id,seq,amount,modifier,measure_name,measure_abbr,gram_weight) VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insCat = db.prepare(`INSERT OR IGNORE INTO food_categories (id,description) VALUES (?,?)`);

  const seenNutrients = new Set();
  const catIds = new Map();
  let catSeq = 900000;
  let nNutrients = 0;
  let nPortions = 0;
  let nFoods = 0;
  let skipped = 0;

  const BATCH = 400;
  db.run('BEGIN');
  for (let i = 0; i < foods.length; i++) {
    const food = foods[i];
    if (food == null || food.fdcId == null || !food.description) {
      skipped++;
      continue;
    }
    const cat = categoryOf(food);
    let catId = cat.id;
    if (cat.desc && catId == null) {
      if (!catIds.has(cat.desc)) catIds.set(cat.desc, ++catSeq);
      catId = catIds.get(cat.desc);
    }
    if (catId != null && cat.desc) insCat.run([catId, cat.desc]);

    insFood.run([
      food.fdcId,
      food.description,
      food.dataType || dataType,
      food.foodClass ?? null,
      cat.desc,
      catId,
      food.ndbNumber != null ? String(food.ndbNumber) : null,
      food.publicationDate ?? null,
      sourceId,
      versionId,
      normalizeKey(food.description),
      food.isHistoricalReference ? 1 : 0,
    ]);
    nFoods++;

    for (const fn of food.foodNutrients || []) {
      const nut = fn.nutrient;
      if (!nut || nut.id == null) continue;
      if (SKIP_NUTRIENT.test(nut.name || '') || nut.unitName === 'sp gr') continue;
      if (!seenNutrients.has(nut.id)) {
        const m = nutrientMap.get(nut.id);
        insNut.run([
          nut.id,
          nut.number != null ? String(nut.number) : null,
          nut.name ?? m?.name ?? `Nutrient ${nut.id}`,
          nut.unitName ?? m?.unit ?? '',
          nut.rank ?? null,
          m?.role ?? 'other',
          m?.code ?? null,
        ]);
        seenNutrients.add(nut.id);
        nNutrients++;
      }
      const amount = fn.amount != null ? fn.amount : fn.median != null ? fn.median : null;
      insFn.run([
        food.fdcId,
        nut.id,
        amount,
        fn.foodNutrientDerivation?.code ?? null,
        fn.foodNutrientDerivation?.description ?? null,
      ]);
    }

    for (const p of food.foodPortions || []) {
      insPortion.run([
        p.id ?? null,
        food.fdcId,
        p.sequenceNumber ?? null,
        p.amount ?? null,
        p.modifier ?? null,
        p.measureUnit?.name ?? null,
        p.measureUnit?.abbreviation ?? null,
        p.gramWeight ?? null,
      ]);
      nPortions++;
    }

    if ((i + 1) % BATCH === 0) {
      db.run('COMMIT');
      db.run('BEGIN');
      process.stdout.write(`\r  imported ${i + 1}/${foods.length} foods ...`);
    }
  }
  db.run('COMMIT');
  process.stdout.write('\n');

  insFood.free(); insNut.free(); insFn.free(); insPortion.free(); insCat.free();

  db.run(
    `INSERT INTO dataset_versions (id,source_id,data_type,release_date,description,imported_at,record_count)
     VALUES (?,?,?,?,?,?,?)`,
    [versionId, sourceId, dataType, release, `${dataType} ${release}`.trim(), Date.now(), nFoods],
  );
  db.run(`INSERT OR REPLACE INTO ref_meta (key,value) VALUES ('built_at', ?)`, [String(Date.now())]);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const bytes = db.export();
  fs.writeFileSync(outFile, Buffer.from(bytes));

  const size = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log('--- import summary ---');
  console.log(`dataset_version : ${versionId}`);
  console.log(`foods imported  : ${nFoods}${skipped ? ` (skipped ${skipped})` : ''}`);
  console.log(`new nutrients   : ${nNutrients}`);
  console.log(`portions        : ${nPortions}`);
  console.log(`db file         : ${path.relative(repoRoot, outFile)} (${size} MB)`);
  console.log(`elapsed         : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
