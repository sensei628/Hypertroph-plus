#!/usr/bin/env node
/**
 * Release changelog generator.
 *
 * Turns the conventional-commit history between two refs into a readable
 * markdown body for a GitHub Release. CI feeds the result into the release body
 * (`body_path`), and the app shows it under Settings → App updates as
 * "what's changed" (both the desktop updater's release notes and the web/mobile
 * GitHub-Releases-API check read that same body).
 *
 * Usage:
 *   node tools/changelog.mjs                       # previous tag .. HEAD
 *   node tools/changelog.mjs --to v0.3.0           # previous tag .. v0.3.0
 *   node tools/changelog.mjs --from v0.1.0 --to v0.2.0
 *   node tools/changelog.mjs --all                 # every commit
 *   node tools/changelog.mjs --format plain        # no markdown headings
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const REPO = { owner: 'sensei628', repo: 'Hypertroph-plus' };
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Order here is the display order. Unknown types fall into "Other".
const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['build', 'Build & tooling'],
  ['ci', 'Build & tooling'],
  ['test', 'Tests'],
  ['style', 'Styling'],
  ['chore', 'Chores'],
];
const ORDER = SECTIONS.map(([k]) => k);

/** Parse a single commit subject into its conventional-commit parts. */
export function parseCommit(subject, hash = '') {
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(subject.trim());
  if (!m) return { type: '', scope: '', breaking: false, description: subject.trim(), hash };
  return { type: m[1].toLowerCase(), scope: m[2] ?? '', breaking: !!m[3], description: m[4].trim(), hash };
}

/** Group parsed commits into ordered sections, dropping release/chore noise. */
export function groupCommits(commits) {
  const groups = new Map();
  for (const c of commits) {
    const isReleaseBump =
      c.type === 'chore' && (c.scope === 'release' || /^v?\d+\.\d+\.\d+\s*$/.test(c.description));
    if (isReleaseBump) continue; // chore(release): vX.Y.Z
    const type = ORDER.includes(c.type) ? c.type : 'other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(c);
  }
  const ordered = [];
  for (const [type, title] of [...SECTIONS, ['other', 'Other changes']]) {
    const items = groups.get(type);
    if (items && items.length) ordered.push({ title, items });
  }
  return ordered;
}

function line(c) {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const bang = c.breaking ? '⚠️ ' : '';
  const hash = c.hash ? ` (\`${c.hash}\`)` : '';
  return `- ${bang}${scope}${c.description}${hash}`;
}

/** Render the grouped commits as a markdown changelog body. */
export function formatChangelog(commits, opts = {}) {
  const { version = '', from = '', to = '', format = 'markdown' } = opts;
  const groups = groupCommits(commits);
  const out = [];
  if (format === 'markdown') {
    out.push(`## hypertroph+ ${version || to}`.trim());
    out.push('');
    out.push(from ? `Changes since \`${from}\`:` : 'Changes:');
    out.push('');
    for (const g of groups) {
      out.push(`### ${g.title}`);
      for (const c of g.items) out.push(line(c));
      out.push('');
    }
    if (groups.length === 0) {
      out.push('- No user-facing changes.');
      out.push('');
    }
    if (from && to) {
      out.push(`**Full diff:** https://github.com/${REPO.owner}/${REPO.repo}/compare/${from}...${to}`);
    }
  } else {
    out.push(`Changes${from ? ` since ${from}` : ''}:`);
    for (const g of groups) for (const c of g.items) out.push(line(c));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function latestTagBefore(ref) {
  try {
    return git(['describe', '--tags', '--abbrev=0', `${ref}^`]);
  } catch {
    return '';
  }
}

function exactTag(ref) {
  try {
    return git(['describe', '--tags', '--exact-match', ref]);
  } catch {
    return '';
  }
}

function collectCommits(range) {
  const raw = git(['log', ...(range ? [range] : []), '--no-merges', '--pretty=format:%h\t%s']);
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, ...rest] = l.split('\t');
      return parseCommit(rest.join('\t'), hash);
    });
}

function parseArgs(argv) {
  const out = { from: '', to: '', all: false, format: 'markdown' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--all') out.all = true;
    else if (a === '--format') out.format = argv[++i];
    else if (!a.startsWith('--') && !out.to) out.to = a;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tagHere = exactTag('HEAD');
  const to = args.to || tagHere;
  const toRef = to || 'HEAD';
  const from = args.all ? '' : args.from || latestTagBefore(toRef);
  const range = from ? `${from}..${toRef}` : toRef;
  const commits = collectCommits(range);
  const version = (to || from).replace(/^v/i, '');
  process.stdout.write(formatChangelog(commits, { version, from, to: toRef, format: args.format }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
