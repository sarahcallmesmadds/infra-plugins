#!/usr/bin/env node
// Concurrency tests for scripts/queue.js.
//
// Run: node tests/queue-locking.test.js
//
// queue-writes.test.js asserts on the wording of the skills, which is all you
// can do when the writing is done by a model following prose. It cannot catch
// the bug these tests are about, because that bug is not in any one instruction:
// it is the gap between two tool calls, where the model holds a copy of an entry
// while somebody else writes a different one.
//
// So these spawn real processes and let them collide. All three concurrency
// checks were confirmed to fail against the sequence the skills used before
// queue.js existed, which is the only reason to believe they test the lock
// rather than the happy path.
//
// One honest limit. That confirmation models the old sequence as no lock plus a
// pause between the read and the write, because the read and the write really
// were separate tool calls seconds apart. Remove only the lock from the code
// below, leaving its critical section as short as it is, and the create check
// can still pass by luck: two processes doing microseconds of work rarely
// collide. These prove the lock closes a window that is wide in practice. They
// do not prove a narrow one is impossible.
//
// HOME is redirected to a temp directory, so the assertions run against a queue
// built here rather than whatever is on the machine running them. Nothing in
// this file can touch the real queue.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const QUEUE_JS = path.join(__dirname, '..', 'plugins', 'build-loop', 'scripts', 'queue.js');

// Checks are queued rather than run on the spot, and awaited one at a time
// below. Half of them are async, and a runner that does not await an async
// check prints `ok` before the assertions have happened, which is worse than
// no test at all: the first draft of this file passed while the code under it
// was leaving a lock behind.
const CHECKS = [];
let failed = 0;
function check(what, fn) {
  CHECKS.push([what, fn]);
}

async function runAll() {
  for (const [what, fn] of CHECKS) {
    try {
      await fn();
      console.log(`  ok    ${what}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${what}\n        ${error.message}`);
    }
  }
  console.log(`\n${CHECKS.length} checks, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// A fresh HOME per test, so one test's lock or leftover entry cannot reach the
// next one. `await fn(home)` rather than `fn(home)`: without the await the
// cleanup runs the moment an async body yields, and the processes it spawned
// then race a directory that is being deleted underneath them. Every failure
// that produces looks like a bug in the lock and is not.
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'build-loop', 'queue'), { recursive: true });
  try {
    return await fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function entry(home, id, over = {}) {
  const e = {
    $schema_version: 5,
    id,
    created_at: '2026-08-02T00:00:00.000Z',
    status: 'Open',
    type: 'primary',
    parent_id: null,
    target: 'thing',
    target_kind: 'script',
    target_path: '/tmp/thing.js',
    repo: 'plugins',
    what_happened: 'x',
    what_expected: 'y',
    correct_example: 'z',
    dedup_key: 'thing::x',
    notes: [],
    resolution: null,
    ...over,
  };
  fs.writeFileSync(queueFile(home, id), JSON.stringify(e, null, 2) + '\n');
  return e;
}

function queueFile(home, id) {
  return path.join(home, '.claude', 'build-loop', 'queue', `${id}.json`);
}

function read(home, id) {
  return JSON.parse(fs.readFileSync(queueFile(home, id), 'utf8'));
}

// Every spawn gets a timeout. Without one, a bug that makes queue.js loop
// forever hangs the suite instead of failing it, and a hung suite reports
// nothing at all. That is not hypothetical: reverting the deadline fix to check
// these tests catch it hung the run rather than turning it red.
const KILL_MS = 20000;

// stdio pipes the child's stderr instead of letting it through to ours.
// execFileSync captures it either way, but by default it is also echoed to the
// parent, and run-all.js takes the last non-empty line of a suite's output as
// that suite's summary line. A lock-timeout message from a test that is
// deliberately provoking one then stands in for "29 checks, 0 failed", so a
// passing suite reads as a failing one in the only report anyone scans.
// start() below uses execFile, which always pipes, so it never had this.
function run(home, args) {
  return execFileSync(process.execPath, [QUEUE_JS, ...args], {
    encoding: 'utf8',
    timeout: KILL_MS,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Starts a run without waiting for it, so several can be in flight at once.
function start(home, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [QUEUE_JS, ...args], {
      timeout: KILL_MS,
      env: { ...process.env, HOME: home },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

// --- the bug this exists for ---------------------------------------------

check('concurrent note appends all survive', () => {
  // The original failure, made deterministic by volume. Twenty processes each
  // append one note to the same entry at the same moment. Under the old
  // read-compose-write sequence the last writer wins and most of the notes are
  // gone; the count is the assertion because it cannot be satisfied by luck.
  return withHome(async (home) => {
    entry(home, 'e1');
    const runs = Array.from({ length: 20 }, (_, i) =>
      start(home, ['update', 'e1', '--note', `note ${i}`]));
    const results = await Promise.all(runs);

    const bad = results.filter((r) => r.code !== 0);
    assert.strictEqual(bad.length, 0, `${bad.length} runs failed: ${bad.map((b) => b.stderr).join('; ')}`);

    const notes = read(home, 'e1').notes;
    assert.strictEqual(notes.length, 20, `expected 20 notes, got ${notes.length}`);
    const texts = new Set(notes.map((n) => n.text));
    assert.strictEqual(texts.size, 20, 'some notes were written twice and others lost');
  });
});

check('a concurrent status change does not lose a note', () => {
  // The asymmetric case: one writer changes a field, another appends. Both
  // read the same entry. Under the old sequence whichever wrote second erased
  // the other's change, and neither reported anything.
  return withHome(async (home) => {
    // `In Progress` rather than `Resolved`, which this used to write. Closing an
    // entry now has to say what closing it meant, and that requirement has
    // nothing to do with what this test is about. Any status change makes the
    // point, so the one that drags a second rule in is the wrong one to pick.
    entry(home, 'e2');
    await Promise.all([
      start(home, ['update', 'e2', '--status', 'In Progress']),
      start(home, ['update', 'e2', '--note', 'still here']),
    ]);
    const after = read(home, 'e2');
    assert.strictEqual(after.status, 'In Progress', 'the status change was lost');
    assert.strictEqual(after.notes.length, 1, 'the note was lost');
    assert.strictEqual(after.notes[0].text, 'still here');
  });
});

check('notes already on the entry are never rebuilt away', () => {
  return withHome((home) => {
    entry(home, 'e3', { notes: [{ ts: 'old', text: 'was here first' }] });
    run(home, ['update', 'e3', '--status', 'In Progress', '--note', 'added']);
    const after = read(home, 'e3');
    assert.strictEqual(after.notes.length, 2);
    assert.strictEqual(after.notes[0].text, 'was here first');
  });
});

check('one call changing several things lands as one write', () => {
  return withHome((home) => {
    entry(home, 'e4');
    // `{outcome: 'fixed'}` here until the resolution gate landed, which is not
    // a spelling anything accepted. It wrote fine, because nothing checked.
    fs.writeFileSync(path.join(home, 'res.json'), JSON.stringify({
      outcome: 'fix_applied',
      at: '2026-08-05T12:00:00.000Z',
      summary: 'the guard now reads the event cwd',
      commit: 'abc1234',
    }));
    run(home, ['update', 'e4', '--status', 'Resolved', '--note', 'a', '--note', 'b',
      '--resolution', path.join(home, 'res.json'), '--field', 'repo=other']);
    const after = read(home, 'e4');
    assert.strictEqual(after.status, 'Resolved');
    assert.strictEqual(after.notes.length, 2, 'a repeated --note was dropped');
    assert.strictEqual(after.resolution.outcome, 'fix_applied');
    assert.strictEqual(after.repo, 'other');
  });
});

// --- create and dedup ----------------------------------------------------

check('two identical creates at once produce one entry', () => {
  // The flag-issue race. Both processes check for a duplicate and both find
  // none, because the check and the write were separate steps. Here they are
  // one, so exactly one wins and the other says why it did not.
  return withHome(async (home) => {
    const a = path.join(home, 'a.json');
    const b = path.join(home, 'b.json');
    const base = {
      $schema_version: 5, created_at: new Date().toISOString(), status: 'Open',
      type: 'primary', target: 'thing', dedup_key: 'thing::same', notes: [], resolution: null,
    };
    fs.writeFileSync(a, JSON.stringify({ ...base, id: 'dup-a' }));
    fs.writeFileSync(b, JSON.stringify({ ...base, id: 'dup-b' }));

    const results = await Promise.all([start(home, ['create', a]), start(home, ['create', b])]);
    const written = fs.readdirSync(path.join(home, '.claude', 'build-loop', 'queue'));
    assert.strictEqual(written.length, 1, `expected 1 entry, got ${written.length}: ${written}`);

    const refused = results.filter((r) => r.code === 2);
    assert.strictEqual(refused.length, 1, 'the loser did not report itself as a duplicate');
    assert.ok(/duplicate/.test(refused[0].stdout), 'the refusal did not say why');
  });
});

check('a duplicate outside the window is allowed through', () => {
  return withHome((home) => {
    entry(home, 'old', { created_at: '2020-01-01T00:00:00.000Z', dedup_key: 'thing::same' });
    const f = path.join(home, 'new.json');
    fs.writeFileSync(f, JSON.stringify({
      id: 'new', created_at: new Date().toISOString(), status: 'Open',
      dedup_key: 'thing::same', notes: [],
    }));
    run(home, ['create', f]);
    assert.ok(fs.existsSync(queueFile(home, 'new')), 'a years-old duplicate blocked a new entry');
  });
});

check('an unreadable created_at counts as a duplicate rather than as long ago', () => {
  // Refusing costs a retry. Allowing writes a duplicate on the strength of a
  // field nobody can parse, so the tie goes to refusing.
  return withHome((home) => {
    entry(home, 'weird', { created_at: 'not a date', dedup_key: 'thing::same' });
    const f = path.join(home, 'new.json');
    fs.writeFileSync(f, JSON.stringify({
      id: 'new', created_at: new Date().toISOString(), status: 'Open',
      dedup_key: 'thing::same', notes: [],
    }));
    let out = '';
    try {
      out = run(home, ['create', f]);
    } catch (error) {
      out = error.stdout || '';
    }
    assert.ok(/duplicate/.test(out), `expected a duplicate refusal, got: ${out}`);
    assert.ok(!fs.existsSync(queueFile(home, 'new')));
  });
});

check('create refuses to overwrite an id that already exists', () => {
  return withHome((home) => {
    entry(home, 'taken', { dedup_key: 'thing::one' });
    const f = path.join(home, 'new.json');
    // `status` is required on a new entry, and that is checked before the lock
    // is taken, so a fixture without one is refused for the wrong reason and
    // never reaches the collision this case is about.
    fs.writeFileSync(f, JSON.stringify({ id: 'taken', status: 'Open', created_at: new Date().toISOString(), dedup_key: 'thing::two', notes: [] }));
    assert.throws(() => run(home, ['create', f]), /already exists/);
    assert.strictEqual(read(home, 'taken').dedup_key, 'thing::one', 'the existing entry was overwritten');
  });
});

// --- the lock itself -----------------------------------------------------

check('a stale lock is taken over rather than deadlocking', () => {
  return withHome((home) => {
    const lock = path.join(home, '.claude', 'build-loop', '.queue.lock');
    fs.mkdirSync(lock);
    // Backdate it well past the stale threshold, the way a lock left by a
    // process that died would look.
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);

    entry(home, 'e5');
    run(home, ['update', 'e5', '--note', 'went through']);
    assert.strictEqual(read(home, 'e5').notes.length, 1, 'a dead session blocked the queue forever');
  });
});

check('a fresh lock held by someone else is refused, not ignored', () => {
  return withHome((home) => {
    const lock = path.join(home, '.claude', 'build-loop', '.queue.lock');
    fs.mkdirSync(lock);
    entry(home, 'e6');
    assert.throws(() => run(home, ['update', 'e6', '--note', 'should not land']), /lock/i);
    assert.strictEqual(read(home, 'e6').notes.length, 0, 'it wrote anyway while another session held the lock');
  });
});

check('the lock is released when the write fails', () => {
  return withHome((home) => {
    // A resolution file that is not JSON makes the command exit inside the
    // critical section. Without the finally that releases the lock, every
    // later write would block until the lock went stale.
    entry(home, 'e7');
    fs.writeFileSync(path.join(home, 'bad.json'), 'not json');
    assert.throws(() => run(home, ['update', 'e7', '--resolution', path.join(home, 'bad.json')]));
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'build-loop', '.queue.lock')), 'the lock survived a failed write');
    run(home, ['update', 'e7', '--note', 'the queue still works']);
    assert.strictEqual(read(home, 'e7').notes.length, 1);
  });
});

check('a malformed entry is reported and left alone', () => {
  return withHome((home) => {
    fs.writeFileSync(queueFile(home, 'broken'), '{ not json');
    assert.throws(() => run(home, ['update', 'broken', '--status', 'Resolved']), /not valid JSON/);
    assert.strictEqual(fs.readFileSync(queueFile(home, 'broken'), 'utf8'), '{ not json', 'it rewrote a file it could not read');
  });
});

check('the to-build list is served by the same lock', () => {
  return withHome(async (home) => {
    const dir = path.join(home, '.claude', 'build-loop', 'to-build');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 't1.json'), JSON.stringify({ id: 't1', status: 'Open', notes: [] }));

    // Same collision as the queue test, against the other list. The bug entry
    // named both, and a fix that covered only the queue would look complete.
    const runs = Array.from({ length: 10 }, (_, i) =>
      start(home, ['update', 't1', '--list', 'to-build', '--note', `n${i}`]));
    const results = await Promise.all(runs);
    assert.strictEqual(results.filter((r) => r.code !== 0).length, 0, 'some runs failed');

    const after = JSON.parse(fs.readFileSync(path.join(dir, 't1.json'), 'utf8'));
    assert.strictEqual(after.notes.length, 10, `expected 10 notes, got ${after.notes.length}`);
  });
});

check('an unknown list is refused rather than guessed at', () => {
  return withHome((home) => {
    entry(home, 'e9');
    // The reserved names are the ones that matter. LISTS used to be an object
    // literal, so `--list constructor` found a truthy inherited value, walked
    // past a guard that only asked whether the lookup returned something, and
    // reached path.join as a function. The caller got a stack trace where the
    // refusal was meant to be, and the skills relay that to the user.
    for (const bad of ['nonsense', 'constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      let message = '';
      try {
        run(home, ['update', 'e9', '--list', bad, '--note', 'x']);
        assert.fail(`--list ${bad} was accepted`);
      } catch (error) {
        message = String(error.stderr || error.message);
      }
      assert.match(message, /unknown list/, `--list ${bad} did not produce the refusal`);
      assert.ok(!/TypeError|ERR_INVALID_ARG_TYPE/.test(message),
        `--list ${bad} produced a stack trace instead of the refusal:\n        ${message.split('\n')[0]}`);
    }
    // And both real lists still resolve, so the guard is not refusing everything.
    run(home, ['update', 'e9', '--note', 'fine']);
    assert.strictEqual(read(home, 'e9').notes.length, 1);
  });
});

check('--json sets a field as an object, --field as a string', () => {
  // A closure block written with --field would land as the characters that
  // spell an object, which reads correctly and is not one.
  return withHome((home) => {
    entry(home, 'e10');
    fs.writeFileSync(path.join(home, 'built.json'), JSON.stringify({ ts: 'now', confirmed_by: 'user' }));
    run(home, ['update', 'e10', '--json', `built=${path.join(home, 'built.json')}`, '--field', 'repo=plugins']);
    const after = read(home, 'e10');
    assert.strictEqual(typeof after.built, 'object', 'built landed as something other than an object');
    assert.strictEqual(after.built.confirmed_by, 'user');
    assert.strictEqual(after.repo, 'plugins');
  });
});

// --- ids become filenames ------------------------------------------------

check('an id that is not a filename is refused by every command', () => {
  return withHome((home) => {
    entry(home, 'real');
    for (const bad of ['../escape', 'a/b', '..', '/abs', '.hidden', 'has space']) {
      assert.throws(
        () => run(home, ['show', bad]),
        /not a usable entry id/,
        `show accepted ${JSON.stringify(bad)}`
      );
      assert.throws(
        () => run(home, ['update', bad, '--note', 'x']),
        /not a usable entry id/,
        `update accepted ${JSON.stringify(bad)}`
      );
    }
    // And the ordinary shape still works, so the pattern is not simply refusing
    // everything. A real entry id has dashes, dots and digits in it.
    run(home, ['update', 'real', '--note', 'fine']);
    assert.strictEqual(read(home, 'real').notes.length, 1);
  });
});

check('a create whose id would escape the directory writes nothing', () => {
  return withHome((home) => {
    const f = path.join(home, 'evil.json');
    fs.writeFileSync(f, JSON.stringify({ id: '../../escaped', created_at: new Date().toISOString(), notes: [] }));
    assert.throws(() => run(home, ['create', f]), /not a usable entry id/);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'escaped.json')), 'it wrote outside the queue directory');
    assert.ok(!fs.existsSync(path.join(home, 'escaped.json')), 'it wrote outside the queue directory');
  });
});

// --- taking over an abandoned lock ---------------------------------------

check('several sessions meeting one stale lock do not all take it', () => {
  // The recovery path used to delete the stale directory in place, so two
  // processes could both decide it was stale, and the second would delete the
  // fresh lock the first had just taken. Both then wrote, which is the bug this
  // file exists to close, reintroduced by the code meant to recover from a
  // crash. Ten at once against one stale lock: every note has to survive.
  return withHome(async (home) => {
    const lock = path.join(home, '.claude', 'build-loop', '.queue.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'a session that died');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);

    entry(home, 'e11');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      start(home, ['update', 'e11', '--note', `n${i}`])));

    assert.strictEqual(results.filter((r) => r.code !== 0).length, 0, 'some runs failed outright');
    const notes = read(home, 'e11').notes;
    assert.strictEqual(notes.length, 10, `expected 10 notes, got ${notes.length}`);
  });
});

check('taking over a stale lock leaves nothing behind', () => {
  return withHome((home) => {
    const root = path.join(home, '.claude', 'build-loop');
    const lock = path.join(root, '.queue.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);

    entry(home, 'e12');
    run(home, ['update', 'e12', '--note', 'x']);
    const leftover = fs.readdirSync(root).filter((f) => f.startsWith('.queue.lock'));
    assert.deepStrictEqual(leftover, [], `the takeover left ${leftover} behind`);
  });
});

check('a process does not release a lock that is no longer its own', () => {
  // The mirror of the case above. A process slow enough to be declared stale
  // must not delete the lock of whoever took over from it when it finishes.
  // Asserted through the owner file, which is the thing release() checks.
  return withHome((home) => {
    const lock = path.join(home, '.claude', 'build-loop', '.queue.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), 'someone else');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lock, old, old);

    entry(home, 'e13');
    run(home, ['update', 'e13', '--note', 'took over']);

    // The taker-over wrote, and cleaned up only what it owned.
    assert.strictEqual(read(home, 'e13').notes.length, 1);
    assert.ok(!fs.existsSync(lock), 'the lock it did own was not released');
  });
});

// --- what --field and --json may not touch -------------------------------

check('the notes history cannot be replaced through a field option', () => {
  // The guarantee this whole file rests on is that a caller cannot hand over a
  // notes array, so it cannot hand over a stale one. --json notes=FILE was a
  // way to do exactly that, and the before/after counter still printed 1 -> 1,
  // so the line meant to reveal a loss concealed one instead.
  return withHome((home) => {
    entry(home, 'p1', { notes: [{ ts: 'old', text: 'was here first' }] });
    fs.writeFileSync(path.join(home, 'n.json'), '[]');
    assert.throws(
      () => run(home, ['update', 'p1', '--json', `notes=${path.join(home, 'n.json')}`, '--note', 'new']),
      /notes cannot be set/
    );
    const after = read(home, 'p1');
    assert.strictEqual(after.notes.length, 1, 'the history was touched');
    assert.strictEqual(after.notes[0].text, 'was here first');
  });
});

check('the id cannot be changed out from under its filename', () => {
  return withHome((home) => {
    entry(home, 'p2');
    assert.throws(() => run(home, ['update', 'p2', '--field', 'id=other']), /id cannot be set/);
    assert.strictEqual(read(home, 'p2').id, 'p2');
  });
});

check('prototype keys are refused like any other protected name', () => {
  return withHome((home) => {
    entry(home, 'p3');
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.throws(() => run(home, ['update', 'p3', '--field', `${key}=x`]), /cannot be set/, `${key} was accepted`);
    }
    // And an ordinary field still works, so the list is not refusing everything.
    run(home, ['update', 'p3', '--field', 'repo=fine']);
    assert.strictEqual(read(home, 'p3').repo, 'fine');
  });
});

// --- giving up ------------------------------------------------------------

check('a lock that cannot be taken over is reported rather than spun on', () => {
  // The takeover retry used to jump straight back to the top of the loop,
  // skipping both the deadline and the pause, so a stale lock that could not be
  // moved aside span at full CPU forever. The session looks frozen and no
  // message is ever printed. A directory that is not writable is enough.
  return withHome((home) => {
    const root = path.join(home, '.claude', 'build-loop');
    const lock = path.join(root, '.queue.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 300000);
    fs.utimesSync(lock, old, old);
    entry(home, 'p4');

    // chmod does nothing to root, so under a container that runs tests as root
    // the rename succeeds, the takeover works, and this turns red because of
    // the environment rather than the code. A test that fails for a reason it
    // is not about teaches people to ignore it.
    if (process.getuid && process.getuid() === 0) {
      console.log('        (skipped: running as root, where chmod cannot make a directory unwritable)');
      return;
    }
    fs.chmodSync(root, 0o500); // readable and traversable, not writable
    const started = Date.now();
    try {
      // The message matters as much as the exit: a child killed by the harness
      // timeout also throws, and that is a spin rather than a refusal.
      assert.throws(
        () => run(home, ['update', 'p4', '--note', 'x']),
        (error) => {
          assert.ok(!error.killed, 'it had to be killed, so it never gave up on its own');
          assert.match(String(error.stderr || error.message), /could not take the queue lock/);
          return true;
        }
      );
    } finally {
      fs.chmodSync(root, 0o700);
    }
    const took = Date.now() - started;
    assert.ok(took < 20000, `it took ${took}ms to give up, which is not giving up`);
  });
});

check('a note that begins with dashes is stored as written', () => {
  // The parser used to decide what was a value by looking at the token: if it
  // began with two dashes it could not be one. So this note was stored as the
  // string 'true', the real text was re-read as a flag, and the command exited
  // 0. The wording of what went wrong, lost with nothing to notice.
  return withHome((home) => {
    entry(home, 'a1');
    run(home, ['update', 'a1', '--note', '--force was ignored']);
    assert.strictEqual(read(home, 'a1').notes[0].text, '--force was ignored');

    // The same rule swallowed any value beginning with dashes, not just notes.
    run(home, ['update', 'a1', '--field', 'target=--odd']);
    assert.strictEqual(read(home, 'a1').target, '--odd');

    // This used to be asserted through `--status --odd`, which stored `--odd`
    // as the status. Statuses are a validated enum now, so that assertion was
    // asking for something deliberately illegal. The parser property it was
    // really about survives, and the refusal proves it: the validator can only
    // quote `--odd` back if the parser handed it over as a value rather than
    // reading it as a flag.
    assert.throws(
      () => run(home, ['update', 'a1', '--status', '--odd']),
      /"--odd" is not a status/,
      'the parser read --odd as a flag instead of as the value of --status'
    );
    assert.strictEqual(read(home, 'a1').status, 'Open', 'the refused status was written anyway');
  });
});

check('an unknown option is refused rather than becoming a silent flag', () => {
  return withHome((home) => {
    entry(home, 'a2');
    assert.throws(() => run(home, ['update', 'a2', '--nope', 'x']), /unknown option --nope/);
    assert.throws(() => run(home, ['update', 'a2', '--note']), /--note needs a value/);
    assert.strictEqual(read(home, 'a2').notes.length, 0, 'it wrote despite refusing the arguments');
  });
});

check('--name=value is read whatever the value starts with', () => {
  return withHome((home) => {
    entry(home, 'a3');
    run(home, ['update', 'a3', '--note=--still a note']);
    assert.strictEqual(read(home, 'a3').notes[0].text, '--still a note');
  });
});

check('a run that cannot take the lock leaves nothing behind', () => {
  // The weaker half of the marker-write invariant, and the half that is
  // reachable from outside: whatever goes wrong while trying to acquire, no
  // lock and no half-renamed leftover may survive it. The marker-write path
  // itself needs a write to fail inside a directory that was just created
  // successfully, which cannot be provoked without a full disk, so that one is
  // pinned as a source assertion in queue-writes.test.js instead.
  return withHome((home) => {
    const root = path.join(home, '.claude', 'build-loop');
    entry(home, 'a4');

    // A file where the lock directory belongs: mkdir fails, and it is not stale,
    // so this gives up after WAIT_MS rather than taking over.
    fs.writeFileSync(path.join(root, '.queue.lock'), 'not a directory');
    assert.throws(() => run(home, ['update', 'a4', '--note', 'x']), /could not take the queue lock/);

    const leftovers = fs.readdirSync(root).filter((f) => f.startsWith('.queue.lock') && f !== '.queue.lock');
    assert.deepStrictEqual(leftovers, [], `left ${leftovers} behind`);
    assert.strictEqual(read(home, 'a4').notes.length, 0, 'it wrote without holding the lock');
  });
});

check('no tempfile is left behind', () => {
  return withHome((home) => {
    entry(home, 'e8');
    run(home, ['update', 'e8', '--note', 'x']);
    const left = fs.readdirSync(path.join(home, '.claude', 'build-loop', 'queue')).filter((f) => f.includes('.tmp'));
    assert.strictEqual(left.length, 0, `left tempfiles: ${left}`);
  });
});

runAll();
