#!/usr/bin/env node
// The command behind /stale-branches.
//
// Usage:
//   cli.js                        classify branches in the current checkout
//   cli.js --repo owner/name      classify branches on GitHub instead
//   cli.js --json                 machine-readable output
//   cli.js --input file.json      classify a saved snapshot (used by the tests)
//   cli.js --stale-after 60       age in days at which a branch is marked stale
//   cli.js --now 2026-07-27       fix "today", so output is reproducible
//
// --stale-after sets the `stale` flag in --json output and nothing else. It does
// NOT filter what is listed and it does NOT affect what is safe to delete. Every
// branch is always listed with its age, because a cleanup command that silently
// hides branches is how a repository comes to look tidier than it is. The flag
// exists because the session hook uses the same threshold to decide what is
// worth mentioning at startup.
//
// This file is what the skill runs and what the tests run. Every bug the
// plugin has shipped so far lived in a printing path that no test executed,
// so the tests drive this, not the functions underneath it.

'use strict';

const fs = require('fs');
const path = require('path');
const { classify, DEFAULTS, KEEP } = require(path.join(__dirname, 'classify.js'));
const collect = require(path.join(__dirname, 'collect.js'));

function parseArgs(argv) {
  const out = { json: false, repo: null, input: null, staleAfter: DEFAULTS.staleAfterDays, now: null, cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--stale-after') out.staleAfter = parseInt(argv[++i], 10);
    else if (a === '--now') out.now = argv[++i];
  }
  if (!Number.isFinite(out.staleAfter) || out.staleAfter < 0) out.staleAfter = DEFAULTS.staleAfterDays;
  return out;
}

const KEEP_TEXT = {
  [KEEP.DEFAULT_BRANCH]: 'this is the default branch',
  [KEEP.PROTECTED]: 'protected branch',
  [KEEP.CURRENT]: 'you have it checked out',
  [KEEP.OPEN_PR]: 'it has an open pull request',
  [KEEP.UNMERGED]: null, // filled in per branch, it needs the count
  [KEEP.UNKNOWN]: 'could not work out whether it is merged, so treating it as unmerged',
};

function reasonText(b) {
  return b.keepReasons
    .map((r) => (r === KEEP.UNMERGED
      ? `${b.aheadBy} commit${b.aheadBy === 1 ? '' : 's'} not in the default branch`
      : KEEP_TEXT[r]))
    .filter(Boolean)
    .join(', ');
}

function age(b) {
  if (b.ageDays === null) return 'age unknown';
  if (b.ageDays === 0) return 'today';
  if (b.ageDays === 1) return '1 day old';
  return `${b.ageDays} days old`;
}

function render(result, where) {
  const lines = [];
  const safe = result.safe.slice().sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
  const keep = result.keep
    .filter((b) => !b.keepReasons.includes(KEEP.DEFAULT_BRANCH))
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));

  if (safe.length === 0 && keep.length === 0) {
    lines.push(`No branches besides the default one in ${where}. Nothing to clean up.`);
    return lines.join('\n');
  }

  lines.push(`${where}: ${safe.length + keep.length} branches besides the default one.`);
  lines.push('');

  if (safe.length) {
    lines.push(`Safe to delete (${safe.length}) — every commit is already in the default branch:`);
    for (const b of safe) lines.push(`  ${b.name}  (${age(b)})`);
  } else {
    lines.push('Safe to delete (0).');
  }
  lines.push('');

  if (keep.length) {
    lines.push(`Keep (${keep.length}) — deleting these would lose work:`);
    for (const b of keep) lines.push(`  ${b.name}  (${age(b)}) — ${reasonText(b)}`);
  } else {
    lines.push('Keep (0).');
  }

  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = opts.now ? Date.parse(opts.now) : Date.now();

  let branches;
  let where;

  if (opts.input) {
    const snapshot = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
    branches = snapshot.branches;
    where = snapshot.where || opts.input;
  } else if (opts.repo) {
    const r = collect.remoteBranches(opts.repo);
    if (r.error || !r.defaultBranch) {
      process.stderr.write(`Could not read ${opts.repo} from GitHub. Is gh logged in, and does the repo exist?\n`);
      process.exit(2);
    }
    branches = r.branches;
    where = opts.repo;
  } else {
    if (!collect.isGitRepo(opts.cwd)) {
      process.stderr.write('Not inside a git repository. Pass --repo owner/name to check a repository on GitHub instead.\n');
      process.exit(2);
    }
    const r = collect.localBranches(opts.cwd);
    if (!r.defaultBranch) {
      process.stderr.write('Could not work out the default branch, so nothing can be compared against it. Nothing was classified.\n');
      process.exit(2);
    }
    branches = r.branches;
    where = opts.cwd;
  }

  const result = classify(branches, { staleAfterDays: opts.staleAfter }, now);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ where, safe: result.safe, keep: result.keep }, null, 2) + '\n');
  } else {
    process.stdout.write(render(result, where) + '\n');
  }
}

if (require.main === module) main();

module.exports = { parseArgs, render, reasonText, age };
