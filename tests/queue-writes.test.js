#!/usr/bin/env node
// Every skill that updates an existing queue entry must read it first and
// append to notes rather than rebuild them.
//
// Run: node tests/queue-writes.test.js
//
// The bug: /apply-fix silently dropped notes. Step 8 said to append a note, and
// the write recomposed the entry from scratch, so a note recording that an
// earlier attempt had been abandoned was lost. Observed on a real entry, which
// went from one note to two, and neither of the two was the one already there.
//
// The cause is the Write tool, which replaces a whole file. Anything not
// carried across is gone with no error and no warning, so the instruction has
// to say to carry it across. Step 2 said only "write the updated JSON", which
// reads as an instruction to produce a correct-looking entry rather than to
// preserve the one already on disk, and Step 8 said "append note" with no
// sequence at all. /verify-fix and /revert-fix both spell out read, set,
// append, write, so the same operation was written three ways and only two of
// them worked.
//
// Pinned across all three skills rather than only the one that broke. The two
// that are right today are right by wording alone, and nothing stops the next
// edit from shortening one of them into the version that fails.
//
// What this cannot check: whether the model actually appends. These are source
// assertions on instructions. They catch the instruction going missing, which
// is how this bug got in.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SKILLS = path.join(__dirname, '..', 'plugins', 'build-loop', 'skills');

// Skills that modify an entry that already exists. /flag-issue is deliberately
// absent: it creates entries, and there is nothing yet on disk to preserve.
const UPDATERS = ['apply-fix', 'verify-fix', 'revert-fix'];

function skill(name) {
  const file = path.join(SKILLS, name, 'SKILL.md');
  assert.ok(fs.existsSync(file), `${name}/SKILL.md is missing`);
  return fs.readFileSync(file, 'utf8');
}

// The regions of apply-fix that write the entry. Both had the defect, in
// different ways, so both are checked rather than the file as a whole: a single
// correct passage elsewhere would otherwise cover for a broken one here.
function region(text, from, to) {
  const start = text.indexOf(from);
  assert.ok(start !== -1, `could not find "${from}"`);
  const end = to ? text.indexOf(to, start) : text.length;
  return text.slice(start, end === -1 ? text.length : end);
}

const READS = /read the current queue entry/i;
const APPENDS = /append to (the )?(existing )?`?notes`?/i;

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

for (const name of UPDATERS) {
  check(`${name} reads the entry before writing it`, () => {
    assert.match(
      skill(name), READS,
      `${name} writes a queue entry without being told to read the current one first. `
      + 'The Write tool replaces the whole file, so whatever it does not carry across is lost silently.'
    );
  });

  check(`${name} appends to notes rather than replacing them`, () => {
    assert.match(
      skill(name), APPENDS,
      `${name} no longer says to append to the notes array. Notes are the audit trail, `
      + 'and they are read at exactly the moment something has gone wrong.'
    );
  });
}

check('apply-fix reads the entry at the In Progress write', () => {
  // Step 2. This one said only "write the updated JSON".
  const step2 = region(skill('apply-fix'), '**Set status to In Progress**', '## Step 3');
  assert.match(step2, READS, 'the In Progress write does not read the entry first');
});

check('apply-fix reads the entry at the closing write', () => {
  // Step 8, where the note is added and where the loss was observed.
  const step8 = region(skill('apply-fix'), '**Update the queue entry**', '**Surface dep-review');
  assert.match(step8, READS, 'the closing write does not read the entry first');
  assert.match(step8, APPENDS, 'the closing write does not say to append');
});

check('the closing write says the array must grow', () => {
  // The instruction that makes the failure checkable by whoever reads it back.
  const step8 = region(skill('apply-fix'), '**Update the queue entry**', '---');
  assert.match(
    step8, /one longer|never rebuild/i,
    'nothing states that the notes array must come back longer than it went in, '
    + 'so a rebuild that happens to look right passes unnoticed'
  );
});

check('the checks would actually catch one', () => {
  // A linter nobody has seen fail is a linter nobody should trust.
  const broken = 'Set status via atomic write:\n1. Write the updated JSON to {id}.json.tmp.';
  assert.doesNotMatch(broken, READS, 'the read pattern matches text that never mentions reading');
  assert.doesNotMatch(broken, APPENDS, 'the append pattern matches text that never mentions notes');

  const fixed = '1. Read the current queue entry JSON from disk.\n3. Append to the existing `notes` array:';
  assert.match(fixed, READS, 'the read pattern misses the wording the skills actually use');
  assert.match(fixed, APPENDS, 'the append pattern misses the wording the skills actually use');
});

console.log(`\n${UPDATERS.length * 2 + 4} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
