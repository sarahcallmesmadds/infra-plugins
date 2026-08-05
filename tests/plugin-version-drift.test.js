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
  console.log('plugin-version-drift: no base branch to compare against, so nothing to check.');
  console.log('  Looked for origin/main, main, origin/master, master. This is the expected');
  console.log('  result in a shallow checkout and is not a failure.');
  console.log('\n0 checks, 0 failed');
  process.exit(0);
}

// Three dots, so this measures what the branch added rather than what main has
// moved on to since. On main itself the merge base is HEAD and the diff is
// empty, which is the correct answer rather than a special case.
const changed = git(['diff', '--name-only', `${base}...HEAD`, '--', 'plugins/']);

if (changed === null) {
  console.log(`plugin-version-drift: could not diff against ${base}, so nothing to check.`);
  console.log('  A shallow clone has no merge base to work from. Not a failure.');
  console.log('\n0 checks, 0 failed');
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

console.log(`plugin-version-drift: against ${base}, ${touched.size} plugin(s) changed `
  + `of ${plugins.length}\n`);

if (!touched.size) {
  console.log('  ok    no plugin changed, so no version needs to move');
  console.log('\n1 checks, 0 failed');
  process.exit(0);
}

for (const [name, files] of [...touched].sort()) {
  check(`${name} changed, so its version moved`, () => {
    const before = versionAt(base, name);
    const now = versionAt('HEAD', name)
      || JSON.parse(fs.readFileSync(
        path.join(REPO, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')).version;

    // A plugin that does not exist on the base branch is new, and there is no
    // earlier number for it to differ from.
    if (before === null) return;

    assert.notStrictEqual(now, before,
      `${files.length} file(s) under plugins/${name}/ differ from ${base} but the version `
      + `is still ${before}: ${files.slice(0, 4).join(', ')}`
      + `${files.length > 4 ? `, and ${files.length - 4} more` : ''}. `
      + 'The plugin manager compares version numbers, so it will report a successful '
      + 'update and fetch nothing, and the old code keeps running on every installed '
      + 'machine. Bump it in all three manifests.');
  });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
