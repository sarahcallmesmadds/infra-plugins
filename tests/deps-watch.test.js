#!/usr/bin/env node
// Tests for deps-refs.js and the deps-watch hook.
//
// Run: node tests/deps-watch.test.js
//
// The fault being fixed: the session brief called a target drifted when its
// file's modification time was newer than the date the entry was confirmed. On
// 2026-08-07 that reported 12 changed targets and every one of them already
// recorded the right dependencies. A warning that has never once been real is
// a warning nobody reads, which is worse than no warning at all, because the
// edit that does move a dependency produces the same line.
//
// The regression that matters most is the queue.js case at the bottom.
// queue.js mentions roots.js in a line comment and never calls it. Any check
// built on searching the file text says that is a dependency, which is how the
// replacement would have reproduced the problem it replaces.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REFS = path.join(__dirname, '..', 'plugins', 'build-loop', 'scripts', 'deps-refs.js');
const HOOK = path.join(__dirname, '..', 'plugins', 'build-loop', 'hooks', 'deps-watch.js');
const {
  bump, codeBlocks, entryByPath, expandHome, extractRefs, pluginRootFor, unrecorded,
} = require(REFS);

let failed = 0;
let passed = 0;
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-watch-test-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ } };
process.on('exit', cleanup);

// A miniature plugin, so the tests exercise real files rather than strings.
const plugin = path.join(tmp, 'plugins', 'demo');
fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(plugin, 'skills', 'thing'), { recursive: true });
fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });

const rootsJs = path.join(plugin, 'scripts', 'roots.js');
const queueJs = path.join(plugin, 'scripts', 'queue.js');
const hookJs = path.join(plugin, 'hooks', 'demo-hook.js');
const skillMd = path.join(plugin, 'skills', 'thing', 'SKILL.md');

fs.writeFileSync(rootsJs, "'use strict';\nmodule.exports = {};\n");
fs.writeFileSync(hookJs, "const r = require('../scripts/roots.js');\nconst q = require('../scripts/queue.js');\n");

// --- extraction ----------------------------------------------------------

check('a relative require that resolves is a reference', () => {
  const refs = extractRefs(hookJs, fs.readFileSync(hookJs, 'utf8'));
  assert.ok(refs.includes(path.resolve(rootsJs)), 'roots.js not found');
  assert.ok(refs.includes(path.resolve(queueJs)) === false, 'queue.js does not exist yet, so it must not resolve');
});

check('a require without its extension still resolves', () => {
  const f = path.join(plugin, 'hooks', 'bare.js');
  fs.writeFileSync(f, "require('../scripts/roots');\n");
  assert.deepStrictEqual(extractRefs(f, fs.readFileSync(f, 'utf8')), [path.resolve(rootsJs)]);
});

check('a package require is not a reference', () => {
  const f = path.join(plugin, 'hooks', 'pkg.js');
  fs.writeFileSync(f, "require('fs');\nrequire('path');\nrequire('some-package');\n");
  assert.deepStrictEqual(extractRefs(f, fs.readFileSync(f, 'utf8')), []);
});

check('a file does not depend on itself', () => {
  const f = path.join(plugin, 'scripts', 'selfish.js');
  fs.writeFileSync(f, "require('./selfish.js');\n");
  assert.deepStrictEqual(extractRefs(f, fs.readFileSync(f, 'utf8')), []);
});

check('a script named inside a fenced block is a reference', () => {
  fs.writeFileSync(skillMd, [
    '---', 'name: thing', 'description: demo', '---',
    '', 'Run it:', '', '```bash', 'node "${CLAUDE_PLUGIN_ROOT}"/scripts/roots.js check', '```', '',
  ].join('\n'));
  assert.deepStrictEqual(extractRefs(skillMd, fs.readFileSync(skillMd, 'utf8')), [path.resolve(rootsJs)]);
});

check('a script named only in prose is NOT a reference', () => {
  const f = path.join(plugin, 'skills', 'thing', 'PROSE.md');
  fs.writeFileSync(f, 'This behaves the way scripts/roots.js behaves, but never calls it.\n');
  assert.deepStrictEqual(extractRefs(f, fs.readFileSync(f, 'utf8')), []);
});

check('codeBlocks reads fenced content and drops the fences', () => {
  const blocks = codeBlocks('before\n```\ninside\n```\nafter\n');
  assert.deepStrictEqual(blocks, ['inside']);
});

check('pluginRootFor walks up to the .claude-plugin directory', () => {
  assert.strictEqual(pluginRootFor(skillMd), path.resolve(plugin));
  assert.strictEqual(pluginRootFor(path.join(tmp, 'nowhere.js')), null);
});

// --- comparison against the map ------------------------------------------

const depsFor = (extra = {}) => ({
  $schema_version: 3,
  last_updated: '2026-08-01T00:00:00.000Z',
  targets: {
    'demo:demo/roots': {
      target: 'roots', plugin: 'demo', kind: 'script', repo: 'demo',
      path: rootsJs, depends_on: [], dependents: [],
      confidence: 'high', last_updated: '2026-08-01T00:00:00.000Z',
    },
    'demo:demo/demo-hook': {
      target: 'demo-hook', plugin: 'demo', kind: 'hook', repo: 'demo',
      path: hookJs, depends_on: [], dependents: [],
      confidence: 'high', last_updated: '2026-08-01T00:00:00.000Z',
    },
    ...extra,
  },
});

check('a call with no recorded edge is reported', () => {
  const deps = depsFor();
  const missing = unrecorded(deps, deps.targets['demo:demo/demo-hook'], [rootsJs]);
  assert.strictEqual(missing.length, 1);
  assert.strictEqual(missing[0].id, 'demo/roots');
});

check('a call that IS recorded is not reported', () => {
  const deps = depsFor();
  deps.targets['demo:demo/demo-hook'].depends_on = [
    { target: 'roots', plugin: 'demo', kind: 'script', repo: 'demo', reason: 'calls it' },
  ];
  assert.deepStrictEqual(unrecorded(deps, deps.targets['demo:demo/demo-hook'], [rootsJs]), []);
});

check('a recorded edge with no visible call is NOT reported', () => {
  // The deliberate asymmetry. Semantic edges are real and unextractable, so
  // reporting them as gone would rebuild the false alarms this replaces.
  const deps = depsFor();
  deps.targets['demo:demo/demo-hook'].depends_on = [
    { target: 'something-semantic', plugin: 'demo', kind: 'skill', repo: 'demo', reason: 'reads what it writes' },
  ];
  assert.deepStrictEqual(unrecorded(deps, deps.targets['demo:demo/demo-hook'], []), []);
});

check('a reference to something outside the map is not a missing edge', () => {
  const deps = depsFor();
  const stray = path.join(plugin, 'scripts', 'unmapped.js');
  fs.writeFileSync(stray, '\n');
  assert.deepStrictEqual(unrecorded(deps, deps.targets['demo:demo/demo-hook'], [stray]), []);
});

check('entryByPath matches through a ~ path', () => {
  const deps = depsFor();
  deps.targets['demo:demo/roots'].path = '~/nowhere/roots.js';
  const hit = entryByPath(deps, path.join(os.homedir(), 'nowhere', 'roots.js'));
  assert.ok(hit && hit.key === 'demo:demo/roots');
});

check('expandHome leaves an absolute path alone', () => {
  assert.strictEqual(expandHome('/a/b'), '/a/b');
  assert.strictEqual(expandHome('~'), os.homedir());
});

// --- writing -------------------------------------------------------------

check('bump stamps one entry and the file, and nothing else', () => {
  const p = path.join(tmp, 'DEPS.json');
  const before = depsFor();
  fs.writeFileSync(p, JSON.stringify(before, null, 2));
  const now = '2026-08-07T12:00:00.000Z';
  assert.strictEqual(bump('demo:demo/roots', now, p), 'bumped');
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(after.targets['demo:demo/roots'].last_updated, now);
  assert.strictEqual(after.last_updated, now);
  assert.strictEqual(after.targets['demo:demo/demo-hook'].last_updated, '2026-08-01T00:00:00.000Z');
  assert.deepStrictEqual(after.targets['demo:demo/roots'].depends_on, [], 'edges must never be rewritten here');
});

check('bump on an unknown key changes nothing', () => {
  const p = path.join(tmp, 'DEPS-2.json');
  fs.writeFileSync(p, JSON.stringify(depsFor(), null, 2));
  assert.strictEqual(bump('demo:demo/nope', '2026-08-07T12:00:00.000Z', p), 'unchanged');
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).last_updated, '2026-08-01T00:00:00.000Z');
});

check('bump gives up rather than waiting out a held lock', () => {
  const p = path.join(tmp, 'DEPS-3.json');
  fs.writeFileSync(p, JSON.stringify(depsFor(), null, 2));
  const lock = path.join(path.dirname(p), '.deps.lock');
  fs.mkdirSync(lock);
  try {
    assert.strictEqual(bump('demo:demo/roots', '2026-08-07T12:00:00.000Z', p), 'locked');
    assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).last_updated, '2026-08-01T00:00:00.000Z');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

check('bump leaves no lock behind', () => {
  const p = path.join(tmp, 'DEPS-4.json');
  fs.writeFileSync(p, JSON.stringify(depsFor(), null, 2));
  bump('demo:demo/roots', '2026-08-07T12:00:00.000Z', p);
  assert.ok(!fs.existsSync(path.join(path.dirname(p), '.deps.lock')), 'lock survived the write');
});

check('a corrupt map is survived rather than thrown on', () => {
  const p = path.join(tmp, 'DEPS-5.json');
  fs.writeFileSync(p, '{ not json');
  assert.strictEqual(bump('demo:demo/roots', '2026-08-07T12:00:00.000Z', p), 'unchanged');
});

// --- the regression this was built for -----------------------------------

check('a comment naming another script is not a dependency', () => {
  // queue.js, verbatim in shape: it names roots.js in a line comment and never
  // requires it. This is the case that made the old timestamp check useless,
  // and a text search would call it a dependency.
  const f = path.join(plugin, 'scripts', 'commenting.js');
  fs.writeFileSync(f, [
    "'use strict';",
    '// Exit 0 clean, 3 when something is off-enum, matching roots.js in using a',
    '// small set of codes rather than prose.',
    'module.exports = {};',
  ].join('\n'));
  assert.deepStrictEqual(extractRefs(f, fs.readFileSync(f, 'utf8')), [],
    'a mention in a comment was counted as a call');
});

// --- wiring --------------------------------------------------------------

check('the hook is registered on Write and Edit', () => {
  const hooks = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'build-loop', 'hooks', 'hooks.json'), 'utf8'));
  const post = hooks.hooks.PostToolUse.find((h) => h.matcher === 'Write|Edit');
  assert.ok(post, 'no PostToolUse Write|Edit entry');
  assert.ok(JSON.stringify(post).includes('deps-watch.js'), 'deps-watch.js is not registered');
});

check('the hook is executable', () => {
  fs.accessSync(HOOK, fs.constants.X_OK);
});

check('the hook never writes edges', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  assert.ok(!/depends_on\s*=/.test(src), 'the hook assigns to depends_on');
  assert.ok(!/dependents\s*=/.test(src), 'the hook assigns to dependents');
});

console.log(`${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
