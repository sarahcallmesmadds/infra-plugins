#!/usr/bin/env node
// Every plugin declares its version three times, and all three have to agree.
//
// Run: node tests/plugin-versions.test.js
//
// The three places are the marketplace entry, the Claude manifest and the Codex
// manifest. Nothing checked they matched, and the failure is quiet in a way
// that wastes real time.
//
// What it looks like when it goes wrong: a fix is merged to main, the plugin is
// updated, the update reports success, and nothing changes. The plugin manager
// compares the version it has against the version on offer, so if the number
// did not move it has no reason to fetch anything. The code is on main and the
// old code is still running, and every symptom points at the code rather than
// at the number.
//
// That happened with session 0.3.0, where `forget` sat on main unreachable
// through a successful-looking update. Adding this check then found two plugins
// already drifted: build-loop, whose Codex manifest was a release behind, and
// slop-check, the same. Both had gone unnoticed.
//
// The rule is agreement, not any particular value. Bumping is a decision this
// makes no claim about. Whether the three files say the same thing is not a
// decision, and it is the part nobody can hold in their head across six plugins
// and eighteen files.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MARKETPLACE = path.join(REPO, '.claude-plugin', 'marketplace.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The Codex manifest is optional. A plugin that does not ship one is not
// broken, so it is checked only where it exists. A plugin that does ship one
// and disagrees is the case this file is for.
function manifests(name) {
  const out = {};
  for (const [label, dir] of [['claude', '.claude-plugin'], ['codex', '.codex-plugin']]) {
    const file = path.join(REPO, 'plugins', name, dir, 'plugin.json');
    if (fs.existsSync(file)) out[label] = { file, version: readJson(file).version };
  }
  return out;
}

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

const marketplace = readJson(MARKETPLACE);

check('the marketplace lists at least one plugin', () => {
  // Without this the loop below passes by iterating over nothing, which is the
  // way a suite like this quietly stops testing anything.
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length,
    'marketplace.json has no plugins array, so every check below is vacuous');
});

for (const entry of marketplace.plugins) {
  check(`${entry.name} declares one version in every file that carries it`, () => {
    const found = manifests(entry.name);
    assert.ok(Object.keys(found).length, `no manifest found for ${entry.name}`);

    const disagree = Object.entries(found)
      .filter(([, m]) => m.version !== entry.version)
      .map(([label, m]) => `${label} says ${m.version} (${path.relative(REPO, m.file)})`);

    assert.strictEqual(
      disagree.length, 0,
      `marketplace says ${entry.version}, but ${disagree.join(', ')}. `
      + 'A plugin whose declared version does not move is not fetched, so a merged fix '
      + 'can sit on main while a successful-looking update changes nothing.'
    );
  });
}

check('every plugin directory has a marketplace entry', () => {
  // The other direction. A plugin present on disk and absent from the
  // marketplace is installable by nobody, and nothing else would say so.
  const listed = new Set(marketplace.plugins.map((p) => p.name));
  const onDisk = fs.readdirSync(path.join(REPO, 'plugins'))
    .filter((d) => fs.existsSync(path.join(REPO, 'plugins', d, '.claude-plugin', 'plugin.json')));
  const missing = onDisk.filter((d) => !listed.has(d));
  assert.deepStrictEqual(missing, [], `these plugins exist on disk but are not in the marketplace: ${missing.join(', ')}`);
});

check('the comparison would actually catch a mismatch', () => {
  // A linter nobody has seen fail is a linter nobody should trust.
  const entry = { name: 'x', version: '1.0.0' };
  const found = { claude: { file: 'a', version: '1.0.0' }, codex: { file: 'b', version: '0.9.0' } };
  const disagree = Object.entries(found).filter(([, m]) => m.version !== entry.version);
  assert.strictEqual(disagree.length, 1, 'a manifest a release behind was not noticed');
  assert.strictEqual(disagree[0][0], 'codex', 'the wrong manifest was blamed');
});

const total = marketplace.plugins.length + 3;
console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
