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

// The `--resolution FILE` arguments a status needs to be written, and nothing
// for a status that is not a closure.
//
// Closing an entry has to say what closing it meant, and the outcome has to be
// one that status can carry. The cases below that walk an entry into a closed
// status are about the status enum and not about that rule, so they satisfy it
// rather than route around it: writing `Resolved` with no resolution is the
// hole review found, and a test that kept doing it would be pinning the hole.
const CLOSING = new Map([
  ['Resolved', { outcome: 'fix_applied', at: '2026-08-05T12:00:00.000Z', summary: 'closed by a test' }],
  ["Won't Fix", { outcome: 'wont_fix', at: '2026-08-05T12:00:00.000Z', summary: 'closed by a test' }],
]);

function closing(home, status) {
  const shape = CLOSING.get(status);
  if (!shape) return [];
  const file = path.join(home, `resolution-${String(status).replace(/[^a-z0-9]/gi, '')}.json`);
  fs.writeFileSync(file, JSON.stringify(shape));
  return ['--resolution', file];
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
    const r = run(home, ['update', 'g', '--status', s, ...closing(home, s)]);
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

check('repairing a closed entry needs no resolution, closing an open one does', () => {
  // The two halves of one rule, pinned together because getting either alone
  // is easy and wrong. Closing an entry has to say what closing it meant, and
  // `Wontfix` to `Won't Fix` is not a closing act: the entry was already
  // closed, badly spelled, by somebody who had no resolution field to fill in.
  // Demanding one there would refuse the exact command `lint` prints.
  const home = sandbox();

  plant(home, 'p6', 'Wontfix');
  const repaired = run(home, ['update', 'p6', '--status', "Won't Fix"]);
  assert.strictEqual(repaired.code, 0, `repairing a closed entry was refused: ${repaired.out}`);
  assert.strictEqual(statusOnDisk(home, 'p6'), "Won't Fix");

  seed(home, 'p7');
  const closed = run(home, ['update', 'p7', '--status', "Won't Fix"]);
  assert.notStrictEqual(closed.code, 0, 'an open entry closed with nothing recorded');
  assert.ok(/needs a resolution/.test(closed.out), `refused for the wrong reason: ${closed.out}`);
  assert.strictEqual(statusOnDisk(home, 'p7'), 'Open', 'the entry changed anyway');
});

check('a legacy entry cannot be moved to a different bad status', () => {
  // Preserving what is there is not the same as accepting anything new.
  const home = sandbox();
  plant(home, 'p5', 'Wontfix');
  const r = run(home, ['update', 'p5', '--status', 'Nonsense']);
  assert.notStrictEqual(r.code, 0, 'one bad status was swapped for another');
  assert.strictEqual(statusOnDisk(home, 'p5'), 'Wontfix');
});

// --- a new entry must carry a status ---------------------------------------

check('create refuses an entry with no status at all', () => {
  // Found in review. Both guards asked whether a status was present before
  // checking it, so an entry with none went straight to disk and `lint` then
  // reported it as broken. The tool accepted something it went on to call a
  // fault, and `status` is required by both schemas.
  const home = sandbox();
  const file = path.join(home, 'e.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'z1', notes: [] }));
  const r = run(home, ['create', file, '--dedup-window', '0']);
  assert.notStrictEqual(r.code, 0, 'an entry with no status was created');
  assert.ok(/needs a status/.test(r.out), `wrong diagnosis: ${r.out}`);
  assert.ok(
    !fs.existsSync(path.join(home, '.claude', 'build-loop', 'queue', 'z1.json')),
    'the entry was written despite the refusal'
  );
});

check('an entry already on disk without a status stays editable', () => {
  // Absent is preserved, never introduced, for the same reason a legacy value
  // is: it can be annotated while somebody decides what it should be.
  const home = sandbox();
  const p = path.join(home, '.claude', 'build-loop', 'queue', 'z2.json');
  fs.writeFileSync(p, JSON.stringify({ id: 'z2', notes: [] }));
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'still deciding');
  const r = run(home, ['update', 'z2', '--note-file', note]);
  assert.strictEqual(r.code, 0, `a note-only update was refused: ${r.out}`);
});

check('lint names a missing status readably rather than as a bare word', () => {
  // JSON.stringify(undefined) is undefined, not a string, so this printed
  // `status=undefined`, which reads like a value somebody typed.
  const home = sandbox();
  fs.writeFileSync(
    path.join(home, '.claude', 'build-loop', 'queue', 'z3.json'),
    JSON.stringify({ id: 'z3' })
  );
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 3);
  assert.ok(/status=\(none\)/.test(r.out), `unreadable report: ${r.out}`);
  assert.ok(!/status=undefined/.test(r.out), `still prints a bare undefined: ${r.out}`);
  assert.ok(/1 entry carries/.test(r.out), `subject and verb disagree: ${r.out}`);
});

// --- the enums here and the enums in the schemas are one thing --------------

check('every status in the schema docs is writable by queue.js', () => {
  // Raised in review. The Map in queue.js is a second copy of the tables in
  // SCHEMA.md and SCHEMA-BUILD.md, and nothing tied them together. Adding a
  // status to a schema and forgetting the Map now makes that value unwritable
  // rather than merely undocumented, which is a harder failure than the one
  // that existed before this file validated anything.
  const { STATUSES } = require('../plugins/build-loop/scripts/queue.js');
  const docs = [
    ['queue', 'SCHEMA.md'],
    ['to-build', 'SCHEMA-BUILD.md'],
  ];
  for (const [list, file] of docs) {
    const text = fs.readFileSync(
      path.join(__dirname, '..', 'plugins', 'build-loop', 'reference', file), 'utf8'
    );
    const at = text.indexOf('## Status Enum');
    assert.notStrictEqual(at, -1, `${file} has no Status Enum section to compare against`);

    // The first contiguous table after the heading. SCHEMA.md carries a second
    // table in the same section for the note markers, and pulling its rows in
    // would compare statuses against `Committed:`.
    const lines = text.slice(at).split('\n');
    const documented = [];
    let started = false;
    for (const line of lines.slice(1)) {
      const isRow = line.startsWith('|');
      if (!isRow && started) break;
      if (!isRow) continue;
      started = true;
      const cell = line.match(/^\|\s*`([^`]+)`/);
      if (cell) documented.push(cell[1]);
    }
    assert.ok(documented.length >= 4, `parsed only ${documented.length} rows from ${file}`);

    const known = new Set([...STATUSES.get(list).write, ...STATUSES.get(list).retired]);
    const undocumented = [...known].filter((s) => !documented.includes(s));
    const unknown = documented.filter((s) => !known.has(s));
    assert.deepStrictEqual(
      unknown, [],
      `${file} documents ${JSON.stringify(unknown)}, which queue.js will refuse to write`
    );
    assert.deepStrictEqual(
      undocumented, [],
      `queue.js accepts ${JSON.stringify(undocumented)} for ${list}, which ${file} does not document`
    );
  }
});

// --- an empty value is a value, not an omission ----------------------------

check('--status "" is refused rather than silently ignored', () => {
  // Found in review. The assignment was gated on truthiness, so an empty string
  // was skipped, the entry kept its old status, and the command printed
  // "updated" and exited 0 having changed nothing. The other two routes refused
  // the same value, so all three disagreed.
  const home = sandbox();
  seed(home, 'y1');
  const r = run(home, ['update', 'y1', '--status', '']);
  assert.notStrictEqual(r.code, 0, 'an empty status reported success');
  assert.strictEqual(statusOnDisk(home, 'y1'), 'Open');
});

check('all three routes agree about an empty status', () => {
  // The property behind the bug. Whatever a route does with a value, the other
  // routes must do the same, or the one somebody happens to use decides the
  // answer.
  const home = sandbox();
  seed(home, 'y2');
  const file = path.join(home, 'empty.json');
  fs.writeFileSync(file, '""');
  const routes = [
    ['--status', ['update', 'y2', '--status', '']],
    ['--field', ['update', 'y2', '--field', 'status=']],
    ['--json', ['update', 'y2', '--json', `status=${file}`]],
  ];
  for (const [name, args] of routes) {
    const r = run(home, args);
    assert.notStrictEqual(r.code, 0, `${name} accepted an empty status`);
  }
  assert.strictEqual(statusOnDisk(home, 'y2'), 'Open');
});

check('--resolution "" is reported rather than skipped', () => {
  // The same truthiness shape on the option beside it, and the error names the
  // empty filename instead of rendering it as nothing.
  const home = sandbox();
  seed(home, 'y3');
  const r = run(home, ['update', 'y3', '--resolution', '']);
  assert.notStrictEqual(r.code, 0, 'an empty resolution reported success');
  assert.ok(/needs a filename/.test(r.out), `unclear message: ${r.out}`);
  assert.ok(!/cannot read {2}for/.test(r.out), `the filename rendered as nothing: ${r.out}`);
});

check('leaving the option off still changes nothing and succeeds', () => {
  // The distinction the fix rests on. Omitting --status means "leave it alone".
  // Passing an empty one does not.
  const home = sandbox();
  seed(home, 'y4');
  const note = path.join(home, 'n.txt');
  fs.writeFileSync(note, 'note only');
  const r = run(home, ['update', 'y4', '--note-file', note]);
  assert.strictEqual(r.code, 0, `a note-only update was refused: ${r.out}`);
  assert.strictEqual(statusOnDisk(home, 'y4'), 'Open');
});

// --- a file that parses but holds no entry ---------------------------------
//
// `JSON.parse` accepts `null`, `3`, `"x"` and `[]`. None is an entry. Property
// access on most yields undefined and passes quietly; on `null` it throws. So
// the four characters `null` in one file used to take down whatever was reading
// the directory. Review found it in `lint`; it was in four places.

function junk(home, name, text, list = 'queue') {
  fs.writeFileSync(path.join(home, '.claude', 'build-loop', list, `${name}.json`), text);
}

check('lint survives a file holding null and still reports the real fault', () => {
  // The reported case. It aborted the scan, so entries after the bad file were
  // never examined, and it exited on the generic failure code rather than the
  // deliberate 3, which is what tells a caller a finding from a crash.
  const home = sandbox();
  junk(home, 'bad', 'null');
  junk(home, 'ok', JSON.stringify({ id: 'ok', status: 'Wontfix' }));
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 3, `expected the finding code, got ${r.code}: ${r.out}`);
  // The id, not `ok.json`. This asserted the filename until the report was
  // corrected to print what its own fix command accepts.
  assert.ok(/off-enum {2}ok {2}status/.test(r.out), `the real fault was not reported: ${r.out}`);
  assert.ok(/unreadable 1 file/.test(r.out), `the junk file was not counted: ${r.out}`);
  assert.ok(!/TypeError/.test(r.out), `it crashed: ${r.out}`);
});

check('lint treats every non-entry shape as unreadable', () => {
  const home = sandbox();
  const shapes = { a: 'null', b: '[]', c: '3', d: '"x"', e: 'true' };
  for (const [name, text] of Object.entries(shapes)) junk(home, name, text);
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 0, `nothing here is a status fault, so exit 0 was expected: ${r.out}`);
  assert.ok(
    /unreadable 5 file/.test(r.out),
    `expected all five counted as unreadable: ${r.out}`
  );
});

check('one corrupt neighbour does not block every new entry', () => {
  // The worst of the four and not the one reported. create's duplicate scan
  // reads every neighbour, and it crashed on this one, so a single bad file
  // anywhere in the directory stopped all writes. The loop already had a
  // `catch { continue }` meant to tolerate a bad neighbour; the fault was
  // after the parse rather than in it.
  const home = sandbox();
  junk(home, 'bad', 'null');
  const file = path.join(home, 'n.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'fresh', status: 'Open', dedup_key: 'a::b', notes: [] }));
  const r = run(home, ['create', file]);
  assert.strictEqual(r.code, 0, `a corrupt neighbour blocked an unrelated create: ${r.out}`);
});

check('update and show refuse a non-entry rather than crashing', () => {
  const home = sandbox();
  junk(home, 'bad', 'null');
  for (const args of [['update', 'bad', '--status', 'Open'], ['show', 'bad']]) {
    const r = run(home, args);
    assert.strictEqual(r.code, 1, `${args[0]} gave ${r.code}: ${r.out}`);
    assert.ok(/does not hold an entry/.test(r.out), `unclear message from ${args[0]}: ${r.out}`);
    assert.ok(/it holds null/.test(r.out), `the message does not say what it found: ${r.out}`);
    assert.ok(!/TypeError/.test(r.out), `${args[0]} crashed: ${r.out}`);
  }
});

check('create refuses a composed file that parses to a non-entry', () => {
  const home = sandbox();
  const file = path.join(home, 'nul.json');
  fs.writeFileSync(file, 'null');
  const r = run(home, ['create', file]);
  assert.strictEqual(r.code, 1, `expected a refusal, got ${r.code}: ${r.out}`);
  assert.ok(/does not hold an entry/.test(r.out), `unclear message: ${r.out}`);
  assert.ok(!/TypeError/.test(r.out), `it crashed: ${r.out}`);
});

// --- lint's advice has to work when followed -------------------------------

check("lint's printed fix works verbatim, on both lists", () => {
  // Found in review. The command omitted --list, and cmdUpdate falls back to
  // the queue, so a fix copied out of a `--list to-build` run looked for the id
  // in the wrong place. It also printed `x.json` where the command wants a bare
  // id, giving "no entry at .../x.json.json".
  //
  // Driven rather than pattern-matched: the command is taken out of the output,
  // filled in, and run. That is the only assertion that cannot pass while the
  // advice is broken.
  for (const [list, bad, good] of [['queue', 'Wontfix', "Won't Fix"], ['to-build', 'Shipped', 'Dropped']]) {
    const home = sandbox();
    junk(home, 'thing', JSON.stringify({ id: 'thing', status: bad }), list);
    const r = run(home, list === 'queue' ? ['lint'] : ['lint', '--list', list]);
    assert.strictEqual(r.code, 3, `expected a finding on ${list}: ${r.out}`);

    const printed = r.out.match(/Fix with: queue\.js (.+)/);
    assert.ok(printed, `no fix command printed for ${list}: ${r.out}`);

    const args = printed[1].trim().split(/\s+/)
      .map((a) => (a === '<id>' ? 'thing' : a === '<valid>' ? good : a));
    const applied = run(home, args);
    assert.strictEqual(
      applied.code, 0,
      `lint on ${list} printed "${printed[1]}", which does not work: ${applied.out}`
    );
    assert.strictEqual(statusOnDisk(home, 'thing', list), good, `the fix hit the wrong entry on ${list}`);
  }
});

check('lint reports ids, not filenames', () => {
  const home = sandbox();
  junk(home, 'thing', JSON.stringify({ id: 'thing', status: 'Wontfix' }));
  const r = run(home, ['lint']);
  assert.ok(/off-enum {2}thing {2}status/.test(r.out), `not reported as an id: ${r.out}`);
  assert.ok(!/thing\.json/.test(r.out), `still printing a filename: ${r.out}`);
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

check('a suggestion, when followed, is accepted', () => {
  // The property worth pinning, rather than the wording. Advice that fails when
  // taken costs a second attempt and teaches nothing. Every suggested value is
  // applied here and has to work.
  const home = sandbox();
  seed(home, 'q1');
  const suggested = /Did you mean "((?:[^"\\]|\\.)*)"\?/;
  const wrong = ['Wontfix', 'wont fix', 'RESOLVED', 'in progress', 'openn', 'Fix Applied, Watching'];
  let seen = 0;
  for (const value of wrong) {
    const r = run(home, ['update', 'q1', '--status', value]);
    assert.notStrictEqual(r.code, 0, `${value} was accepted`);
    const match = r.out.match(suggested);
    if (!match) continue;
    seen += 1;
    const suggestedValue = match[1].replace(/\\"/g, '"');
    const applied = run(home, ['update', 'q1', '--status', suggestedValue, ...closing(home, suggestedValue)]);
    assert.strictEqual(
      applied.code, 0,
      `refusing ${JSON.stringify(value)} suggested ${JSON.stringify(match[1])}, which is itself refused: ${applied.out}`
    );
  }
  assert.ok(seen >= 3, `expected several suggestions to test, saw ${seen}`);
});

check('a misspelt retired status is not offered the retired value', () => {
  // It used to be. The near-miss search included the retired values, so this
  // said `Did you mean "fix attempted / unresolved"?` and then refused exactly
  // that when the person typed it.
  const home = sandbox();
  seed(home, 'q2');
  for (const value of ['fix attempted/unresolved', 'Fix Attempted / Unresolved']) {
    const r = run(home, ['update', 'q2', '--status', value]);
    assert.notStrictEqual(r.code, 0, `${value} was accepted`);
    assert.ok(!/Did you mean/.test(r.out), `sent to a dead end for ${value}: ${r.out}`);
    assert.ok(/retired/.test(r.out), `did not explain it is retired for ${value}: ${r.out}`);
    assert.ok(/leaves the entry "Open"/.test(r.out), `gave no way forward for ${value}: ${r.out}`);
  }
});

check('lint never suggests a value its own fix command would refuse', () => {
  const home = sandbox();
  plant(home, 'q3', 'Fix Attempted / Unresolved');
  const r = run(home, ['lint']);
  assert.strictEqual(r.code, 3, `expected an off-enum finding, got ${r.code}: ${r.out}`);
  const match = r.out.match(/did you mean "((?:[^"\\]|\\.)*)"\?/);
  if (match) {
    const applied = run(home, ['update', 'q3', '--status', match[1]]);
    assert.strictEqual(applied.code, 0, `lint suggested ${match[1]}, which update refuses: ${applied.out}`);
  }
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
