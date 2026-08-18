#!/usr/bin/env node
// Every status a skill can write must be one the default /list-bugs view shows,
// unless the schema calls it terminal.
//
// Run: node tests/queue-status-reachable.test.js
//
// The bug this exists for, found 2026-07-28 by diffing three generations of the
// same skill:
//
//   `fix attempted / unresolved` was added to the status enum in schema v3. It
//   means "the fix was rejected or the write failed, the target file is
//   unchanged", which is an open bug by any reading. No /list-bugs filter
//   reached it. Not the default, not `open`, not `in progress`. So rejecting a
//   diff at the verify gate removed the entry from every view that lists
//   outstanding work, and the entry stayed on disk being counted by
//   /whats-breaking while invisible to the person who filed it.
//
//   The oldest copy of the skill, in claude-skills, DID show it, and said why:
//   "failed-fix entries need re-attention so they stay in the default view
//   alongside open work". Both the behaviour and the sentence explaining it were
//   dropped in the rewrite, so nothing left could tell it had been deliberate.
//
// The fix was to retire the status rather than widen the filter, so the queue
// carries one fewer word and a rejected fix is simply still Open.
//
// `all` reaches every status, so "reachable by some filter" is not the property
// worth testing. The property is that a status meaning NOT DONE appears in the
// view you get when you type /list-bugs with no argument, because that is the
// view people actually use.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUILD_LOOP = path.join(__dirname, '..', 'plugins', 'build-loop');
const read = (...p) => fs.readFileSync(path.join(BUILD_LOOP, ...p), 'utf8');

const SCHEMA = read('reference', 'SCHEMA.md');
const LIST_BUGS = read('skills', 'list-bugs', 'SKILL.md');
const VERIFY_FIX = read('skills', 'verify-fix', 'SKILL.md');
const APPLY_FIX = read('skills', 'apply-fix', 'SKILL.md');

// What the default view shows, and what the schema treats as finished.
const DEFAULT_VIEW = ['Open', 'In Progress'];
const TERMINAL = ['Resolved', "Won't Fix", 'fix applied, watching'];
const RETIRED = 'fix attempted / unresolved';

// See deps-keys.test.js for why this is compared rather than printed.
const EXPECTED_CHECKS = 12;

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

// Every place a skill is told to set a status, and the value it sets.
//
// Two spellings, because there are two. Statuses are now written by calling
// `queue.js update --status X`, and that is the one that matters. The prose
// form is still read as well: it is how a skill describes what the call does,
// and a status named only in prose is still a status somebody has to be able to
// find in /list-bugs. Reading only the calls would let a prose-only mention of
// a retired status slip back in, which is the exact bug this file exists for.
function statusesWrittenBy(text) {
  const found = new Set();
  const patterns = [
    /--status\s+"([^"]+)"/g,
    /--status\s+([A-Za-z][A-Za-z'’ ]*?)(?=\s|`|$)/gm,
    /[Ss]et\s+(?:`status`|status)\s+(?:back\s+)?to\s+`?"([^"]+)"`?/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) found.add(m[1].trim());
  }
  return found;
}

// Discovered, not listed by hand.
//
// The first version of this file named verify-fix and apply-fix and called
// itself a general rule. revert-fix also writes queue statuses, `Open` and
// `Won't Fix`, and was silently outside the rule it claimed to enforce. Both
// values happen to be allowed, so nothing failed and nothing would have.
//
// A hand-kept list of writers is the same shape as run-all's hand-kept list of
// suites: correct the day it is written and quietly behind from then on. So the
// scope is derived from the file instead.
//
// The discriminator is which store a skill writes to, because that is what
// decides which status enum applies. built-check sets `status` to `"Built"`,
// which is valid in SCHEMA-BUILD.md and meaningless here, and it is the only
// skill that touches to-build/ rather than queue/. Excluding it by that fact
// rather than by name means a second to-build skill is excluded automatically
// and a second queue skill is included automatically.
const SKILLS_DIR = path.join(BUILD_LOOP, 'skills');
const WRITERS = {};
for (const name of fs.readdirSync(SKILLS_DIR)) {
  const file = path.join(SKILLS_DIR, name, 'SKILL.md');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes('build-loop/queue')) continue;      // not a queue writer
  if (statusesWrittenBy(text).size === 0) continue;      // reads only
  WRITERS[name] = text;
}

// --- the general rule ------------------------------------------------------

check('every status a skill writes is either in the default view or terminal', () => {
  const allowed = new Set([...DEFAULT_VIEW, ...TERMINAL]);
  const offenders = [];
  for (const [name, text] of Object.entries(WRITERS)) {
    for (const status of statusesWrittenBy(text)) {
      if (!allowed.has(status)) offenders.push(`${name} writes "${status}"`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    `${offenders.join('; ')}. A status that is neither shown by default nor `
    + 'terminal is a bug you cannot find from /list-bugs.');
});

check('the writers actually write something, so the regex has not gone stale', () => {
  // Without this the check above passes trivially the day the phrasing changes.
  for (const [name, text] of Object.entries(WRITERS)) {
    assert.ok(statusesWrittenBy(text).size > 0,
      `found no status writes in ${name}; the extraction regex no longer matches `
      + 'the phrasing, so the rule above is checking nothing');
  }
});

check('discovery finds every queue-status writer, not a subset', () => {
  // The gap this replaced: a hand-kept list held two of the three.
  const found = Object.keys(WRITERS).sort();
  for (const expected of ['apply-fix', 'revert-fix', 'verify-fix']) {
    assert.ok(found.includes(expected),
      `${expected} writes queue statuses and discovery missed it. Found: ${found.join(', ')}`);
  }
});

check('built-check is excluded, and for the right reason', () => {
  // It sets status to "Built", which is SCHEMA-BUILD.md's enum, not this one.
  // Excluded because it writes to-build/ rather than queue/, so a second
  // to-build skill drops out automatically and is not another name to maintain.
  assert.ok(!Object.keys(WRITERS).includes('built-check'),
    'built-check is in scope; its "Built" status belongs to the to-build schema '
    + 'and would fail a rule about queue statuses');
  const builtCheck = read('skills', 'built-check', 'SKILL.md');
  assert.ok(statusesWrittenBy(builtCheck).size > 0,
    'built-check no longer writes a status, so this exclusion is now testing nothing');
  assert.ok(!builtCheck.includes('build-loop/queue'),
    'built-check now references the queue, so the discriminator no longer separates '
    + 'the two schemas and the exclusion is accidental rather than principled');
});

check('the default /list-bugs filter is still Open plus In Progress', () => {
  // The rule above is only meaningful while this is what "default" means.
  assert.match(LIST_BUGS, /Empty → filter = `open-and-in-progress`/);
  for (const status of DEFAULT_VIEW) {
    assert.ok(new RegExp(`\`${status}\``).test(LIST_BUGS),
      `the default filter no longer mentions ${status}`);
  }
});

// --- the specific regression -----------------------------------------------

check('no skill writes the retired status', () => {
  for (const [name, text] of Object.entries(WRITERS)) {
    assert.ok(!statusesWrittenBy(text).has(RETIRED),
      `${name} still sets "${RETIRED}"`);
  }
});

check('verify-fix puts a rejected fix back to Open', () => {
  assert.match(VERIFY_FIX, /queue\.js"? update \{id\} --status Open/,
    'the fail path no longer returns the entry to Open');
});

check('verify-fix records the rejected attempt in notes', () => {
  // Retiring the status only works if the information it carried survives.
  // The note text moved out of the command line and into the prose above it,
  // because it interpolates what the user typed and had to stop being a shell
  // argument. So this looks for the text near the status change rather than
  // inside the call, in either order.
  assert.ok(
    /--status Open[\s\S]{0,600}?attempted and rejected/.test(VERIFY_FIX)
    || /attempted and rejected[\s\S]{0,600}?--status Open/.test(VERIFY_FIX),
    'the fail path sets Open without recording that an attempt was made, so the '
    + 'retirement lost information rather than moving it'
  );
});

check('the rejection note does not assert a file state both modes cannot share', () => {
  // Step V4 is reached from Mode A, where the file was never written, and from
  // Mode B, where the fix was applied and committed in an earlier session. A
  // fixed sentence about the file is false in one of them. It was false in Mode
  // B on first write: the note said the file was unchanged, directly above the
  // branch offering to help restore it, which only makes sense if it changed.
  const note = VERIFY_FIX.match(/Fix attempted and rejected[^\n]+/);
  assert.ok(note, 'could not find the note the fail path appends');
  assert.ok(!/target file is unchanged/.test(note[0]),
    'the note hardcodes "the target file is unchanged", which is false whenever '
    + 'Step V4 is reached from Mode B');
  assert.ok(/\{file_state\}/.test(note[0]),
    'the note should take the file state from the calling mode rather than stating one');
  assert.match(VERIFY_FIX, /Mode B[\s\S]{0,200}?already committed/,
    'Step V4 no longer defines what file_state means in Mode B, so the caller has '
    + 'nothing to substitute');
});

check('apply-fix leaves the entry Open when the write fails', () => {
  assert.ok(
    /--status Open[\s\S]{0,400}?Write tool failed/.test(APPLY_FIX)
    || /Write tool failed[\s\S]{0,400}?--status Open/.test(APPLY_FIX),
    'a failed write still parks the entry in a status no default view shows');
});

check('readers still accept the retired status', () => {
  // Retired for writing, not for reading. Entries written before 0.3.1 carry it
  // and must not become unreachable a second time.
  assert.ok(APPLY_FIX.includes(RETIRED),
    'apply-fix no longer handles the legacy value, so a pre-0.3.1 entry is stuck');
  assert.match(SCHEMA, new RegExp(`\`${RETIRED}\`[\\s\\S]{0,40}?Retired`),
    'SCHEMA.md no longer marks the status retired, so it reads as current');
});

check('the check would catch the bug it was written for', () => {
  // The evidence the rule rests on. Feed it the old wording and it must fail.
  const asItWas = 'Run atomic write to set status to `"fix attempted / unresolved"` with note';
  const found = statusesWrittenBy(asItWas);
  assert.ok(found.has(RETIRED), 'the extraction misses the phrasing the bug used');
  assert.ok(![...DEFAULT_VIEW, ...TERMINAL].includes(RETIRED),
    'the retired status is being treated as allowed, so the rule cannot fire');
});

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        expected ${EXPECTED_CHECKS}, ran ${ran}. Update EXPECTED_CHECKS when adding one.`
  );
}

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed === 0 ? 0 : 1);
