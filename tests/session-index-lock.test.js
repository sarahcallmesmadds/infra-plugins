#!/usr/bin/env node
// Regression tests for the lock around the handoff index.
//
// Run: node tests/session-index-lock.test.js
//
// These pin a bug that reached shipped code and stayed there: `handoffs.js`
// mutated `index.json` in four places, each of them a read, a change in memory
// and a write back, with nothing held across the pair. `writeIndex` renames a
// temporary file over the real one, which is atomic and stops a reader seeing a
// half-written file, so the code looked protected and the comment above it said
// two sessions at once was the ordinary case. The rename made each write
// indivisible and did nothing about two writers: session B reads before session
// A renames, then B renames its own copy over A's entry.
//
// Measured before the fix, 40 concurrent `recordHandoff` calls against a
// throwaway home: 15 to 18 survived, varying run to run. On this machine that
// had unlisted 13 of 47 real handoffs, so `/pickup` could not find them by name.
//
// The first test below is the one that matters and it uses real subprocesses.
// A single-process test cannot reproduce this at all: node is single threaded,
// so the read and the write of one call can never be separated by another
// call's write within one process.

'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const HANDOFFS = path.join(ROOT, 'scripts', 'handoffs.js');
const handoffs = require(HANDOFFS);
const { withIndexLock, acquire, release, WAIT_MS, STALE_MS } = require(path.join(ROOT, 'scripts', 'index-lock.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-lock-'));

// Run several snippets at once and return when the last one has exited.
//
// The indirection through a launcher process is the whole point, and the first
// version of this file got it wrong in a way worth recording. It called
// `execFileSync` in a loop, which waits for each child before starting the
// next, so forty "concurrent" writers ran strictly one at a time. Every test
// passed, and passed just as well against the unfixed code, because nothing
// ever overlapped. A concurrency test that cannot fail on the broken version is
// not testing concurrency.
//
// So: one synchronous call from here into a launcher that spawns the children
// asynchronously and waits for all of them. The test harness stays synchronous
// and the children genuinely contend.
const LAUNCHER = `
  const { spawn } = require('child_process');
  const snippets = JSON.parse(process.argv[1]);
  let done = 0;
  for (const code of snippets) {
    const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore'] });
    p.on('exit', () => { if (++done === snippets.length) process.exit(0); });
  }
`;

function runConcurrently(snippets) {
  execFileSync(process.execPath, ['-e', LAUNCHER, JSON.stringify(snippets)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const readIndexFile = (home) => JSON.parse(
  fs.readFileSync(path.join(home, '.planning', 'handoffs', 'index.json'), 'utf8'),
).handoffs;

// ------------------------------------------------- what the user runs ------

// Nobody types `recordHandoff`. `/wrap` step 2 runs `cli.js target`, and two
// sessions wrapping at once are two of those processes. The tests above drive
// the module underneath, which is the arrangement this repository has been
// caught by before: every real bug of 2026-07-27 lived in a path the tests
// never executed, because the detectors were tested directly and the command
// that printed their output was not.
const CLI = path.join(ROOT, 'scripts', 'cli.js');

check('two wraps running cli.js target at once both get recorded', () => {
  const home = tmpHome();
  const N = 12;

  const snippets = [];
  for (let i = 0; i < N; i += 1) {
    const repo = path.join(home, 'code', `repo-${i}`);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    snippets.push(`require('child_process').spawnSync(process.execPath, `
      + `[${JSON.stringify(CLI)}, 'target', 'topic-${i}', '--cwd', ${JSON.stringify(repo)}, `
      + `'--json', '--home', ${JSON.stringify(home)}]);`);
  }
  runConcurrently(snippets);

  const index = readIndexFile(home);
  const missing = [];
  for (let i = 0; i < N; i += 1) if (!index[`repo-${i}`]) missing.push(`repo-${i}`);
  assert.deepStrictEqual(missing, [],
    'every wrap that ran cli.js target is findable by /pickup afterwards');
});

check('a wrap recording while another sweeps does not lose its entry', () => {
  const home = tmpHome();
  const root = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(root, { recursive: true });

  // `/wrap` step 1 is `cli.js archive` and step 2 is `cli.js target`, so one
  // session sweeping while another records is the ordinary overlap, not an
  // exotic one. The sweep rewrites the whole map, so it is the one that can
  // discard somebody else's entry wholesale.
  const stale = path.join(root, 'HANDOFF-ancient.md');
  fs.writeFileSync(stale, '# Session Handoff\n');
  const longAgo = (Date.now() - 90 * 86400000) / 1000;
  fs.utimesSync(stale, longAgo, longAgo);

  const snippets = [`require('child_process').spawnSync(process.execPath, `
    + `[${JSON.stringify(CLI)}, 'archive', '--json', '--home', ${JSON.stringify(home)}]);`];
  for (let i = 0; i < 8; i += 1) {
    const repo = path.join(home, 'code', `during-${i}`);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    // The document has to exist, or the prune drops its entry for the right
    // reason and the test proves nothing about locking. A wrap writes the file
    // immediately after `target` returns; this stands in for that.
    fs.writeFileSync(path.join(repo, 'HANDOFF.md'), '# Session Handoff\n');
    snippets.push(`require('child_process').spawnSync(process.execPath, `
      + `[${JSON.stringify(CLI)}, 'target', 'topic', '--cwd', ${JSON.stringify(repo)}, `
      + `'--json', '--home', ${JSON.stringify(home)}]);`);
  }
  runConcurrently(snippets);

  const index = readIndexFile(home);
  const missing = [];
  for (let i = 0; i < 8; i += 1) if (!index[`during-${i}`]) missing.push(`during-${i}`);
  assert.deepStrictEqual(missing, [],
    'the sweep writes the whole map, so unlocked it discards every entry recorded since its read');
});

// -------------------------------------------------------- the real race ----

check('concurrent recordHandoff calls all survive', () => {
  const home = tmpHome();
  const N = 40;

  const snippets = [];
  for (let i = 0; i < N; i += 1) {
    snippets.push(`const h = require(${JSON.stringify(HANDOFFS)});`
      + `h.recordHandoff({ slug: 'topic-${i}', target: '/tmp/x-${i}.md', kind: 'central', home: ${JSON.stringify(home)} });`);
  }
  runConcurrently(snippets);

  const kept = Object.keys(readIndexFile(home)).length;
  assert.strictEqual(kept, N,
    `every recorded handoff must survive concurrent writers, kept ${kept} of ${N}. `
    + 'Measured against the unfixed code this test keeps 15 to 18 of 40, and each loss is a '
    + 'handoff /pickup cannot find by name.');
});

check('a forget running against concurrent writers does not lose their entries', () => {
  const home = tmpHome();
  handoffs.recordHandoff({ slug: 'drop', target: '/tmp/drop.md', kind: 'central', home });

  // The forget rewrites the whole map, so unlocked it discards whatever the
  // writers beside it recorded after its own read.
  const snippets = [`const h = require(${JSON.stringify(HANDOFFS)});`
    + `h.forgetHandoff('drop', ${JSON.stringify(home)});`];
  for (let i = 0; i < 12; i += 1) {
    snippets.push(`const h = require(${JSON.stringify(HANDOFFS)});`
      + `h.recordHandoff({ slug: 'added-${i}', target: '/tmp/a-${i}.md', kind: 'central', home: ${JSON.stringify(home)} });`);
  }
  runConcurrently(snippets);

  const index = readIndexFile(home);
  assert.ok(!index.drop, 'a forgotten entry does not come back');
  for (let i = 0; i < 12; i += 1) {
    assert.ok(index[`added-${i}`], `added-${i} survived the concurrent forget`);
  }
});

// ---------------------------------------------------------- re-entrancy ----

check('archiveStale completes rather than deadlocking on its own prune', () => {
  const home = tmpHome();
  const root = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(root, { recursive: true });

  // One handoff old enough to sweep, recorded in the index so the sweep has an
  // entry to repoint as well as a prune to run.
  const old = path.join(root, 'HANDOFF-ancient.md');
  fs.writeFileSync(old, '# Session Handoff\n');
  const longAgo = Date.now() - 90 * 86400000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
  handoffs.recordHandoff({ slug: 'ancient', target: old, kind: 'central', home });

  // `archiveStale` takes the lock and calls `pruneIndex`, which takes the same
  // lock. Without re-entrancy the second acquire waits out the full deadline on
  // a lock this very process holds, so the assertion here is as much about the
  // elapsed time as about the result.
  const started = Date.now();
  const result = handoffs.archiveStale({ home, days: 30 });
  const elapsed = Date.now() - started;

  assert.strictEqual(result.skipped, false);
  assert.ok(elapsed < WAIT_MS,
    `the sweep must not wait on a lock it already holds, took ${elapsed}ms against a ${WAIT_MS}ms deadline`);
  assert.strictEqual(result.moved.length, 1, 'the stale handoff moved');
  assert.strictEqual(result.repointed.length, 1, 'its index entry was repointed to archived/');
  assert.strictEqual(result.indexWritten, true);
});

check('the sweep leaves an entry recorded by another session alone', () => {
  const home = tmpHome();
  const root = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(root, { recursive: true });

  const live = path.join(root, 'HANDOFF-live.md');
  fs.writeFileSync(live, '# Session Handoff\n');
  handoffs.recordHandoff({ slug: 'live', target: live, kind: 'central', home });

  handoffs.archiveStale({ home, days: 30 });

  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  assert.ok(index.handoffs.live,
    'a fresh entry whose file exists survives the prune. The prune writes the whole map, '
    + 'so unlocked it discards everything recorded since its own read.');
});

// ------------------------------------------------------- the lock itself ----

check('the lock is released after the body throws', () => {
  const home = tmpHome();
  const lock = handoffs.indexLockPath(home);

  assert.throws(() => withIndexLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lock),
    'a throw inside the critical section must not leave the lock behind, or every later write blocks until it goes stale');

  // And the next writer can still take it.
  const after = withIndexLock(lock, () => 'ran');
  assert.strictEqual(after.value, 'ran');
  assert.strictEqual(after.locked, true);
});

check('a stale lock is taken over rather than waited out forever', () => {
  const home = tmpHome();
  const lock = handoffs.indexLockPath(home);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'someone-who-died');
  const old = (Date.now() - STALE_MS * 3) / 1000;
  fs.utimesSync(lock, old, old);

  const result = withIndexLock(lock, () => 'ran');
  assert.strictEqual(result.locked, true, 'an abandoned lock is taken over');
  assert.strictEqual(result.value, 'ran');
});

check('a lock held by someone else reports busy, not unavailable', () => {
  const home = tmpHome();
  const lock = handoffs.indexLockPath(home);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'somebody-else');

  // A fake clock rather than a real five second wait. The lock is fresh, so
  // this is contention that never clears.
  let clock = 1000;
  const reason = acquire(lock, () => { clock += WAIT_MS; return clock; });
  assert.strictEqual(reason, 'busy',
    'contention and an unusable directory are different answers, and only one of them means '
    + 'another writer is active');

  fs.rmSync(lock, { recursive: true, force: true });
});

check('a directory that cannot hold a lock reports unavailable', () => {
  const home = tmpHome();
  const root = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(root, { recursive: true });
  fs.chmodSync(root, 0o500); // readable, not writable
  try {
    const reason = acquire(handoffs.indexLockPath(home));
    assert.strictEqual(reason, 'unavailable',
      'no lock can be created here at all, which is not the same as losing a race');
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

check('an unprotected write says so on stderr rather than passing quietly', () => {
  const home = tmpHome();
  const lock = handoffs.indexLockPath(home);

  // Held by a live-looking owner in a child process, so the parent genuinely
  // cannot take it and falls through to the unprotected path.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path');
    const { withIndexLock } = require(${JSON.stringify(path.join(ROOT, 'scripts', 'index-lock.js'))});
    const lock = ${JSON.stringify(lock)};
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'somebody-else');
    const r = withIndexLock(lock, () => 'ran anyway');
    process.stdout.write(JSON.stringify({ value: r.value, locked: r.locked, reason: r.reason }));
  `], { encoding: 'utf8' });

  const r = JSON.parse(child.stdout);
  assert.strictEqual(r.value, 'ran anyway',
    'the handoff itself is the point, so the write is not abandoned');
  assert.strictEqual(r.locked, false, 'it does not claim a lock it never took');
  assert.strictEqual(r.reason, 'busy');

  // The bytes a person actually sees, not the source that produces them. A test
  // asserting the source says X passes while the thing printed says Y.
  assert.match(child.stderr, /without the lock/,
    'an unprotected write must not be silent, or a skip reads exactly like a pass');
  assert.match(child.stderr, /may have been lost/,
    'and it names the consequence, not just the fact that something was skipped');
});

check('release leaves a lock belonging to someone else alone', () => {
  const home = tmpHome();
  const lock = handoffs.indexLockPath(home);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), 'not-us');

  release(lock);
  assert.ok(fs.existsSync(lock),
    'a process whose lock was taken over as stale must not delete the lock of whoever took it, '
    + 'which would drop a live writer out of the critical section');

  fs.rmSync(lock, { recursive: true, force: true });
});

check('the lock directory is not mistaken for a handoff', () => {
  const home = tmpHome();
  const root = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(root, { recursive: true });
  const doc = path.join(root, 'HANDOFF-real.md');
  fs.writeFileSync(doc, '# Session Handoff\n');
  handoffs.recordHandoff({ slug: 'real', target: doc, kind: 'central', home });

  const recent = handoffs.recentHandoffs({ home, limit: 10 });
  const slugs = recent.map((r) => r.slug);
  assert.ok(slugs.includes('real'), 'the real handoff is listed');
  assert.ok(!slugs.some((s) => s.includes('lock')),
    'the lock directory sits in the handoffs folder, so the listings must keep filtering on the HANDOFF- prefix');
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
