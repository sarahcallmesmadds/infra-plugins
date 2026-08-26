#!/usr/bin/env node
// Exercise plugin-version-drift.test.js against disposable repositories so its
// answer does not depend on whatever happens to be edited in this checkout.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CHECK = path.join(__dirname, 'plugin-version-drift.test.js');

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${error.message}`);
  }
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-version-drift-'));
  const git = (...args) => execFileSync('git', [
    '-C', repo,
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (relative, contents) => {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };

  git('init', '-q', '-b', 'main');
  write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  write('plugins/demo/README.md', '# Demo\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  git('checkout', '-qb', 'feature');

  return {
    repo,
    git,
    write,
    run() {
      const result = spawnSync(process.execPath, [CHECK], {
        encoding: 'utf8',
        env: { ...process.env, PLUGIN_VERSION_DRIFT_REPO: repo },
      });
      return {
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
      };
    },
    remove() {
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function withFixture(fn) {
  const f = fixture();
  try {
    fn(f);
  } finally {
    f.remove();
  }
}

function assertMissingBump(result, file) {
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /version is still 1\.0\.0/, result.output);
  assert.match(result.output, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), result.output);
}

check('a clean branch passes', () => withFixture((f) => {
  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /no plugin changed/, result.output);
}));

check('an unstaged plugin edit fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('a staged plugin edit fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.git('add', 'plugins/demo/README.md');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('an untracked plugin file fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/new.js', 'module.exports = {};\n');
  assertMissingBump(f.run(), 'plugins/demo/new.js');
}));

check('a worktree version bump satisfies a worktree edit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');
  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /1 checks, 0 failed/, result.output);
}));

check('a committed plugin edit without a bump still fails', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.git('add', 'plugins/demo/README.md');
  f.git('commit', '-qm', 'change plugin');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
