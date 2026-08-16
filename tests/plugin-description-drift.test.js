#!/usr/bin/env node
// A plugin whose description changed has to change it everywhere it is written.
//
// Run: node tests/plugin-description-drift.test.js
//
// plugin-authoring-contract.test.js asks whether each plugin is listed in the
// root README. It always was. This asks the other question: whether every place
// that describes the plugin still says the same thing about it, which needs a
// comparison against history and cannot be answered from one file alone.
//
// ---------------------------------------------------------------------------
// The six surfaces.
//
//   1  plugins/<name>/.claude-plugin/plugin.json   description
//   2  plugins/<name>/.codex-plugin/plugin.json    description
//   3  plugins/<name>/.codex-plugin/plugin.json    interface.shortDescription
//   4  plugins/<name>/.codex-plugin/plugin.json    interface.longDescription
//   5  .claude-plugin/marketplace.json             the entry for this plugin
//   6  README.md                                   the row in the plugin table
//
// Six sentences about one product, written for six readers. When the product
// changes they all become wrong together, and they are edited one at a time.
//
// ---------------------------------------------------------------------------
// Why this exists, and why the first version of it was not enough.
//
// PR #122 widened slop-check from a checker to a checker and a rewriter, and
// updated three of the surfaces. The root README row still described it as
// check-only, so the one thing a person reads before installing anything was
// the one thing that was wrong. Devin caught it and noted that nothing would
// have, which is what this file was written for.
//
// The first version of this file triggered off surface 1 and asserted on 5 and
// 6. Devin caught that too, in the next round: the Codex manifest was never
// read, so surfaces 2, 3 and 4 could say anything at all. It was not
// hypothetical. In the same PR the Codex shortDescription was still the
// check-only wording while the long description beside it had been widened, and
// this file passed.
//
// So the rule is now symmetric rather than one-directional: a change to any
// surface requires a change to all of them. Triggering off one nominated file
// means every other file can drift alone, and there is no reason to nominate
// one, because all six make the same claim.
//
// ---------------------------------------------------------------------------
// The tradeoff, stated rather than hidden.
//
// This fires on any change to any surface, including fixing a typo, and then
// asks for five edits that a typo does not need. That is the same asymmetry
// plugin-version-drift.test.js settles the same way: an unnecessary edit costs a
// minute, and a missed one ships a description of a product that no longer
// exists to everyone deciding whether to install it.
//
// It compares each surface against itself across the branch, never against
// another surface's text. They are deliberately different sentences for
// different readers, so requiring them to match would be requiring the wrong
// thing. What is required is that they moved together.
//
// ---------------------------------------------------------------------------
// The "now" side is the working tree, not HEAD.
//
// plugin-version-drift.test.js reads committed state for both sides, and queue
// entry 2026-08-11T01-25-00-plugin-version-drift-test records what that costs:
// the full suite is run before committing, which is the normal order, so the
// check is silent at the only moment anyone can act on it, and the green run
// gets read as confirmation the work was done. Devin found the missing bump
// instead, at the stage the test exists to make unnecessary.
//
// So the fork point comes from history, because it has to, and everything it is
// compared against comes from the files as they stand. Editing a description and
// running the suite fails immediately, before the commit, which is the point.

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

// `WORKTREE` reads the file as it stands rather than as it was committed. Any
// other ref goes through git. See the header for why the two sides differ.
const WORKTREE = Symbol('worktree');

function fileAt(ref, relative) {
  if (ref === WORKTREE) {
    const full = path.join(REPO, relative);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  }
  return git(['show', `${ref}:${relative}`]);
}

function json(ref, relative) {
  const raw = fileAt(ref, relative);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// The row a reader sees before they install anything. Found by the link target
// rather than by the plugin name in prose, because the name appears in other
// rows' text and in the paragraphs around the table.
function readmeRow(ref, name) {
  const raw = fileAt(ref, 'README.md');
  if (raw === null) return null;
  const marker = `](plugins/${name})`;
  for (const line of raw.split('\n')) {
    if (line.includes(marker)) return line.trim();
  }
  return null;
}

// Every surface reads through here, so adding one is a single entry and it is
// then covered in both directions automatically. A reader that cannot find its
// value returns null, and null on both sides means the surface does not exist
// for that plugin rather than that it changed.
const SURFACES = [
  {
    label: 'the Claude manifest description',
    where: (n) => `plugins/${n}/.claude-plugin/plugin.json`,
    read: (ref, n) => {
      const j = json(ref, `plugins/${n}/.claude-plugin/plugin.json`);
      return j ? j.description || null : null;
    },
  },
  {
    label: 'the Codex manifest description',
    where: (n) => `plugins/${n}/.codex-plugin/plugin.json`,
    read: (ref, n) => {
      const j = json(ref, `plugins/${n}/.codex-plugin/plugin.json`);
      return j ? j.description || null : null;
    },
  },
  {
    label: 'the Codex interface shortDescription',
    where: (n) => `plugins/${n}/.codex-plugin/plugin.json`,
    read: (ref, n) => {
      const j = json(ref, `plugins/${n}/.codex-plugin/plugin.json`);
      return j && j.interface ? j.interface.shortDescription || null : null;
    },
  },
  {
    label: 'the Codex interface longDescription',
    where: (n) => `plugins/${n}/.codex-plugin/plugin.json`,
    read: (ref, n) => {
      const j = json(ref, `plugins/${n}/.codex-plugin/plugin.json`);
      return j && j.interface ? j.interface.longDescription || null : null;
    },
  },
  {
    label: 'the marketplace entry',
    where: () => '.claude-plugin/marketplace.json',
    read: (ref, n) => {
      const j = json(ref, '.claude-plugin/marketplace.json');
      if (!j || !Array.isArray(j.plugins)) return null;
      const entry = j.plugins.find((p) => p.name === n);
      return entry ? entry.description || null : null;
    },
  },
  {
    label: 'the root README table row',
    where: () => 'README.md',
    read: (ref, n) => readmeRow(ref, n),
  },
];

// ------------------------------------------------------------------- tests --

const base = baseRef();
const plugins = pluginNames();

if (!base) {
  console.log('plugin-description-drift: no base branch. Looked for origin/main, main,');
  console.log('  origin/master, master. Expected in a shallow checkout, and not a failure,');
  console.log('  but nothing here was verified either.');
  console.log('\nNOT RUN, 0 descriptions verified, no base branch to compare against');
  process.exit(0);
}

const mergeBase = git(['merge-base', base, 'HEAD']);
if (!mergeBase) {
  console.log(`plugin-description-drift: no merge base with ${base}.`);
  console.log('  A shallow clone has no shared history to work from. Fetch more depth to');
  console.log('  turn this back on: git fetch --unshallow, or fetch-depth: 0 in CI.');
  console.log(`\nNOT RUN, 0 descriptions verified, no merge base with ${base}`);
  process.exit(0);
}

// Returns { moved, still, absent } for one plugin. `absent` is a surface that
// does not exist on either side, which is not the same as one that did not move.
function compare(name) {
  const moved = [];
  const still = [];
  const absent = [];
  for (const surface of SURFACES) {
    const before = surface.read(mergeBase, name);
    const now = surface.read(WORKTREE, name);
    if (before === null && now === null) absent.push(surface);
    else if (before === now) still.push(surface);
    else moved.push(surface);
  }
  return { moved, still, absent };
}

const results = plugins.map((name) => ({ name, ...compare(name) }));
const touched = results.filter((r) => r.moved.length);

const baseWhen = git(['log', '-1', '--format=%h %ad', '--date=short', base]) || base;
console.log(`plugin-description-drift: against ${base} (${baseWhen}), `
  + `${touched.length} plugin description(s) changed of ${plugins.length}\n`);

if (!touched.length) {
  console.log('  ok    no plugin description changed, so no copy of one needs to move');
  console.log('\n1 checks, 0 failed');
  process.exit(0);
}

for (const r of touched) {
  check(`${r.name} description changed, so every copy of it moved`, () => {
    // A plugin new on this branch has no earlier description anywhere, so every
    // surface reads as moved and there is nothing to be inconsistent with.
    if (!r.still.length) return;

    const stale = r.still.map((s) => `          ${s.where(r.name)}  ${s.label}`).join('\n');
    const done = r.moved.map((s) => s.label).join(', ');

    assert.fail(`${r.moved.length} of ${r.moved.length + r.still.length} places that describe `
      + `${r.name} changed on this branch. These did not:\n${stale}\n`
      + `        Already updated: ${done}.\n`
      + `        All of them describe the same plugin to a different reader, so one left `
      + `behind is a description of a product that no longer exists.`);
  });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
