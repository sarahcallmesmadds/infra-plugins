#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PLUGINS = path.join(REPO, 'plugins');
const ROOT_README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const GUIDE = fs.readFileSync(path.join(REPO, 'CONTRIBUTING.md'), 'utf8');

// Discover directories, not manifests. A missing Claude manifest is one of the
// failures this suite exists to report, so using that manifest to decide what
// counts as a plugin would make the most important assertion impossible to
// fail.
const names = fs.readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let failed = 0;
let total = 0;
function check(label, fn) {
  total += 1;
  try {
    fn();
    console.log(`  ok    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n        ${error.message}`);
  }
}

check('the repository has an authoring guide with a setup decision gate', () => {
  assert.match(GUIDE, /Does this plugin need setup\?/);
  assert.match(GUIDE, /zero-configuration plugin must work immediately/);
  assert.match(GUIDE, /\/plugin-name:setup/);
});

for (const name of names) {
  const dir = path.join(PLUGINS, name);

  check(`${name} carries the required authoring surfaces`, () => {
    const required = [
      'README.md',
      path.join('.claude-plugin', 'plugin.json'),
      path.join('.codex-plugin', 'plugin.json'),
    ];
    const missing = required.filter((file) => !fs.existsSync(path.join(dir, file)));
    assert.deepStrictEqual(missing, [], `missing: ${missing.join(', ')}`);
  });

  // claude.ai refuses to host a plugin that has a top-level bin/ directory,
  // because the CLI adds that directory to PATH and the approval screen does
  // not show what is in it. The refusal is silent from the repository's side:
  // the account keeps serving the last version it accepted and "check for
  // updates" reports nothing new. Five plugins shipped bin/hook-node from
  // 2026-08-14 and every release after that never reached a claude.ai session.
  check(`${name} has no top-level bin/ directory`, () => {
    assert.ok(
      !fs.existsSync(path.join(PLUGINS, name, 'bin')),
      `plugins/${name}/bin exists, so claude.ai rejects this plugin and every `
      + 'later version of it. Put executables under hooks/ or scripts/ instead.'
    );
  });

  check(`${name} uses its directory name in both manifests`, () => {
    for (const runtime of ['.claude-plugin', '.codex-plugin']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, runtime, 'plugin.json'), 'utf8'));
      assert.strictEqual(manifest.name, name, `${runtime}/plugin.json says ${manifest.name}`);
    }
  });

  check(`${name} is discoverable in the root README`, () => {
    assert.ok(
      ROOT_README.includes(`](plugins/${name})`),
      `README.md does not link to plugins/${name}`
    );
  });
}

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
