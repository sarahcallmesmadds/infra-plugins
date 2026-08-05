#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LEASE_TTL_MS, activeOwner, atomicWriteLease, contains, loadRegistry, matchedResource,
  leasePath, readLease, writeLease,
} = require('../plugins/guardrails/scripts/resource-ownership');

const ROOT = path.join(__dirname, '..');
const registry = JSON.parse(fs.readFileSync(path.join(
  ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owners.json'
), 'utf8')).resources;
const handoffs = registry.find((resource) => resource.id === 'session-handoffs');

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}

check('the shipped registry protects handoffs and the bug queue', () => {
  assert.deepStrictEqual(registry.map((resource) => resource.id), [
    'session-handoffs', 'build-loop-bug-queue',
  ]);
  assert.deepStrictEqual(handoffs.owners, ['session:wrap']);
});

check('directory matching respects path boundaries', () => {
  assert.ok(contains(handoffs, '~/.planning/handoffs/HANDOFF-x.md', '/tmp'));
  assert.ok(!contains(handoffs, '~/.planning/handoffs-old/HANDOFF-x.md', '/tmp'));
});

check('directory matching resolves symlinked destinations', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-symlink-'));
  try {
    const protectedDir = path.join(temp, 'protected');
    const alias = path.join(temp, 'alias');
    fs.mkdirSync(protectedDir);
    fs.symlinkSync(protectedDir, alias);
    assert.ok(contains({ type: 'directory', path: protectedDir }, path.join(alias, 'new.md'), temp));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('a malformed custom registry falls back to the shipped policy', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-registry-'));
  try {
    const pluginRoot = path.join(temp, 'plugin');
    const fakeHome = path.join(temp, 'home');
    fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'hooks', 'resource-owners.json'), JSON.stringify({ resources: [{ id: 'default' }] }));
    fs.writeFileSync(path.join(fakeHome, '.claude', 'guardrails.resources.json'), '{broken');
    assert.deepStrictEqual(loadRegistry(pluginRoot, fakeHome), [{ id: 'default' }]);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('Write and Edit events resolve a protected destination', () => {
  for (const tool_name of ['Write', 'Edit', 'NotebookEdit']) {
    const key = tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
    const found = matchedResource({
      tool_name,
      tool_input: { [key]: path.join(os.homedir(), '.planning', 'handoffs', 'one.md') },
      cwd: '/tmp',
    }, registry);
    assert.strictEqual(found && found.id, 'session-handoffs');
  }
});

check('reads and unrelated writes are ignored', () => {
  assert.strictEqual(matchedResource({ tool_name: 'Read', tool_input: { file_path: '~/.planning/handoffs/x' } }, registry), null);
  assert.strictEqual(matchedResource({ tool_name: 'Write', tool_input: { file_path: '/tmp/x' } }, registry), null);
});

check('common Bash writes are caught but reads and stderr redirects are not', () => {
  const event = (command) => matchedResource({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' }, registry);
  assert.strictEqual(event('tee ~/.planning/handoffs/x.md').id, 'session-handoffs');
  assert.strictEqual(event('cp x ~/.claude/build-loop/queue/x.json').id, 'build-loop-bug-queue');
  assert.strictEqual(event('cp ~/.planning/handoffs/x.md /tmp/x.md'), null);
  assert.strictEqual(event('rm /tmp/x && ls ~/.planning/handoffs/'), null);
  assert.strictEqual(event('rm /tmp/x\ncat ~/.planning/handoffs/x.md'), null);
  assert.strictEqual(event("sed -i 's|~/.planning/handoffs|/tmp/out|' /tmp/config"), null);
  assert.strictEqual(event("sed -i 's|old|new|' ~/.planning/handoffs/x.md").id, 'session-handoffs');
  assert.strictEqual(event('cat ~/.planning/handoffs/x.md'), null);
  assert.strictEqual(event('ls ~/.planning/handoffs/ 2>/dev/null'), null);
});

check('an owning skill opens a session-scoped lease', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-lease-'));
  try {
    writeLease('session:wrap', 'session-a', 1000, temp);
    assert.strictEqual(activeOwner(handoffs, 'session-a', 1001, temp), 'session:wrap');
    assert.strictEqual(activeOwner(handoffs, 'session-b', 1001, temp), null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('default leases live under a private per-user directory', () => {
  const file = leasePath('session:wrap', 'session-a');
  assert.strictEqual(path.dirname(file), path.join(os.homedir(), '.claude', 'guardrails-leases'));
});

check('a lease expires after 30 minutes even when the session stays active', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-expiry-'));
  try {
    writeLease('session:wrap', 'session-a', 1000, temp);
    assert.ok(readLease('session:wrap', 'session-a', 1000 + LEASE_TTL_MS - 1, temp));
    assert.strictEqual(readLease('session:wrap', 'session-a', 1000 + LEASE_TTL_MS, temp), null);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('lease replacement never truncates the live record', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-atomic-'));
  try {
    const live = path.join(temp, 'lease.json');
    fs.writeFileSync(live, JSON.stringify({ touchedAt: 1 }));
    const originalWrite = fs.writeFileSync;
    const written = [];
    fs.writeFileSync = (file, ...args) => {
      written.push(file);
      return originalWrite(file, ...args);
    };
    try { atomicWriteLease(live, { touchedAt: 2 }); }
    finally { fs.writeFileSync = originalWrite; }
    assert.ok(written.length === 1 && written[0] !== live, 'the live lease was opened for writing');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(live, 'utf8')), { touchedAt: 2 });
    assert.deepStrictEqual(fs.readdirSync(temp), ['lease.json']);
    assert.strictEqual(fs.statSync(temp).mode & 0o777, 0o700);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('the wired hooks deny a bypass and allow the owning skill', () => {
  const session_id = `resource-owner-test-${process.pid}-${Date.now()}`;
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-hook-home-'));
  const env = { ...process.env, HOME: testHome };
  const guard = path.join(ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owner-guard.js');
  const lease = path.join(ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owner-lease.js');
  const writeEvent = {
    hook_event_name: 'PreToolUse', session_id, cwd: '/tmp', tool_name: 'Write',
    tool_input: { file_path: path.join(testHome, '.planning', 'handoffs', 'x.md'), content: 'x' },
  };

  try {
    let run = spawnSync(guard, { env, input: JSON.stringify(writeEvent), encoding: 'utf8' });
    assert.strictEqual(run.status, 0);
    assert.strictEqual(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'deny');

    run = spawnSync(lease, { input: JSON.stringify({
      hook_event_name: 'PostToolUse', session_id, cwd: '/tmp', tool_name: 'Skill',
      tool_input: { skill: 'session:wrap' }, tool_response: {},
    }), env, encoding: 'utf8' });
    assert.strictEqual(run.status, 0);

    run = spawnSync(guard, { env, input: JSON.stringify(writeEvent), encoding: 'utf8' });
    assert.strictEqual(run.status, 0);
    assert.strictEqual(run.stdout, '');
  } finally { fs.rmSync(testHome, { recursive: true, force: true }); }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
