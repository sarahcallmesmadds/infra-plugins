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

// Phrasings that tell the model to skip the read it was just told to do. These
// are the reason the two checks above are not enough on their own: revert-fix
// said "Read the current queue entry JSON (already loaded — use what you have)"
// and passed both, because the words the checks look for were all present and
// the parenthetical that cancelled them was not looked at.
//
// Matched against the whole file rather than a region. There is no place in an
// updater where reusing a copy read earlier is correct: the point of the read
// is that the file may have changed since.
const CANCELS_THE_READ = [
  /already loaded/i,
  /use what you have/i,
  /from (memory|what you (already )?read)/i,
  /no need to re-?read/i,
];

// Counted as they run and then compared, rather than computed from the shape of
// the loop. This line said `UPDATERS.length * 2 + 4`, which looks derived and is
// not: adding a third check per updater left it reporting 10 while 13 ran. A
// formula that has to be re-derived by hand is a literal wearing a disguise.
const EXPECTED_CHECKS = 13;

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

  check(`${name} does not then excuse the model from the read`, () => {
    const text = skill(name);
    for (const pattern of CANCELS_THE_READ) {
      // The prose explaining why this phrasing was wrong necessarily quotes it,
      // so a line that also says the words were wrong is not an offence.
      const offending = text.split('\n').filter((line) =>
        pattern.test(line) && !/used to say|was wrong|which is an instruction/i.test(line));
      assert.deepStrictEqual(
        offending, [],
        `${name} tells the model it can skip re-reading the entry:\n        `
        + offending.join('\n        ')
        + '\n        The read exists because the file may have changed since.'
      );
    }
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

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + `check, move EXPECTED_CHECKS. If you did not, one has gone missing.`
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
