#!/usr/bin/env node
// A plugin whose description changed has to say so everywhere it is described.
//
// Run: node tests/plugin-description-drift.test.js
//
// plugin-authoring-contract.test.js asks whether each plugin is listed in the
// root README. It always was. This asks the other question: whether the listing
// still says the right thing, which needs a comparison against history and
// cannot be answered from the working tree alone.
//
// ---------------------------------------------------------------------------
// Why this exists.
//
// A plugin's description lives in four places: its Claude manifest, its Codex
// manifest, the marketplace entry, and the row in the root README. The first
// three sit next to each other and get edited together. The fourth is in a
// different file, at the top of the repository, and is the one that gets left.
//
// PR #122 widened slop-check from a checker to a checker and a rewriter, and
// updated three of the four. The root README row still described it as
// check-only, so the one surface a person reads before installing anything was
// the one surface that was wrong. Devin caught it and noted that nothing would
// have. That note is this file.
//
// ---------------------------------------------------------------------------
// The tradeoff, stated rather than hidden.
//
// This fires on any change to a manifest description, including fixing a typo,
// and then asks for a README edit that a typo does not really need. That is the
// same asymmetry plugin-version-drift.test.js settles the same way: an
// unnecessary edit costs a minute, and a missed one ships a description of a
// product that no longer exists to everyone deciding whether to install it.
//
// It compares the README row to itself across the branch, not to the manifest
// text. The row is deliberately a different sentence for a different reader, so
// requiring the two to match would be requiring the wrong thing.
//
// ---------------------------------------------------------------------------
// The "now" side is the working tree, not HEAD.
//
// plugin-version-drift.test.js reads committed state for both sides, and queue
// entry 2026-08-11T01-25-00-plugin-version-drift-test records what that costs:
// the full suite is run before committing, which is the normal order, so the
// check is silent at the only moment anyone can act on it, and the green run
// gets read as confirmation the bump was done. Devin found the missing bump
// instead, at the stage the test exists to make unnecessary.
//
// So the fork point comes from history, because it has to, and everything it is
// compared against comes from the files as they stand. Editing the description
// and running the suite fails immediately, before the commit, which is the point.

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

function descriptionAt(ref, name) {
  const raw = fileAt(ref, `plugins/${name}/.claude-plugin/plugin.json`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw).description || null;
  } catch (_) {
    return null;
  }
}

function marketplaceDescriptionAt(ref, name) {
  const raw = fileAt(ref, '.claude-plugin/marketplace.json');
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw).plugins.find((p) => p.name === name);
    return entry ? entry.description || null : null;
  } catch (_) {
    return null;
  }
}

// The row a reader sees before they install anything. Found by the link target
// rather than by the plugin name in prose, because the name appears in other
// rows' text and in the paragraphs around the table.
function readmeRowAt(ref, name) {
  const raw = fileAt(ref, 'README.md');
  if (raw === null) return null;
  const marker = `](plugins/${name})`;
  for (const line of raw.split('\n')) {
    if (line.includes(marker)) return line.trim();
  }
  return null;
}

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

const moved = plugins.filter((name) => {
  const before = descriptionAt(mergeBase, name);
  const now = descriptionAt(WORKTREE, name);
  // A plugin that did not exist at the fork point is new. There is no earlier
  // description for it to differ from, and the authoring contract already
  // requires it to appear in the README at all.
  return before !== null && now !== null && before !== now;
});

const baseWhen = git(['log', '-1', '--format=%h %ad', '--date=short', base]) || base;
console.log(`plugin-description-drift: against ${base} (${baseWhen}), `
  + `${moved.length} description(s) changed of ${plugins.length}\n`);

if (!moved.length) {
  console.log('  ok    no plugin description changed, so no other copy needs to move');
  console.log('\n1 checks, 0 failed');
  process.exit(0);
}

for (const name of moved) {
  check(`${name} description changed, so its root README row moved`, () => {
    const before = readmeRowAt(mergeBase, name);
    const now = readmeRowAt(WORKTREE, name);

    // Missing entirely is a different fault with its own test. Failing here too
    // would report one mistake twice and point at the wrong fix.
    if (before === null || now === null) {
      console.log(`        note: no root README row for ${name}. `
        + 'plugin-authoring-contract.test.js owns that.');
      return;
    }

    assert.notStrictEqual(now, before,
      `plugins/${name}/.claude-plugin/plugin.json changed its description on this branch, but `
      + `the row in the root README.md is unchanged. That row is what someone reads before `
      + `deciding to install, so it is now the one stale copy of the description.\n`
      + `        row: ${now}`);
  });

  check(`${name} description changed, so its marketplace entry moved`, () => {
    const before = marketplaceDescriptionAt(mergeBase, name);
    const now = marketplaceDescriptionAt(WORKTREE, name);

    if (before === null || now === null) {
      console.log(`        note: no marketplace entry for ${name}. `
        + 'Registering it is part of the authoring checklist.');
      return;
    }

    assert.notStrictEqual(now, before,
      `plugins/${name}/.claude-plugin/plugin.json changed its description on this branch, but `
      + `the marketplace entry in .claude-plugin/marketplace.json is unchanged. The marketplace `
      + `text is what the plugin browser shows, so it is now the stale copy.\n`
      + `        entry: ${now}`);
  });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
