#!/usr/bin/env node
/**
 * Release automation for hypertroph+.
 *
 * Bumps the app version, commits it, cuts an annotated `v*` tag and pushes it.
 * Pushing the tag is what makes CI build + publish the updates:
 *   • `.github/workflows/build-desktop.yml` → Windows installer + `latest.yml`
 *     (the manifest that makes already-installed apps auto-update)
 *   • `.github/workflows/build-android.yml` → debug APK + release AAB
 * Both attach their artifacts to the matching GitHub Release, and the release
 * notes become the changelog the app shows under Settings → App updates.
 *
 * Usage:
 *   node tools/release.mjs                 # patch bump  (0.1.0 -> 0.1.1)
 *   node tools/release.mjs minor           # 0.1.0 -> 0.2.0
 *   node tools/release.mjs major           # 0.1.0 -> 1.0.0
 *   node tools/release.mjs --version 0.3.0 # explicit version
 *   node tools/release.mjs --dry-run       # show what would happen
 *
 * Flags:
 *   --no-push     do the local commit + tag but do not push
 *   --yes         skip the confirmation prompt
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...opts }).trim();
}

function parseArgs(argv) {
  const out = { bump: 'patch', version: null, dryRun: false, push: true, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') out.version = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-push') out.push = false;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (['patch', 'minor', 'major'].includes(a)) out.bump = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function parseVersion(v) {
  const [core] = String(v).replace(/^v/i, '').split('-');
  const [major, minor, patch] = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return { major, minor, patch };
}

function bump(current, kind) {
  const { major, minor, patch } = parseVersion(current);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const current = pkg.version;
  const next = args.version ? String(args.version).replace(/^v/i, '') : bump(current, args.bump);
  const tag = `v${next}`;

  if (parseVersion(next).major === 0 && current === next) {
    throw new Error(`New version equals current (${current}).`);
  }

  // Guard rails: releasing from a clean, up-to-date main keeps the tag honest.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) throw new Error(`Working tree has uncommitted changes:\n${dirty}\nCommit or stash them first.`);
  if (branch !== 'main') throw new Error(`Releases are cut from 'main' (currently on '${branch}').`);
  try {
    git(['rev-parse', '--verify', `refs/tags/${tag}`], { stdio: 'pipe' });
    throw new Error(`Tag ${tag} already exists.`);
  } catch (e) {
    if (String(e.message).includes('already exists')) throw e;
    // "unknown revision" → tag does not exist, which is what we want.
  }

  console.log('hypertroph+ release');
  console.log(`  branch:  ${branch}`);
  console.log(`  current: ${current}`);
  console.log(`  next:    ${next}   (tag ${tag})`);
  if (args.dryRun) {
    console.log('\n--dry-run: no files changed, nothing committed.');
    return;
  }
  if (!args.yes && !(await confirm(`\nBump to ${next}, commit, tag ${tag}${args.push ? ' and push' : ''}?`))) {
    console.log('Aborted.');
    return;
  }

  pkg.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  git(['add', 'package.json']);
  git(['commit', '-m', `chore(release): ${tag}`]);
  git(['tag', '-a', tag, '-m', `hypertroph+ ${tag}`]);
  console.log(`\nCommitted and tagged ${tag}.`);

  if (args.push) {
    git(['push', 'origin', 'main']);
    git(['push', 'origin', tag]);
    console.log('Pushed. CI will now build and publish the release:');
    console.log('  https://github.com/sensei628/Hypertroph-plus/actions');
    console.log('  https://github.com/sensei628/Hypertroph-plus/releases');
  } else {
    console.log(`\nNot pushed (--no-push). Push when ready:\n  git push origin main && git push origin ${tag}`);
  }
}

main().catch((e) => {
  console.error(`\nrelease failed: ${e.message}`);
  process.exit(1);
});
