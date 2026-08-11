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

// ------------------------------------------------- the requiresRead gate ----

const {
  bashWritesPath, matchedResources, readsInTranscript, resourcePaths, unreadRequirements,
} = require('../plugins/guardrails/scripts/resource-ownership');

// A transcript line in the shape the gate reads: a Read tool_use with a path.
let toolUseId = 0;
function readLine(file, extra = {}) {
  const id = `toolu_${++toolUseId}`;
  return {
    id,
    line: JSON.stringify({
      message: {
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file, ...extra } }],
      },
    }),
  };
}

function resultLine(id, isError) {
  return JSON.stringify({
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
  });
}

function transcriptWith(files) {
  return files.map((file) => readLine(file).line).join('\n') + '\n';
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requires-read-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

check('a resource with no requiresRead is unaffected', () => {
  assert.deepStrictEqual(unreadRequirements(handoffs, null, '/tmp'), []);
  assert.deepStrictEqual(unreadRequirements({ ...handoffs, requiresRead: [] }, null, '/tmp'), []);
});

check('a required document blocks until it is read, then stops blocking', () => {
  withTemp((dir) => {
    const doc = path.join(dir, 'DECISION.md');
    fs.writeFileSync(doc, '# decision\n');
    const resource = { id: 'r', type: 'directory', path: path.join(dir, 'site'), requiresRead: [doc] };

    const nothingRead = path.join(dir, 'a.jsonl');
    fs.writeFileSync(nothingRead, transcriptWith([path.join(dir, 'unrelated.md')]));
    assert.deepStrictEqual(unreadRequirements(resource, nothingRead, dir), [doc],
      'the document has not been read, so it must be reported');

    const wasRead = path.join(dir, 'b.jsonl');
    fs.writeFileSync(wasRead, transcriptWith([doc]));
    assert.deepStrictEqual(unreadRequirements(resource, wasRead, dir), [],
      'and reading it must lift the gate');
  });
});

// The one gate that could refuse a write with no way through. Every hook in
// this plugin fails open, and an unreadable record looks exactly like a session
// where nothing was read, so a block would tell someone to open a document they
// may already have open and would never lift.
check('an unavailable session record fails open rather than blocking forever', () => {
  withTemp((dir) => {
    const doc = path.join(dir, 'DECISION.md');
    fs.writeFileSync(doc, '# decision\n');
    const resource = { id: 'r', type: 'directory', path: path.join(dir, 'site'), requiresRead: [doc] };

    assert.strictEqual(readsInTranscript(null, dir), null, 'no path is not an empty set');
    assert.strictEqual(readsInTranscript(path.join(dir, 'missing.jsonl'), dir), null,
      'and neither is a path that cannot be read');
    assert.deepStrictEqual(unreadRequirements(resource, null, dir), [],
      'no record, no block');
    assert.deepStrictEqual(unreadRequirements(resource, path.join(dir, 'missing.jsonl'), dir), [],
      'unreadable record, no block');
  });
});

// Asking for a file and receiving it are different events, and only the second
// means the document is loaded. A Read that hit a missing file or a refused
// permission leaves a record identical in shape to one that worked.
check('a read that failed does not satisfy the gate, and one with no result still does', () => {
  withTemp((dir) => {
    const doc = path.join(dir, 'DECISION.md');
    fs.writeFileSync(doc, '# decision\n');
    const resource = { id: 'r', type: 'directory', path: path.join(dir, 'site'), requiresRead: [doc] };

    const failed = readLine(doc);
    const errored = path.join(dir, 'errored.jsonl');
    fs.writeFileSync(errored, `${failed.line}\n${resultLine(failed.id, true)}\n`);
    assert.deepStrictEqual(unreadRequirements(resource, errored, dir), [doc],
      'the read errored, so nothing was loaded and the gate must stay shut');

    const ok = readLine(doc);
    const succeeded = path.join(dir, 'ok.jsonl');
    fs.writeFileSync(succeeded, `${ok.line}\n${resultLine(ok.id, false)}\n`);
    assert.deepStrictEqual(unreadRequirements(resource, succeeded, dir), [],
      'and a result that is not an error lifts it');

    // Fail open: a request whose result is not in the record yet is not
    // evidence of failure, and an incomplete record must not hold the gate shut.
    const pending = readLine(doc);
    const inFlight = path.join(dir, 'pending.jsonl');
    fs.writeFileSync(inFlight, `${pending.line}\n`);
    assert.deepStrictEqual(unreadRequirements(resource, inFlight, dir), [],
      'no result recorded is not the same as a result that failed');
  });
});

check('a partial read does not satisfy the gate', () => {
  withTemp((dir) => {
    const doc = path.join(dir, 'DECISION.md');
    fs.writeFileSync(doc, '# decision\n');
    const resource = { id: 'r', type: 'directory', path: path.join(dir, 'site'), requiresRead: [doc] };

    for (const narrowed of [{ offset: 40 }, { limit: 10 }, { offset: 40, limit: 10 }]) {
      const partial = readLine(doc, narrowed);
      const file = path.join(dir, `p${Object.keys(narrowed).join('')}.jsonl`);
      fs.writeFileSync(file, `${partial.line}\n${resultLine(partial.id, false)}\n`);
      assert.deepStrictEqual(unreadRequirements(resource, file, dir), [doc],
        `part of a governing document is not the document: ${JSON.stringify(narrowed)}`);
    }
  });
});

// The refusal has to explain both, or someone who did open the file is left
// arguing with a gate that will not say why their read did not count.
check('the refusal explains why a read might not have counted', () => {
  const guard = fs.readFileSync(path.join(
    ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owner-guard.js'
  ), 'utf8');
  assert.ok(/Read that failed does not count/.test(guard));
  assert.ok(/offset or limit/.test(guard));
});

// An ownerless entry used to block everything, with a refusal reading "is owned
// by" and nothing after it. That was a degenerate message rather than a design,
// but it worked as a blanket deny, so the change is called out in the README.
check('a resource with no owners does not block on the ownership gate', () => {
  withTemp((dir) => {
    const site = path.join(dir, 'site');
    fs.mkdirSync(site);
    const resource = { id: 'r', label: 'r', type: 'directory', path: site, owners: [] };
    const event = {
      tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(site, 'x.html') },
    };
    assert.deepStrictEqual(matchedResources(event, [resource]).map((r) => r.id), ['r'],
      'it still matches, so a requiresRead on it would still apply');
    const readme = fs.readFileSync(path.join(ROOT, 'plugins', 'guardrails', 'README.md'), 'utf8');
    assert.ok(/no `owners` no longer blocks/.test(readme),
      'a silent relaxation of someone else policy has to be written down');
  });
});

check('a resource is guarded at every registered location, not only the first', () => {
  withTemp((dir) => {
    const canonical = path.join(dir, 'canonical');
    const worktree = path.join(dir, 'worktree');
    fs.mkdirSync(canonical); fs.mkdirSync(worktree);
    const resource = { id: 'r', type: 'directory', path: canonical, paths: [worktree] };
    assert.deepStrictEqual(resourcePaths(resource), [canonical, worktree]);
    assert.ok(contains(resource, path.join(canonical, 'index.html'), dir));
    assert.ok(contains(resource, path.join(worktree, 'index.html'), dir),
      'a worktree is where the work happens while a branch is in flight');
    assert.ok(!contains(resource, path.join(dir, 'elsewhere', 'index.html'), dir));
  });
});

// Registry order decided which rules applied when only the first match was
// returned, so a broad entry with owners listed before a nested one with
// requiresRead switched the second gate off entirely.
check('every resource a write touches is evaluated, whatever the registry order', () => {
  withTemp((dir) => {
    const outer = path.join(dir, 'project');
    const inner = path.join(outer, 'site');
    fs.mkdirSync(inner, { recursive: true });
    const broad = { id: 'broad', type: 'directory', path: outer, owners: ['some:skill'] };
    const narrow = { id: 'narrow', type: 'directory', path: inner, requiresRead: [path.join(dir, 'D.md')] };
    const event = {
      tool_name: 'Write', cwd: dir, tool_input: { file_path: path.join(inner, 'index.html') },
    };
    for (const order of [[broad, narrow], [narrow, broad]]) {
      const ids = matchedResources(event, order).map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['broad', 'narrow'],
        'both rules cover this path, so both must come back regardless of order');
    }
  });
});

// The detection here is literal on purpose, and these two lists are the reason.
// A version that resolved every bare argument against the cwd caught more real
// writes and also refused `grep "a>b"` inside a guarded directory. A guard that
// blocks ordinary commands gets switched off, and then it guards nothing.
check('shell detection catches spelled-out writes and leaves ordinary commands alone', () => {
  withTemp((dir) => {
    const site = path.join(dir, 'site');
    fs.mkdirSync(site);
    const resource = { id: 'r', type: 'directory', path: site };

    for (const command of [
      `rm ${site}/f.txt`,
      `tee ${site}/out.txt`,
      `echo hi > ${site}/index.html`,
      `mv a.txt ${site}/b.txt`,
      `cp a.txt ${site}/b.txt`,
      `xargs -0 rm ${site}/f.txt`,
      `sudo -u me rm ${site}/f.txt`,
    ]) {
      assert.ok(bashWritesPath(command, resource, dir), `must catch: ${command}`);
    }

    for (const command of [
      `grep "a>b" ${site}/file`,
      `awk '$3 > 100' ${site}/data.txt`,
      `cat ${site}/file`,
      `ls ${site}`,
      'npm install',
    ]) {
      assert.ok(!bashWritesPath(command, resource, dir), `must not fire on: ${command}`);
    }
  });
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
