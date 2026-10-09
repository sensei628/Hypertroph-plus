#!/usr/bin/env node
// One-command build of the bundled reference database from downloaded USDA JSON.
// Downloads are expected in tools/import/.cache/usda (see download-usda.ps1).
// Produces public/hypertroph-ref.sqlite (git-ignored) and public/hypertroph-ref.sqlite.gz (shipped).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const cache = process.env.USDA_DIR || path.join(__dirname, '.cache', 'usda');
const out = path.join(repoRoot, 'public', 'hypertroph-ref.sqlite');
const outGz = out + '.gz';

const datasets = [
  { dir: 'foundation', file: 'FoodData_Central_foundation_food_json_2026-04-30.json', datatype: 'Foundation', release: '2026-04-30', version: 'usda_foundation_2026-04-30' },
  { dir: 'sr_legacy', file: 'FoodData_Central_sr_legacy_food_json_2018-04.json', datatype: 'SR Legacy', release: '2018-04', version: 'usda_sr_legacy_2018-04' },
  { dir: 'fndds', file: 'surveyDownload.json', datatype: 'Survey (FNDDS)', release: '2021-2023', version: 'usda_fndds_2021-2023' },
];

for (const d of datasets) {
  const input = path.join(cache, d.dir, d.file);
  if (!fs.existsSync(input)) {
    console.error(`Missing ${input}\nRun tools/import/download-usda.ps1 first.`);
    process.exit(1);
  }
}

if (fs.existsSync(out)) fs.rmSync(out);
for (const d of datasets) {
  execFileSync('node', [
    path.join(__dirname, 'import-usda.mjs'),
    '--in', path.join(cache, d.dir, d.file),
    '--out', out,
    '--datatype', d.datatype,
    '--release', d.release,
    '--version', d.version,
  ], { stdio: 'inherit' });
}

const raw = fs.statSync(out).size;
fs.writeFileSync(outGz, zlib.gzipSync(fs.readFileSync(out), { level: 9 }));
console.log(`\nPackaged: ${path.relative(repoRoot, outGz)}  raw ${(raw / 1048576).toFixed(1)} MB -> gz ${(fs.statSync(outGz).size / 1048576).toFixed(2)} MB`);
