#!/usr/bin/env node
// Compliance guard for hypertroph+.
//
// Fails (exit 1) if:
//   * db/seed.sql references an unknown source id
//   * a bundled data asset references an unknown source, or a source that is not
//     redistribution:"allowed"
//   * a bundled asset (public/ or dist/) or a git-tracked file name contains a
//     restricted-dataset pattern (ifct, ausnut, afcd, nuttab, fsanz, ...)
//   * a restricted cache path is not git-ignored
//   * the attribution file / licence register is missing, or a bundled source that
//     requires attribution is not credited.
//
// See DATA_LICENSES.md for the human-readable register.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const errors = [];
const warnings = [];
const notes = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function readText(rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function readJson(rel) {
  const txt = readText(rel);
  if (txt == null) {
    fail(`missing required file: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    fail(`invalid JSON in ${rel}: ${e.message}`);
    return null;
  }
}

const allowlist = readJson('tools/compliance/approved-sources.json');
const bundled = readJson('tools/compliance/bundled-data.json');
if (!allowlist || !bundled) {
  console.error('compliance: cannot proceed without manifests');
  process.exit(1);
}

// ── resolve known source ids ────────────────────────────────────────────────
const byToken = new Map();
for (const s of allowlist.sources) {
  byToken.set(s.id, s);
  for (const a of s.aliases ?? []) byToken.set(a, s);
}

function resolveSource(token) {
  return byToken.get(token) ?? null;
}

// ── 1. source ids referenced by the app seed ────────────────────────────────
const seed = readText('db/seed.sql');
if (seed == null) {
  fail('missing db/seed.sql');
} else {
  const ids = new Set();
  for (const m of seed.matchAll(/'((?:s|src)_[a-z0-9_]+)'/g)) ids.add(m[1]);
  for (const id of ids) {
    if (!resolveSource(id)) fail(`db/seed.sql references unknown source id '${id}'`);
  }
  notes.push(`seed.sql source ids: ${[...ids].join(', ') || '(none)'}`);
}

// ── 2. bundled data assets ──────────────────────────────────────────────────
const forbidden = (allowlist.forbiddenPatterns ?? []).map((p) => p.toLowerCase());

// Committed loaders/templates/docs may legitimately name a restricted dataset
// (e.g. templates/ifct.template.csv) — only DATA files are forbidden.
function isTokenAllowedPath(rel) {
  const r = rel.replace(/\\/g, '/').toLowerCase();
  return r.includes('/templates/') || r.endsWith('.template.csv');
}

function checkAsset(entry, { requireAllowed }) {
  const src = resolveSource(entry.sourceId);
  if (!src) {
    fail(`bundled-data references unknown source '${entry.sourceId}' (${entry.path})`);
    return;
  }
  if (requireAllowed && src.redistribution !== 'allowed') {
    fail(
      `bundled data '${entry.path}' uses source '${src.id}' with redistribution '${src.redistribution}' (must be 'allowed')`,
    );
  }
  const lower = entry.path.toLowerCase();
  for (const pat of forbidden) {
    if (lower.includes(pat)) fail(`bundled asset path matches restricted pattern '${pat}': ${entry.path}`);
  }
  if (!entry.path.startsWith('public/') && !entry.path.startsWith('db/')) {
    // still allow, but note
    notes.push(`non-public bundled entry: ${entry.path}`);
  }
}

for (const a of bundled.assets ?? []) checkAsset(a, { requireAllowed: true });
for (const a of bundled.appOwned ?? []) checkAsset(a, { requireAllowed: true });

// ── 3. forbidden patterns in dist/ and git-tracked files ────────────────────
function distHasRestricted() {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) {
    warnings.push('dist/ not present; skipped bundled-output scan (run after build for full check)');
    return false;
  }
  let bad = false;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full).toLowerCase();
      for (const pat of forbidden) {
        if (rel.includes(pat) && !isTokenAllowedPath(rel)) {
          fail(`restricted pattern '${pat}' found in build output: ${rel}`);
          bad = true;
        }
      }
      if (statSync(full).isDirectory()) walk(full);
    }
  };
  walk(dist);
  return bad;
}
distHasRestricted();

function gitTrackedRestricted() {
  let out;
  try {
    out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  } catch {
    warnings.push('git not available / not a repo; skipped tracked-file scan');
    return;
  }
  const files = out.split(/\r?\n/).filter(Boolean);
  let bad = false;
  for (const f of files) {
    const lower = f.toLowerCase();
    for (const pat of forbidden) {
      if (lower.includes(pat) && !isTokenAllowedPath(f)) {
        fail(`restricted file is tracked by git: ${f} (pattern '${pat}')`);
        bad = true;
      }
    }
  }
  if (!bad) notes.push(`git: ${files.length} tracked files, none restricted`);
}
gitTrackedRestricted();

// ── 4. restricted cache paths must be git-ignored ───────────────────────────
const gitignore = readText('.gitignore') ?? '';
for (const p of allowlist.restrictedIgnoredPaths ?? []) {
  if (!gitignore.includes(p)) fail(`.gitignore must exclude restricted path '${p}'`);
}

// ── 5. attribution + register coverage ──────────────────────────────────────
const attribution = readText('public/ATTRIBUTION.txt');
if (attribution == null) {
  fail('missing public/ATTRIBUTION.txt');
}
if (readText('DATA_LICENSES.md') == null) {
  fail('missing DATA_LICENSES.md');
}

const mustAttribute = new Set();
for (const s of allowlist.sources) {
  if (s.bundled && s.attributionRequired) mustAttribute.add(s.name);
}
if (attribution != null) {
  const hay = attribution.toLowerCase();
  for (const name of mustAttribute) {
    if (!hay.includes(name.toLowerCase())) {
      fail(`public/ATTRIBUTION.txt does not credit bundled source '${name}'`);
    }
  }
}

// ── report ──────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`  · ${n}`);
for (const w of warnings) console.warn(`  ! ${w}`);
if (errors.length) {
  console.error('\ncompliance: FAILED');
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log('\ncompliance: OK — all bundled data sources are approved and attributed.');
