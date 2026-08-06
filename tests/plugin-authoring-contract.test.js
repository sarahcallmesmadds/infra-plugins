#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PLUGINS = path.join(REPO, 'plugins');
const ROOT_README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const GUIDE = fs.readFileSync(path.join(REPO, 'CONTRIBUTING.md'), 'utf8');

const names = fs.readdirSync(PLUGINS).sort().filter((name) =>
  fs.existsSync(path.join(PLUGINS, name, '.claude-plugin', 'plugin.json')));

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
