#!/usr/bin/env node
// queue.js must refuse a status no reader matches.
//
// Run: node tests/queue-status-validation.test.js
//
// The fault: `update` wrote whatever string it was handed. Two queue entries sat
// on disk carrying `Wontfix`, which is not one of the six values in SCHEMA.md.
// Nothing matches it: /list-bugs matches the literal `Won't Fix` in its filter,
// in its status sort order, and in the parent_status band that decides whether
// a dep-review is answerable or waiting. So the two entries were invisible to
// the one filter written to show them, for four days, with no error anywhere.
//
// queue-status-reachable.test.js passes and could never have caught this. It
// checks that every value in the enum is reachable by some filter. This checks
// the other direction: that nothing outside the enum reaches disk.
//
// HOME is redirected to a temp directory, so every assertion runs against a
// queue built for the test and the real one is never touched.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const QUEUE_JS = path.join(
  __dirname, '..', 'plugins', 'build-loop', 'scripts', 'queue.js'
);

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// A fresh HOME per call, so one case's entries cannot reach the next.
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-status-'));
  for (const list of ['queue', 'to-build']) {
    fs.mkdirSync(path.join(home, '.claude', 'build-loop', list), { recursive: true });
  }
  return home;
}

function entryFile(home, list, id, status) {
  const entry = {
    $schema_version: 5,
    id,
    created_at: '2026-08-03T00:00:00.000Z',
    status,
    type: 'primary',
    parent_id: null,
    target: 'thing',
    target_kind: 'script',
    target_path: '/tmp/thing.js',
    repo: 'plugins',
    session_id: '',
    session_cwd: '',
    what_happened: 'x',
    what_expected: 'y',
    correct_example: 'z',
    source: 'manual',
    urgency_hint: 'normal',
    dedup_key: `thing::${id}`,
    notes: [],
    resolution: null,
  };
  const file = path.join(home, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return file;
}

// Returns {code, out}. queue.js writes refusals to stderr and exits non-zero,
// so a throw is the expected path for every refusal case here.
function run(home, args) {
  try {
    const out = execFileSync(process.execPath, [QUEUE_JS, ...args], {
      encoding: 'utf8', timeout: 10000, stdio: 'pipe',
      env: { ...process.env, HOME: home },
    });
    return { code: 0, out };
  } catch (error) {
    return {
      code: error.status === undefined ? -1 : error.status,
      out: `${error.stdout || ''}${error.stderr || ''}`,
    };
  }
}

function seed(home, id, status = 'Open', list = 'queue') {
  const file = entryFile(home, list, id, status);
  const r = run(home, ['create', file, '--list', list, '--dedup-window', '0']);
  assert.strictEqual(r.code, 0, `seeding ${id} failed: ${r.out}`);
  return id;
}

function statusOnDisk(home, id, list = 'queue') {
  const p = path.join(home, '.claude', 'build-loop', list, `${id}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).status;
}

// --- the exact value that caused this -------------------------------------

check('--status Wontfix is refused, and suggests the real value', () => {
  const home = sandbox();
  seed(home, 'a');
  const r = run(home, ['update', 'a', '--status', 'Wontfix']);
  assert.notStrictEqual(r.code, 0, 'Wontfix was accepted');
  assert.ok(/Did you mean "Won't Fix"\?/.test(r.out), `no suggestion in: ${r.out}`);
  assert.strictEqual(statusOnDisk(home, 'a'), 'Open', 'the entry was changed despite the refusal');
});

check('a refusal writes nothing at all, not even the notes in the same call', () => {
  // The refusal happens before the write, so a call that carries both a bad
  // status and a good note must land neither. Half-applying would be worse
  // than refusing, because the entry would then disagree with its own history.
  const home = sandbox();
  seed(home, 'b');
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'this note must not survive');
  const r = run(home, ['update', 'b', '--status', 'Nonsense', '--note-file', note]);
  assert.notStrictEqual(r.code, 0, 'a nonsense status was accepted');
  const p = path.join(home, '.claude', 'build-loop', 'queue', 'b.json');
  assert.strictEqual(JSON.parse(fs.readFileSync(p, 'utf8')).notes.length, 0, 'the note landed anyway');
});

// --- every door in, not just the obvious one ------------------------------

check('--field status=X is validated too', () => {
  // Validating only --status would leave the door it was meant to close
  // standing open right next to it.
  const home = sandbox();
  seed(home, 'c');
  const r = run(home, ['update', 'c', '--field', 'status=Wontfix']);
  assert.notStrictEqual(r.code, 0, '--field bypassed the status check');
  assert.strictEqual(statusOnDisk(home, 'c'), 'Open');
});

check('--json status=FILE is validated too', () => {
  // The fourth door, found in review after the first three were guarded at
  // their call sites. `--json` assigns a parsed value straight onto the entry,
  // so it bypassed every check. It is the reason the guard moved into
  // writeEntry, where no route can go around it.
  const home = sandbox();
  seed(home, 'c2');
  const file = path.join(home, 's.json');
  fs.writeFileSync(file, '"Wontfix"');
  const r = run(home, ['update', 'c2', '--json', `status=${file}`]);
  assert.notStrictEqual(r.code, 0, '--json bypassed the status check');
  assert.strictEqual(statusOnDisk(home, 'c2'), 'Open');
});

check('a status that is not a string is refused, and said to be a type fault', () => {
  // Only --json can express this. Reporting an object as an unrecognised
  // status would name the wrong fault.
  const home = sandbox();
  seed(home, 'c3');
  for (const [json, word] of [['{"a":1}', 'object'], ['["Open"]', 'an array'], ['3', 'number']]) {
    const file = path.join(home, 'v.json');
    fs.writeFileSync(file, json);
    const r = run(home, ['update', 'c3', '--json', `status=${file}`]);
    assert.notStrictEqual(r.code, 0, `${json} was accepted as a status`);
    assert.ok(/has to be a string/.test(r.out), `wrong diagnosis for ${json}: ${r.out}`);
    assert.ok(r.out.includes(word), `did not name the type for ${json}: ${r.out}`);
  }
  assert.strictEqual(statusOnDisk(home, 'c3'), 'Open');
});

check('the guard is in writeEntry, not spread across the call sites', () => {
  // Structural, and the point of the fix. Three call-site guards were written
  // and a fourth route was missed, so the property worth pinning is that the
  // check sits where every write must pass rather than at each way in.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'build-loop', 'scripts', 'queue.js'), 'utf8'
  );
  const body = source.slice(source.indexOf('function writeEntry'));
  const end = body.indexOf('\n}');
  assert.ok(
    /checkStatus\(entry\.status/.test(body.slice(0, end)),
    'writeEntry does not check the status, so a new option can route around it'
  );
});

check('create refuses a composed entry carrying a bad status', () => {
  const home = sandbox();
  const file = entryFile(home, 'queue', 'd', 'Wontfix');
  const r = run(home, ['create', file, '--dedup-window', '0']);
  assert.notStrictEqual(r.code, 0, 'create accepted an off-enum status');
  assert.ok(
    !fs.existsSync(path.join(home, '.claude', 'build-loop', 'queue', 'd.json')),
    'the entry was written despite the refusal'
  );
});

// --- the two lists have different enums -----------------------------------

check('a to-build status is refused on a queue entry', () => {
  const home = sandbox();
  seed(home, 'e');
  const r = run(home, ['update', 'e', '--status', 'Built']);
  assert.notStrictEqual(r.code, 0, '`Built` was accepted into the queue, where no reader knows it');
});

check('a queue status is refused on a to-build item', () => {
  const home = sandbox();
  seed(home, 'f', 'Open', 'to-build');
  const r = run(home, ['update', 'f', '--list', 'to-build', '--status', "Won't Fix"]);
  assert.notStrictEqual(r.code, 0, "`Won't Fix` was accepted into to-build, which uses `Dropped`");
});

check('each list still accepts its own values', () => {
  const home = sandbox();
  seed(home, 'g');
  seed(home, 'h', 'Open', 'to-build');
  for (const s of ['In Progress', 'Resolved', "Won't Fix", 'fix applied, watching', 'Open']) {
    const r = run(home, ['update', 'g', '--status', s]);
    assert.strictEqual(r.code, 0, `queue refused its own value ${JSON.stringify(s)}: ${r.out}`);
    assert.strictEqual(statusOnDisk(home, 'g'), s);
  }
  for (const s of ['In Progress', 'Built', 'Dropped', 'Open']) {
    const r = run(home, ['update', 'h', '--list', 'to-build', '--status', s]);
    assert.strictEqual(r.code, 0, `to-build refused its own value ${JSON.stringify(s)}: ${r.out}`);
    assert.strictEqual(statusOnDisk(home, 'h', 'to-build'), s);
  }
});

// --- legacy entries must stay editable -------------------------------------
//
// Found in review. Moving the guard into writeEntry made it validate on every
// write, including writes that do not touch the status, so an entry already
// carrying a bad or retired value could never be annotated again. The entries
// most in need of a note were the only ones that could not receive one.
//
// The first version of this suite missed it because every fixture it seeded had
// a valid status. A feature that exists for broken data has to be tested
// against broken data.

// Writes an entry straight to disk, bypassing queue.js. This is the only way to
// produce the legacy state the checks below are about.
function plant(home, id, status, list = 'queue') {
  const p = path.join(home, '.claude', 'build-loop', list, `${id}.json`);
  fs.writeFileSync(p, JSON.stringify({ id, status, notes: [] }, null, 2));
  return p;
}

check('a note can be added to an entry carrying the retired status', () => {
  const home = sandbox();
  plant(home, 'p1', 'fix attempted / unresolved');
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'still investigating');
  const r = run(home, ['update', 'p1', '--note-file', note]);
  assert.strictEqual(r.code, 0, `a note-only update was refused: ${r.out}`);
  assert.strictEqual(statusOnDisk(home, 'p1'), 'fix attempted / unresolved', 'the legacy status was not preserved');
});

check('a note can be added to an entry carrying an off-enum status', () => {
  // These are exactly the entries `lint` tells someone to go and look at.
  const home = sandbox();
  plant(home, 'p2', 'Wontfix');
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'noticed by lint');
  const r = run(home, ['update', 'p2', '--note-file', note]);
  assert.strictEqual(r.code, 0, `a note-only update was refused: ${r.out}`);
  assert.strictEqual(statusOnDisk(home, 'p2'), 'Wontfix');
});

check('any other field can be edited without touching the status', () => {
  const home = sandbox();
  plant(home, 'p3', 'Wontfix');
  const r = run(home, ['update', 'p3', '--field', 'repo=plugins']);
  assert.strictEqual(r.code, 0, `a field-only update was refused: ${r.out}`);
});

check('the remediation path works: a bad status can be corrected', () => {
  // The whole point. If lint reports it and nothing can change it, the report
  // is a dead end.
  const home = sandbox();
  plant(home, 'p4', 'Wontfix');
  const r = run(home, ['update', 'p4', '--status', "Won't Fix"]);
  assert.strictEqual(r.code, 0, `correcting an off-enum status was refused: ${r.out}`);
  assert.strictEqual(statusOnDisk(home, 'p4'), "Won't Fix");
});

check('a legacy entry cannot be moved to a different bad status', () => {
  // Preserving what is there is not the same as accepting anything new.
  const home = sandbox();
  plant(home, 'p5', 'Wontfix');
  const r = run(home, ['update', 'p5', '--status', 'Nonsense']);
  assert.notStrictEqual(r.code, 0, 'one bad status was swapped for another');
  assert.strictEqual(statusOnDisk(home, 'p5'), 'Wontfix');
});

// --- the retired value -----------------------------------------------------

check('the retired status is refused on write but not called invalid', () => {
  const home = sandbox();
  seed(home, 'i');
  const r = run(home, ['update', 'i', '--status', 'fix attempted / unresolved']);
  assert.notStrictEqual(r.code, 0, 'a retired status was written');
  assert.ok(/retired/.test(r.out), `the refusal does not explain it is retired: ${r.out}`);
  assert.ok(!/Did you mean/.test(r.out), 'a retired value should not be suggested as a correction');
});

check('lint reports a retired status without failing the run', () => {
  // SCHEMA.md says readers still accept it, so calling it a fault would tell
  // somebody their correct history is corrupt.
  const home = sandbox();
  const p = path.join(home, '.claude', 'build-loop', 'queue', 'j.json');
  fs.writeFileSync(p, JSON.stringify({ id: 'j', status: 'fix attempted / unresolved' }));
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 0, `a retired status failed lint: ${r.out}`);
  assert.ok(/retired/.test(r.out), `lint did not mention it: ${r.out}`);
});

// --- the disk check --------------------------------------------------------

check('lint finds a status already on disk, which validating writes cannot', () => {
  // The reason this command exists. Refusing bad writes from here on does
  // nothing about the entries already stored, and these had been wrong for
  // four days before anyone looked.
  const home = sandbox();
  const p = path.join(home, '.claude', 'build-loop', 'queue', 'k.json');
  fs.writeFileSync(p, JSON.stringify({ id: 'k', status: 'Wontfix' }));
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 3, `expected exit 3 for an off-enum status, got ${r.code}: ${r.out}`);
  assert.ok(/off-enum/.test(r.out), `lint did not report it: ${r.out}`);
  assert.ok(/did you mean "Won't Fix"/i.test(r.out), `lint gave no correction: ${r.out}`);
});

check('lint exits 0 on a clean list', () => {
  const home = sandbox();
  seed(home, 'l');
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 0, `a clean queue failed lint: ${r.out}`);
});

check('lint does not diagnose an unreadable file as an off-enum status', () => {
  const home = sandbox();
  fs.writeFileSync(path.join(home, '.claude', 'build-loop', 'queue', 'm.json'), '{not json');
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 0, 'a malformed file was reported as a status fault');
  assert.ok(/unreadable/.test(r.out), `lint said nothing about it: ${r.out}`);
});

// --- the refusal does not strand the lock ---------------------------------

check('a refused write releases the lock', () => {
  // A refusal that held the lock would be worse than the bug it prevents:
  // every later write would block until the lock aged out.
  const home = sandbox();
  seed(home, 'n');
  run(home, ['update', 'n', '--status', 'Wontfix']);
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'after the refusal');
  const r = run(home, ['update', 'n', '--note-file', note]);
  assert.strictEqual(r.code, 0, `the lock was stranded by the refusal: ${r.out}`);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  queue-status-validation.test.js  ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
