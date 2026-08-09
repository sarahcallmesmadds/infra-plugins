#!/usr/bin/env node
// `queue.js count` must count statuses, never files.
//
// Run: node tests/queue-count.test.js
//
// The fault: flag-issue ended every run with "Queue now has N open items",
// where N came from `ls queue/*.json | wc -l`. A closed entry stays in the same
// directory with its status changed, so that number counted finished work as
// open and only ever climbed. On 2026-08-09 it reported 85 open against 19 that
// were open, the other 66 being resolved or closed.
//
// It is a bad failure for a reason worth writing down: the number is the one
// thing in that message the user cannot check without opening every file, and
// being told there are 85 open bugs when there are 19 makes a queue that is
// being worked look abandoned. The wrong number was also stable and plausible,
// so nothing about it invited a second look.
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
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-count-'));
  for (const list of ['queue', 'to-build']) {
    fs.mkdirSync(path.join(home, '.claude', 'build-loop', list), { recursive: true });
  }
  return home;
}

// Writes an entry straight into the list directory. `create` is deliberately
// not used: these cases need statuses `create` would not write, and the point
// is what `count` reads off disk rather than how it got there.
function put(home, list, id, status, type = 'primary') {
  const dir = path.join(home, '.claude', 'build-loop', list);
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    $schema_version: 5,
    id,
    created_at: '2026-08-09T00:00:00.000Z',
    status,
    type,
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
  }, null, 2));
}

function count(home, args = []) {
  return execFileSync(process.execPath, [QUEUE_JS, 'count', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  }).trim();
}

check('an empty queue is nothing open and nothing closed', () => {
  assert.strictEqual(count(sandbox()), '0 open, 0 closed');
});

check('THE REGRESSION: closed entries never reach the open count', () => {
  // This is the whole fault. Counting files gives 5 here, and 5 was reported
  // as "open items" while only 2 were open.
  const home = sandbox();
  put(home, 'queue', 'a', 'Open');
  put(home, 'queue', 'b', 'Open');
  put(home, 'queue', 'c', 'Resolved');
  put(home, 'queue', 'd', 'Resolved');
  put(home, 'queue', 'e', "Won't Fix");
  assert.strictEqual(count(home), '2 open, 3 closed');
});

check('In Progress is open, because it is work that is not finished', () => {
  const home = sandbox();
  put(home, 'queue', 'a', 'Open');
  put(home, 'queue', 'b', 'In Progress');
  assert.strictEqual(count(home), '2 open, 0 closed');
});

check('fix applied, watching is counted as neither open nor closed', () => {
  // Folding it into open made the total disagree with what the user counts as
  // open by exactly the number of fixes in flight. Folding it into closed
  // would hide work that still has to be confirmed.
  const home = sandbox();
  put(home, 'queue', 'a', 'Open');
  put(home, 'queue', 'b', 'fix applied, watching');
  put(home, 'queue', 'c', 'Resolved');
  assert.strictEqual(count(home), '1 open, 1 watching, 1 closed');
});

check('a loosely spelled closed status still counts as closed', () => {
  // `Wontfix` sat on disk for four days and no reader matched it. A count that
  // compares strictly would put it back in the open total.
  const home = sandbox();
  put(home, 'queue', 'a', 'Wontfix');
  assert.strictEqual(count(home), '0 open, 1 closed');
});

check('open entries are broken down by type when there is more than one', () => {
  const home = sandbox();
  put(home, 'queue', 'a', 'Open', 'primary');
  put(home, 'queue', 'b', 'Open', 'dep-review');
  put(home, 'queue', 'c', 'Open', 'dep-review');
  assert.strictEqual(count(home), '3 open (2 dep-review, 1 primary), 0 closed');
});

check('an unreadable file is reported and lands in neither total', () => {
  // Picking a side for a file that cannot be parsed is how the first version
  // went wrong. It is not evidence of an open entry or of a closed one.
  const home = sandbox();
  put(home, 'queue', 'a', 'Open');
  fs.writeFileSync(path.join(home, '.claude', 'build-loop', 'queue', 'bad.json'), '{ not json');
  fs.writeFileSync(path.join(home, '.claude', 'build-loop', 'queue', 'null.json'), 'null');
  const out = count(home);
  assert.ok(out.startsWith('1 open, 0 closed'), `open and closed totals moved: ${out}`);
  assert.match(out, /2 could not be read/, `the unreadable files were not reported: ${out}`);
});

check('it counts the to-build list when asked', () => {
  const home = sandbox();
  put(home, 'queue', 'a', 'Open');
  put(home, 'to-build', 'x', 'Open');
  put(home, 'to-build', 'y', 'Open');
  assert.strictEqual(count(home, ['--list', 'to-build']), '2 open, 0 closed');
});

check('THE SECOND REGRESSION: Built and Dropped close a to-build item', () => {
  // The first version of this command asked the queue's question of both
  // lists. `CLOSED_ON_DISK` is `Resolved` and `Won't Fix`, neither of which
  // appears in the to-build enum, so every finished item fell through to the
  // open tally and the count climbed exactly like the file count it replaced.
  // Against the real list it reported 38 open where 11 were open.
  const home = sandbox();
  put(home, 'to-build', 'a', 'Open');
  put(home, 'to-build', 'b', 'Built');
  put(home, 'to-build', 'c', 'Built');
  put(home, 'to-build', 'd', 'Dropped');
  assert.strictEqual(count(home, ['--list', 'to-build']), '1 open, 3 closed');
});

check('one list closed word does not close an entry on the other list', () => {
  // The two enums share no closed value, so neither vocabulary may leak into
  // the other. A status that is not one of a list's own closed words is not
  // finished work on that list, whatever it means elsewhere.
  const onToBuild = sandbox();
  put(onToBuild, 'to-build', 'a', 'Resolved');
  assert.strictEqual(count(onToBuild, ['--list', 'to-build']), '1 open, 0 closed',
    'a queue closed word closed a to-build item');

  const onQueue = sandbox();
  put(onQueue, 'queue', 'a', 'Built');
  assert.strictEqual(count(onQueue), '1 open, 0 closed',
    'a to-build closed word closed a queue entry');
});

check('an unknown list is refused rather than counted as empty', () => {
  const home = sandbox();
  let threw = false;
  try { count(home, ['--list', 'nope']); } catch (_) { threw = true; }
  assert.ok(threw, 'an unknown list returned a count instead of a refusal');
});

// --- the skills that report the number -----------------------------------
//
// Asserted against the skill text because that text is the program: nothing
// executes these steps but a model reading them in order, so an ordering fault
// there is as real as one in the script, and nothing else in this repository
// would catch it.

const SKILL = (name) => fs.readFileSync(
  path.join(__dirname, '..', 'plugins', 'build-loop', 'skills', name, 'SKILL.md'), 'utf8'
);

check('flag-issue counts after writing the dep-reviews, not before', () => {
  // The count used to be taken right after the primary entry, so every
  // dep-review written afterwards left it short by one. The message then gave
  // a total and in the next breath announced N entries that total did not
  // include, with both halves on screen at once.
  const src = SKILL('flag-issue');
  const countAt = src.indexOf('queue.js" count');
  const depWritesAt = src.indexOf('## Step 4b');
  assert.ok(countAt > 0, 'flag-issue no longer runs queue.js count at all');
  assert.ok(depWritesAt > 0, 'the dep-review step is no longer called Step 4b');
  assert.ok(
    countAt > depWritesAt,
    'flag-issue takes the queue count before the dep-review entries are written, '
    + 'so the number it reports is short by however many it then announces'
  );
});

check('flag-issue does not count files anywhere', () => {
  const src = SKILL('flag-issue');
  const offending = src.split('\n').filter((line) => (
    /queue\/\*\.json.*wc -l/.test(line) && !/used to be/.test(line)
  ));
  assert.deepStrictEqual(offending, [], 'a file count came back as a live instruction');
});

check('to-build asks the same command for its count', () => {
  // Two hand-written definitions of open is how the two lists come to disagree
  // about the word, and this one has a different set of closed statuses.
  const src = SKILL('to-build');
  assert.match(
    src, /queue\.js" count --list to-build/,
    'to-build counts its open items some other way than the one tested command'
  );
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
