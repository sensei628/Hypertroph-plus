#!/usr/bin/env node
// Verify + inspect the built reference database.
// Usage: node tools/import/verify-ref.mjs [path] [searchTerm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.resolve(repoRoot, process.argv[2] || 'build/hypertroph-ref.sqlite');
const term = process.argv[3] || 'rice';

function normalizeKey(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const initSqlJs = require('sql.js');
const SQL = await initSqlJs({ locateFile: (f) => path.join(repoRoot, 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(file)));

const one = (sql, p = []) => {
  const r = db.exec(sql, p);
  return r.length ? r[0].values[0][0] : null;
};
const rows = (sql, p = []) => {
  const r = db.exec(sql, p);
  if (!r.length) return [];
  return r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])));
};

console.log('=== reference DB:', path.relative(repoRoot, file), `(${(fs.statSync(file).size / 1048576).toFixed(1)} MB) ===`);
console.log('sources          :', rows('SELECT id,name,license FROM sources'));
console.log('dataset_versions :', rows('SELECT id,data_type,release_date,record_count FROM dataset_versions ORDER BY id'));
console.log('totals           : foods=' + one('SELECT COUNT(*) FROM foods'),
  'nutrients=' + one('SELECT COUNT(*) FROM nutrients'),
  'food_nutrients=' + one('SELECT COUNT(*) FROM food_nutrients'),
  'portions=' + one('SELECT COUNT(*) FROM food_portions'),
  'categories=' + one('SELECT COUNT(*) FROM food_categories'));
console.log('by data_type     :', rows('SELECT data_type, COUNT(*) n FROM foods GROUP BY data_type ORDER BY n DESC'));
console.log('mapped nutrients :', one('SELECT COUNT(*) FROM nutrients WHERE code IS NOT NULL'));
console.log(`search "${term}"  :`);
for (const r of rows(
  `SELECT fdc_id, description, data_type FROM foods WHERE search_key LIKE ? ORDER BY length(description) LIMIT 8`,
  [`%${normalizeKey(term)}%`],
)) console.log('   ', r.fdc_id, '|', r.data_type, '|', r.description);

db.close();
