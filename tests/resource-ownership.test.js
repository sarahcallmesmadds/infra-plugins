#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LEASE_TTL_MS, activeOwner, atomicWriteLease, bashWritesPath, contains, loadRegistry,
  matchedResource, leasePath, readLease, readsInTranscript, resourcePaths, unreadRequirements,
  writeLease,
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

check('the shipped registry names nobody in particular', () => {
  // A personal project folder in the product registry means every installer
  // carries a rule that only means something on the author's machine, and any
  // user who happens to have that folder is blocked until they open a document
  // that does not exist for them. Machine-specific policy belongs in
  // ~/.claude/guardrails.resources.json.
  const locations = registry.flatMap((resource) => [
    ...resourcePaths(resource), ...(resource.requiresRead || []),
  ]);
  const personal = locations.filter((location) => !/^~\/(?:\.claude|\.planning)\//.test(location));
  assert.deepStrictEqual(personal, [],
    `only locations this marketplace's own skills write may ship: ${personal.join(', ')}`);
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

// ------------------------------------------------ read-before-write gate ----
//
// Added 2026-08-09. An approved design system sat in a document nobody opened
// for three days while a homepage was built against nothing and thrown away.
// Owning a resource and requiring a document be read first are different
// questions, so they are separate gates on the same resource.

// The policy under test is a fixture in a temporary HOME, never the shipped
// registry and never the developer's own. A user registry replaces the shipped
// list outright, so a suite that spawns the guard with the ambient environment
// asserts against whatever policy the machine running it happens to carry.
const GUARD = path.join(ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owner-guard.js');

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-read-home-')));
  const worktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-read-tree-')));
  const standard = path.join(home, '.planning', 'DECISION-design-system.md');
  const canonical = path.join(home, 'Projects', 'thing', 'site');
  const mirrored = path.join(worktree, 'site');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.planning'), { recursive: true });
  fs.mkdirSync(canonical, { recursive: true });
  fs.mkdirSync(mirrored, { recursive: true });
  fs.writeFileSync(standard, 'the approved design system');
  const site = {
    id: 'guarded-site',
    label: 'the guarded site',
    type: 'directory',
    path: `${canonical}/`,
    paths: [`${mirrored}/`],
    owners: [],
    requiresRead: [standard],
    readReason: 'A build that ignored it was thrown away after five days.',
  };
  fs.writeFileSync(path.join(home, '.claude', 'guardrails.resources.json'), JSON.stringify({
    $schema_version: 1,
    resources: [
      { id: 'session-handoffs', label: 'session handoffs', type: 'directory', path: '~/.planning/handoffs/', owners: ['session:wrap'] },
      site,
    ],
  }));
  return {
    home, standard, site, canonical, mirrored,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(worktree, { recursive: true, force: true });
    },
  };
}

function withFixture(fn) {
  const built = fixture();
  try { return fn(built); }
  finally { built.cleanup(); }
}

function guard(event, home) {
  const env = { ...process.env, HOME: home };
  const run = spawnSync(process.execPath, [GUARD], { env, input: JSON.stringify(event), encoding: 'utf8' });
  try { return JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason; }
  catch (_) { return null; }
}

function transcriptWith(files) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), 't.jsonl');
  fs.writeFileSync(file, files.map((f) => JSON.stringify({
    type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: f } }] },
  })).join('\n'));
  return file;
}

check('a resource covers every path it lists, not only the first', () => {
  // The worktree case. A checkout lives in two places while a branch is in
  // flight, and a guard that knows only the canonical path is off exactly when
  // the work is happening.
  withFixture(({ site, canonical, mirrored }) => {
    assert.ok(resourcePaths(site).length > 1);
    assert.ok(contains(site, path.join(canonical, 'index.html'), '/tmp'));
    assert.ok(contains(site, path.join(mirrored, 'index.html'), '/tmp'));
    assert.ok(!contains(site, path.join(canonical, '..', 'README.md'), '/tmp'),
      'the guard must not cover the whole repository');
  });
});

check('a bash write is caught through any spelling of the same place', () => {
  // Judged with `contains` rather than by string comparison against the
  // registry entry, so a symlinked route reaches the same verdict. On macOS
  // /tmp is a symlink to /private/tmp, which is exactly how a worktree gets
  // written through a spelling nobody registered.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-bash-')));
  try {
    const real = path.join(temp, 'real');
    const alias = path.join(temp, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const resource = { id: 'r', type: 'directory', path: `${real}/` };
    const out = path.join(alias, 'out.txt');
    assert.ok(bashWritesPath(`echo x > ${out}`, resource, temp), 'a redirect through the alias');
    assert.ok(bashWritesPath(`sudo tee ${out}`, resource, temp), 'a write command behind sudo');
    assert.ok(!bashWritesPath(`cat ${out}`, resource, temp), 'reading is not writing');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('a subcommand that shares a write command name is not a write', () => {
  // A bare argument resolves against the event cwd, so anyone whose shell sits
  // inside a guarded directory would have `npm install` read as a write to it
  // if the verb were matched in any token position rather than at the program
  // name. Judged from inside the directory, which is where it goes wrong.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owner-verb-')));
  try {
    const resource = { id: 'r', type: 'directory', path: `${temp}/` };
    for (const command of [
      'npm install --prefix ./x', 'yarn install', 'pip install requests',
      'make install DESTDIR=./out', 'docker rm mycontainer', 'git commit -m wip',
      'find /etc -name x -exec rm {} \\;', 'touch /tmp/scratch',
    ]) {
      assert.ok(!bashWritesPath(command, resource, temp), `blocked: ${command}`);
    }
    for (const command of ['rm f.txt', 'mkdir -p build', 'git rm --cached f.txt', 'FOO=bar rm f.txt']) {
      assert.ok(bashWritesPath(command, resource, temp), `allowed through: ${command}`);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

check('reads are counted from the transcript, and only Read tool calls', () => {
  // Compared through realpath on both sides. On macOS /tmp is a symlink to
  // /private/tmp, and resolving that is the point: a handoff and an edit can
  // spell the same file two ways, and the gate has to see them as one.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')));
  const target = path.join(dir, 'a.md');
  fs.writeFileSync(target, 'x');
  const seen = readsInTranscript(transcriptWith([target]));
  assert.ok(seen.has(target), [...seen].join(', '));

  const catOnly = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), 't.jsonl');
  fs.writeFileSync(catOnly, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat /tmp/a.md' } }] },
  }));
  assert.strictEqual(readsInTranscript(catOnly).size, 0,
    'scrolling a file past in a shell is not the same as having it loaded, which is the whole point of the gate');
});

check('an unreadable transcript is not treated as nobody having read it', () => {
  // Every hook here fails open. This is the one gate that could turn "we
  // cannot tell" into a refusal that never lifts, because it would name a
  // document the person may already have open.
  withFixture(({ site }) => {
    assert.strictEqual(readsInTranscript(undefined), null, 'a missing transcript path');
    assert.strictEqual(readsInTranscript('/nonexistent/transcript.jsonl'), null, 'an unreadable transcript');
    assert.deepStrictEqual(unreadRequirements(site, undefined, '/tmp'), []);
    assert.deepStrictEqual(unreadRequirements(site, '/nonexistent/transcript.jsonl', '/tmp'), []);
  });
});

check('a resource requiring nothing is never gated on reading', () => {
  assert.deepStrictEqual(unreadRequirements(handoffs, transcriptWith([]), '/tmp'), [],
    'every resource that existed before this must be unaffected');
});

check('the gate blocks a site edit until the governing document is read', () => {
  withFixture(({ home, mirrored }) => {
    const reason = guard({
      session_id: 's', cwd: '/tmp', transcript_path: transcriptWith(['/tmp/unrelated.md']),
      tool_name: 'Edit', tool_input: { file_path: path.join(mirrored, 'index.html') },
    }, home);
    assert.ok(reason, 'the edit was allowed through');
    assert.match(reason, /DECISION-design-system\.md/,
      'the block must name the document, or it is a wall rather than an instruction');
    assert.match(reason, /thrown away/, 'the reason the rule exists is what stops it being deleted as noise');
  });
});

check('the gate opens once the document has been read', () => {
  withFixture(({ home, standard, mirrored }) => {
    const reason = guard({
      session_id: 's', cwd: '/tmp', transcript_path: transcriptWith([standard]),
      tool_name: 'Edit', tool_input: { file_path: path.join(mirrored, 'index.html') },
    }, home);
    assert.strictEqual(reason, null, 'the gate stayed shut after the document was read');
  });
});

check('the gate opens when the guard cannot read the transcript at all', () => {
  withFixture(({ home, mirrored }) => {
    const reason = guard({
      session_id: 's', cwd: '/tmp',
      tool_name: 'Edit', tool_input: { file_path: path.join(mirrored, 'index.html') },
    }, home);
    assert.strictEqual(reason, null,
      'an unavailable transcript refused the write with no way through');
  });
});

check('a resource with no owners is not blocked for lacking one', () => {
  // The site has requiresRead and no owners. Before the guard split the two
  // questions, an empty owners list would have blocked every write with a
  // message naming no skill at all.
  withFixture(({ home, standard, canonical }) => {
    const reason = guard({
      session_id: 's', cwd: '/tmp', transcript_path: transcriptWith([standard]),
      tool_name: 'Write', tool_input: { file_path: path.join(canonical, 'new.html') },
    }, home);
    assert.strictEqual(reason, null);
  });
});

check('ownership still blocks independently of reading', () => {
  withFixture(({ home }) => {
    const reason = guard({
      session_id: 's', cwd: '/tmp', transcript_path: transcriptWith([]),
      tool_name: 'Edit', tool_input: { file_path: path.join(home, '.planning', 'handoffs', 'HANDOFF-x.md') },
    }, home);
    assert.match(reason, /owned by \/session:wrap/,
      'the ownership gate regressed when the read gate was added');
  });
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
