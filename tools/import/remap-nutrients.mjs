import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Repair tool: the original nutrients.json held wrong FDC nutrient ids for some
// micronutrients (the `code`/`role` were attached to the wrong USDA nutrient id;
// only food_nutrient *amounts* were affected indirectly — those are keyed to the
// correct FDC id and are fine). The DB's names/units come verbatim from the data
// and are authoritative, so we can re-attach each intended nutrient code to the
// correct FDC id by matching the official nutrient name (+unit), regenerate the
// shipped asset, and rewrite nutrients.json so future builds are correct too.

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const dbPath = path.join(repoRoot, 'build', 'hypertroph-ref.sqlite');
const gzPath = path.join(repoRoot, 'public', 'hypertroph-ref.sqlite.gz');
const jsonPath = path.join(__dirname, 'nutrients.json');

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const normUnit = (u) => norm(u).replace(/^μg$/, 'ug').replace(/^iu$/, 'iu');

const SQL = await require('sql.js')({ locateFile: (f) => path.join(repoRoot, 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
const rows = (sql, p = []) => {
  const r = db.exec(sql, p);
  if (!r.length) return [];
  return r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])));
};

const allNutrients = rows('SELECT id, number, name, unit, role, code FROM nutrients');
const byKey = new Map();
const dupKeys = new Set();
for (const n of allNutrients) {
  const key = `${norm(n.name)}|${normUnit(n.unit)}`;
  if (byKey.has(key)) dupKeys.add(key);
  byKey.set(key, n);
}
if (dupKeys.size) {
  console.warn(`WARNING: duplicate (name,unit) keys in DB: ${[...dupKeys].join(', ')}`);
}

const current = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const corrected = [];
const errors = [];
const warnings = [];

for (const entry of current.nutrients) {
  const key = `${norm(entry.name)}|${normUnit(entry.unit)}`;
  const match = byKey.get(key);
  if (!match) {
    warnings.push(`no DB row for '${entry.name}' (${entry.unit}); keeping original mapping`);
    corrected.push(entry);
    continue;
  }
  if (match.id === entry.id && match.code === (entry.code ?? null)) {
    corrected.push(entry); // already correct
    continue;
  }
  const fixed = {
    id: match.id,
    number: match.number != null ? String(match.number) : null,
    code: entry.code ?? null,
    name: match.name,
    unit: match.unit,
    role: entry.role ?? 'other',
  };
  corrected.push(fixed);
  errors.length === 0 && console.log(`remap: ${entry.name.padEnd(22)} ${entry.id} -> ${fixed.id} (${match.code ?? 'unmapped'} -> ${fixed.code ?? 'unmapped'})`);
}

if (warnings.length) console.warn('\nWARNINGS:\n' + warnings.map((w) => '  · ' + w).join('\n'));

// Build the authoritative id set for the cleanup pass (only ids fixed from json).
const resetIds = new Set(corrected.map((c) => c.id));
db.run('BEGIN');
for (const c of corrected) {
  db.run('UPDATE nutrients SET code = ?, role = ?, name = ?, unit = ? WHERE id = ?', [
    c.code,
    c.role,
    c.name,
    c.unit,
    c.id,
  ]);
}
// Remove any stale codes left on ids that the map no longer references
// (regardless of role — the original wrong ids kept 'other' roles).
for (const n of allNutrients) {
  if (n.code != null && !resetIds.has(n.id)) {
    db.run("UPDATE nutrients SET code = NULL, role = 'other' WHERE id = ?", [n.id]);
  }
}
db.run('COMMIT');

const mappedNow = rows("SELECT COUNT(*) AS n FROM nutrients WHERE code IS NOT NULL")[0].n;
console.log(`mapped nutrients now: ${mappedNow}`);

fs.writeFileSync(jsonPath, JSON.stringify({ ...current, nutrients: corrected }, null, 2) + '\n');
fs.writeFileSync(dbPath, Buffer.from(db.export()));
fs.writeFileSync(gzPath, zlib.gzipSync(fs.readFileSync(dbPath), { level: 9 }));
db.close();

console.log(`\nWrote corrected ${path.relative(repoRoot, jsonPath)}`);
console.log(`Rewrote ${path.relative(repoRoot, dbPath)} and ${path.relative(repoRoot, gzPath)}`);