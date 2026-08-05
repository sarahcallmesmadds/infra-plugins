#!/usr/bin/env node
// A plugin whose files changed has to say a different version than main does.
//
// Run: node tests/plugin-version-drift.test.js
//
// plugin-versions.test.js asks whether a plugin's three declared versions agree
// with each other. They always did. This asks the other question: whether the
// number moved when the code under it did, which needs a comparison against
// history and cannot be answered from the working tree alone.
//
// ---------------------------------------------------------------------------
// Why this exists, in three merges.
//
// The plugin manager compares the version it has against the version on offer.
// If the number did not move it has no reason to fetch anything, so it reports
// a successful update and changes nothing. The code is on main, the old code is
// still running, and every symptom points at the code rather than at the number.
//
//   #58  changed git-hygiene, left the version. `claude plugin update` said
//        "already at the latest version (0.2.0)" and the installed collect.js
//        still had none of the fix in it.
//   #59  bumped it by hand and wrote down that nothing catches this.
//   #60  changed build-loop, left the version. One hour after #59.
//
// The header of plugin-versions.test.js already described this failure and
// named the release it cost, session 0.3.0. Writing it down twice did not stop
// it happening a third time, which is the whole argument for a check.
//
// ---------------------------------------------------------------------------
// What counts as a change, and why the rule has no exceptions.
//
// Any file under plugins/<name>/. Not "source files", not "everything except
// the README", because every one of those carve-outs is a judgment call made at
// the moment someone is least inclined to make it carefully, and the README
// ships to installed machines like everything else.
//
// The asymmetry decides it. An unnecessary patch bump costs nothing. A missed
// one is a release that silently does not exist.
//
// Uncommitted work is deliberately not counted. The failure happens at merge,
// so committing is the right moment to ask, and a suite that demands a version
// bump before you have finished editing is a suite people turn off.
//
// ---------------------------------------------------------------------------
// This wants a fetched `origin/main`, and says so rather than pretending.
//
// The comparison is only as current as the base ref on the machine running it.
// A stale `origin/main` compares against a stale number, and a checkout with no
// shared history at all cannot compare anything. Both of those print NOT RUN
// rather than a pass, because a pass here is a claim about a release.
//
// If this repository ever gets CI, that job needs full history:
// `fetch-depth: 0` for actions/checkout. The default of 1 is exactly the
// shallow case below, so the check would skip in the one place merges happen.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${e.message}`);
  }
}

function git(args) {
  try {
    return execFileSync('git', ['-C', REPO, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

// The ref this branch is measured against. `origin/main` first, because that is
// what everyone else has and what the plugin manager fetches from; a local
// `main` can be months stale and would call a real drift clean.
//
// Nothing here is a fault when no base can be found. A fresh clone, a shallow
// CI checkout and a repository whose default branch has another name all land
// there, and failing them would be this file reporting its own missing
// evidence as somebody's mistake.
function baseRef() {
  for (const ref of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', ref])) return ref;
  }
  return null;
}

function pluginNames() {
  const dir = path.join(REPO, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().filter(
    (n) => fs.existsSync(path.join(dir, n, '.claude-plugin', 'plugin.json')));
}

// The plugin manager compares by ordering, not by inequality, so "the number
// changed" is the wrong question. 0.3.1 down to 0.2.9 is a different string and
// still leaves every installed machine on a higher version, fetching nothing:
// the same silent no-op release, arrived at from the other direction.
//
// Returns null when either side cannot be ordered, and the caller says so
// rather than guessing. A version this cannot parse is not a version this can
// make a claim about.
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  const A = semver(a);
  const B = semver(b);
  if (!A || !B) return null;
  for (let i = 0; i < 3; i += 1) {
    if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  }
  return 0;
}

function versionAt(ref, name) {
  const raw = git(['show', `${ref}:plugins/${name}/.claude-plugin/plugin.json`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).version;
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------------- tests --

const base = baseRef();
const plugins = pluginNames();

if (!base) {
  console.log('plugin-version-drift: no base branch. Looked for origin/main, main,');
  console.log('  origin/master, master. Expected in a shallow checkout, and not a failure,');
  console.log('  but nothing here was verified either.');
  // Last line, because run-all.js shows the last line and nothing above it. An
  // earlier NOT RUN is invisible in the one place people read all the suites at
  // once, which turns "verified nothing" into a green row.
  console.log('\nNOT RUN, 0 versions verified, no base branch to compare against');
  process.exit(0);
}

// The fork point, and the only defensible thing to compare a version against.
//
// The file list below is `merge-base..HEAD`, so it holds what this branch
// changed. Reading the earlier version off the tip of `base` instead measures
// something else entirely, and the two disagree the moment main moves.
//
// The case that got through: branch B forks at 0.3.0, edits the plugin, bumps
// nothing. Meanwhile main releases 0.4.0. Compared against the tip, 0.3.0 and
// 0.4.0 differ, so the check says fine. Merge B and the manifest resolves to
// 0.4.0, because only main touched it, and B's new code ships under a number
// installed users already have. That is #58 and #60 exactly, with the check
// reporting a pass.
const mergeBase = git(['merge-base', base, 'HEAD']);
const changed = mergeBase && git(['diff', '--name-only', `${mergeBase}..HEAD`, '--', 'plugins/']);

if (!mergeBase || changed === null) {
  console.log(`plugin-version-drift: no merge base with ${base}.`);
  console.log('  A shallow clone has no shared history to work from. Fetch more depth to');
  console.log('  turn this back on: git fetch --unshallow, or fetch-depth: 0 in CI.');
  console.log(`\nNOT RUN, 0 versions verified, no merge base with ${base}`);
  process.exit(0);
}

const touched = new Map();
for (const file of changed.split('\n').filter(Boolean)) {
  const m = file.match(/^plugins\/([^/]+)\//);
  if (m && plugins.includes(m[1])) {
    if (!touched.has(m[1])) touched.set(m[1], []);
    touched.get(m[1]).push(file);
  }
}

// The base is named with its date, because this comparison is only as current
// as the ref on the machine running it and a stale `origin/main` compares
// against a stale number without anything looking wrong. Printing when it was
// last updated is the cheapest way to make that visible; the alternative is
// fetching, and a test has no business reaching the network.
const baseWhen = git(['log', '-1', '--format=%h %ad', '--date=short', base]) || base;
console.log(`plugin-version-drift: against ${base} (${baseWhen}), `
  + `${touched.size} plugin(s) changed of ${plugins.length}\n`);

if (!touched.size) {
  console.log('  ok    no plugin changed, so no version needs to move');
  console.log('\n1 checks, 0 failed');
  process.exit(0);
}

for (const [name, files] of [...touched].sort()) {
  check(`${name} changed, so its version moved`, () => {
    const atFork = versionAt(mergeBase, name);
    const atTip = versionAt(base, name);
    const now = versionAt('HEAD', name)
      || JSON.parse(fs.readFileSync(
        path.join(REPO, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')).version;

    // A plugin that does not exist at the fork point is new, and there is no
    // earlier number for it to differ from.
    if (atFork === null) return;

    const where = `${files.slice(0, 4).join(', ')}`
      + `${files.length > 4 ? `, and ${files.length - 4} more` : ''}`;
    const consequence = 'The plugin manager compares version numbers, so it will report a '
      + 'successful update and fetch nothing, and the old code keeps running on every '
      + 'installed machine.';

    // Above both the fork point and whatever main has released since. The fork
    // point alone is not enough once main has moved, and main's tip alone says
    // nothing about whether this branch bumped at all. The highest of the two is
    // the number installed machines could already hold.
    const ceiling = (atTip !== null && compareVersions(atTip, atFork) === 1) ? atTip : atFork;

    if (now === atFork) {
      assert.fail(`${files.length} file(s) under plugins/${name}/ changed on this branch but `
        + `the version is still ${atFork}, the same as at the fork point: ${where}. `
        + `${consequence} Bump it in all three manifests.`);
    }
    if (atTip !== null && now === atTip && atTip !== atFork) {
      assert.fail(`plugins/${name}/ changed on this branch and its version is ${now}, which `
        + `${base} has already released: ${where}. ${consequence} Pick a number above ${atTip}.`);
    }

    const order = compareVersions(now, ceiling);
    if (order === null) {
      // Different, but not orderable, so the strongest true statement is that
      // it changed. Said out loud rather than counted as a clean pass.
      console.log(`        note: ${name} ${ceiling} -> ${now} could not be compared as `
        + 'semver, so only the change was checked, not the direction.');
      return;
    }
    assert.strictEqual(order, 1,
      `plugins/${name}/ changed on this branch and its version went from ${ceiling} to `
      + `${now}, which is not higher: ${where}. ${consequence} A number that moves backwards `
      + 'fails the same way as one that does not move at all.');
  });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
