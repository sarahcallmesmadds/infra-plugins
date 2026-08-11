#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  contains, loadRegistry, matchedResource,
} = require('../plugins/guardrails/scripts/resource-ownership');

const ROOT = path.join(__dirname, '..');
const shipped = JSON.parse(fs.readFileSync(path.join(
  ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owners.json'
), 'utf8')).resources;

// Path matching is tested against a fixture rather than against the shipped
// registry. It used to read the shipped `session-handoffs` entry, which worked
// only while this plugin shipped a rule pointing at the author's own home
// directory. It no longer ships one, and a test that needs it back is a test
// that depends on the plugin governing somebody else's machine by default.
const handoffs = {
  id: 'session-handoffs',
  label: 'session handoffs',
  type: 'directory',
  path: '~/.planning/handoffs/',
};
const queue = {
  id: 'build-loop-bug-queue',
  label: 'the build-loop bug queue',
  type: 'directory',
  path: '~/.claude/build-loop/queue/',
};
const registry = [handoffs, queue];

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}

// The removal is asserted rather than left to be noticed. Shipping a governed
// directory by default is what put one machine's `~/.planning/handoffs` into
// every install of a public plugin.
check('the plugin governs nothing by default', () => {
  assert.deepStrictEqual(shipped, [], 'the shipped registry is no longer empty');
});

check('no part of the owner gate survives in the module surface', () => {
  const api = require('../plugins/guardrails/scripts/resource-ownership');
  for (const gone of [
    'activeOwner', 'readLease', 'writeLease', 'leasePath', 'atomicWriteLease', 'LEASE_TTL_MS',
  ]) {
    assert.strictEqual(api[gone], undefined, `${gone} is still exported`);
  }
});

check('the lease hook is gone and nothing is wired to it', () => {
  const hooks = path.join(ROOT, 'plugins', 'guardrails', 'hooks');
  assert.ok(!fs.existsSync(path.join(hooks, 'resource-owner-lease.js')), 'the lease hook still exists');
  const manifest = fs.readFileSync(path.join(hooks, 'hooks.json'), 'utf8');
  assert.ok(!manifest.includes('resource-owner-lease'), 'hooks.json still wires the lease hook');
  assert.ok(!manifest.includes('"Skill"'), 'hooks.json still matches the Skill tool');
});

// Run the real guard against a registry we control.
//
// The subprocess loads its own registry off disk and cannot see a resource
// object built in this process, so a spawn test that does not write one is
// asserting nothing. It also has to be given a HOME, or it reads whatever
// policy the person running the suite happens to have in
// ~/.claude/guardrails.resources.json and the result depends on their machine.
//
// Both of those were wrong in the first version of these two tests. They passed
// because nothing matched, which is the same output a working gate produces,
// so they would have passed with the gate still live.
const GUARD_HOOK = path.join(ROOT, 'plugins', 'guardrails', 'hooks', 'resource-owner-guard.js');

// A real but empty transcript is part of the setup, not a detail. With no
// `transcript_path` the requiresRead gate cannot consult the record and fails
// open by design, so a control that omits it never denies and proves nothing.
// An empty transcript is the honest input: the record is readable and shows
// nothing was read.
function withGuardHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, '');

  const runGuard = (resources, filePath, extra = {}) => {
    fs.writeFileSync(
      path.join(home, '.claude', 'guardrails.resources.json'),
      JSON.stringify({ resources })
    );
    return spawnSync(GUARD_HOOK, {
      env: { ...process.env, HOME: home },
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', session_id: 'no-lease-anywhere', cwd: '/tmp',
        transcript_path: transcript,
        tool_name: 'Write', tool_input: { file_path: filePath, content: 'x' }, ...extra,
      }),
      encoding: 'utf8',
    });
  };

  try { fn(home, runGuard); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// The whole point of the removal, stated as a test: a write the gate would have
// refused now goes through, with no lease anywhere on the machine.
//
// The requiresRead case is a control rather than decoration. Without it, an
// empty output proves only that nothing matched, and "the resource was never
// seen" and "the resource was seen and allowed" are the same result. Making the
// same resource at the same path refuse for the other reason is what proves the
// guard is actually reaching it.
check('a write into a formerly owned directory is allowed', () => {
  withGuardHome((home, runGuard) => {
    const target = path.join(home, '.planning', 'handoffs', 'x.md');
    const owned = {
      id: 'session-handoffs', label: 'session handoffs', type: 'directory',
      path: path.join(home, '.planning', 'handoffs'), owners: ['session:wrap'],
    };

    const allowed = runGuard([owned], target);
    assert.strictEqual(allowed.status, 0);
    assert.strictEqual(allowed.stdout, '', 'an owned directory still refused a write');

    const control = runGuard(
      [{ ...owned, requiresRead: [path.join(home, 'DECISION.md')] }],
      target
    );
    assert.match(
      JSON.parse(control.stdout).hookSpecificOutput.permissionDecisionReason,
      /governed by a document/,
      'the guard never matched this resource, so the check above proved nothing'
    );
  });
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
// A registry someone wrote before 0.5.0 still has `owners` arrays in it. They
// are now inert, and the thing that must not happen is a leftover field quietly
// changing what a resource does. It matches on path as it always did, and any
// `requiresRead` beside it still applies.
check('a leftover owners field is inert rather than blocking', () => {
  withGuardHome((home, runGuard) => {
    const site = path.join(home, 'site');
    fs.mkdirSync(site);
    const target = path.join(site, 'x.html');

    for (const owners of [[], ['session:wrap'], undefined]) {
      const resource = { id: 'r', label: 'r', type: 'directory', path: site, owners };
      const label = `owners: ${JSON.stringify(owners)}`;

      assert.deepStrictEqual(
        matchedResources({ tool_name: 'Write', cwd: home, tool_input: { file_path: target } },
          [resource]).map((r) => r.id),
        ['r'], `${label} stopped matching on path`
      );

      const allowed = runGuard([resource], target);
      assert.strictEqual(allowed.stdout, '', `${label} still refused a write`);

      // Same resource, same path, one reason to refuse added. If this does not
      // deny, the guard is not seeing the resource at all and the line above is
      // measuring nothing.
      const control = runGuard(
        [{ ...resource, requiresRead: [path.join(home, 'DECISION.md')] }],
        target
      );
      assert.match(
        JSON.parse(control.stdout).hookSpecificOutput.permissionDecisionReason,
        /governed by a document/,
        `${label}: the guard never matched this resource`
      );
    }
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
