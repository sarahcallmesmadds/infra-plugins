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

function run(home, args) {
  return execFileSync(process.execPath, [QUEUE_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

// Starts a run without waiting for it, so several can be in flight at once.
function start(home, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [QUEUE_JS, ...args], {
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
    entry(home, 'e2');
    await Promise.all([
      start(home, ['update', 'e2', '--status', 'Resolved']),
      start(home, ['update', 'e2', '--note', 'still here']),
    ]);
    const after = read(home, 'e2');
    assert.strictEqual(after.status, 'Resolved', 'the status change was lost');
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
    fs.writeFileSync(path.join(home, 'res.json'), JSON.stringify({ outcome: 'fixed' }));
    run(home, ['update', 'e4', '--status', 'Resolved', '--note', 'a', '--note', 'b',
      '--resolution', path.join(home, 'res.json'), '--field', 'repo=other']);
    const after = read(home, 'e4');
    assert.strictEqual(after.status, 'Resolved');
    assert.strictEqual(after.notes.length, 2, 'a repeated --note was dropped');
    assert.strictEqual(after.resolution.outcome, 'fixed');
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
    fs.writeFileSync(f, JSON.stringify({ id: 'taken', created_at: new Date().toISOString(), dedup_key: 'thing::two', notes: [] }));
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
    assert.throws(() => run(home, ['update', 'e9', '--list', 'nonsense', '--note', 'x']), /unknown list/);
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

check('no tempfile is left behind', () => {
  return withHome((home) => {
    entry(home, 'e8');
    run(home, ['update', 'e8', '--note', 'x']);
    const left = fs.readdirSync(path.join(home, '.claude', 'build-loop', 'queue')).filter((f) => f.includes('.tmp'));
    assert.strictEqual(left.length, 0, `left tempfiles: ${left}`);
  });
});

runAll();
