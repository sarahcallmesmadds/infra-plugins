#!/usr/bin/env node
// End-to-end contract for the structured destination root written by
// /to-build and consumed by /built-check through roots.js coverage.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const PLUGIN = path.join(REPO, 'plugins', 'build-loop');
const toBuild = fs.readFileSync(path.join(PLUGIN, 'skills', 'to-build', 'SKILL.md'), 'utf8');
const builtCheck = fs.readFileSync(path.join(PLUGIN, 'skills', 'built-check', 'SKILL.md'), 'utf8');
const schema = fs.readFileSync(path.join(PLUGIN, 'reference', 'SCHEMA-BUILD.md'), 'utf8');
const queue = path.join(PLUGIN, 'scripts', 'queue.js');
const roots = path.join(PLUGIN, 'scripts', 'roots.js');

let failed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

check('writer, schema and consumer use the same field', () => {
  assert.match(schema, /\| `destination_root` \| string \| no \|/);
  assert.match(toBuild, /^Destination root: \{destination_root,/m);
  assert.match(toBuild, /^destination_root:\s+\{destination_root,/m);
  assert.match(builtCheck, /carry `destination_root`, an exact build-loop root name/);
  assert.match(builtCheck, /root already in the config or one the user expects to add later/);
  assert.match(builtCheck, /intentionally returns `not-configured` until that root is added/);
});

check('authoring selects exact root names and never parses where prose', () => {
  assert.match(toBuild, /user\s+explicitly named a root by that exact name/);
  assert.match(toBuild, /Never extract it from a repository\s+URL, filesystem path, marketplace name or other `where` prose/);
  assert.match(toBuild, /Do not infer the key from `where`/);
});

check('a created item reaches the exact coverage consumer', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-build-destination-'));
  try {
    const claude = path.join(home, '.claude');
    const root = path.join(home, 'work');
    const scratch = path.join(home, 'scratch');
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(path.join(claude, 'build-loop', 'to-build'), { recursive: true });
    fs.mkdirSync(root);
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(claude, 'build-loop.config.json'), JSON.stringify({
      roots: [{ name: 'work', path: root, kind: 'plugin-repo' }],
    }));

    const id = '2026-08-15T22-00-00-explicit-root';
    const item = {
      $schema_version: 1,
      id,
      created_at: '2026-08-16T02:00:00.000Z',
      status: 'Open',
      title: 'Explicit root',
      kind: 'plugin',
      what: 'Prove the writer and coverage consumer agree.',
      why: '',
      where: 'https://example.invalid/not-the/root',
      destination_root: 'work',
      source: '',
      blocked_by: '',
      session_id: '',
      session_cwd: '',
      dedup_key: 'to-build::explicit-root',
      notes: [],
      built: null,
    };
    const input = path.join(scratch, `${id}.json`);
    fs.writeFileSync(input, JSON.stringify(item, null, 2));
    const env = { ...process.env, HOME: home };
    execFileSync(process.execPath, [queue, 'create', input, '--list', 'to-build', '--dedup-window', 'all'], {
      env, stdio: 'pipe',
    });

    const stored = JSON.parse(fs.readFileSync(path.join(claude, 'build-loop', 'to-build', `${id}.json`), 'utf8'));
    assert.strictEqual(stored.destination_root, 'work');
    const nameFile = path.join(scratch, 'destination.txt');
    fs.writeFileSync(nameFile, stored.destination_root);
    const result = JSON.parse(execFileSync(process.execPath, [roots, 'coverage', '--name-file', nameFile], {
      env, encoding: 'utf8',
    }));
    assert.deepStrictEqual(result, { answer: 'covered', root: 'work' });

    fs.writeFileSync(nameFile, 'future-root');
    const future = JSON.parse(execFileSync(process.execPath, [roots, 'coverage', '--name-file', nameFile], {
      env, encoding: 'utf8',
    }));
    assert.deepStrictEqual(future, { answer: 'not-configured', root: 'future-root' });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
