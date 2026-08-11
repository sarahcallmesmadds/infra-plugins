#!/usr/bin/env node
// Regression tests for what /flag-issue captures at filing time.
//
// Run: node tests/flag-issue-capture.test.js
//
// Both faults were found on 2026-08-11 while trying to work the queue entry
// 2026-08-07T20-33-19-userpromptsubmit, which said only that "the
// UserPromptSubmit hook failed with exit code 127" and that the command was not
// known. Identifying it took a full session. Neither fault is in the queue
// machinery; both are in the instructions the skill gives.
//
// 1. session_id was thrown away. The field list said `fill "" if not available`
//    and never said how to get it, so it was always "". The id is in the
//    scratchpad directory path, which has the shape
//    .../{project-slug}/{session-id}/scratchpad, and it matches a transcript
//    under ~/.claude/projects/. With it, the 08-07 entry would have been a
//    two minute lookup. Without it there was nothing to open: no transcript
//    covers 2026-08-07T20:33Z, and the sessions on either side of it recorded
//    39 hook runs that all exited 0.
//
// 2. A blocked entry was reported as a partial one. With no target_path the
//    entry resolves to repo "unknown", and /apply-fix refuses that outright, so
//    it can never be started by anything. The confirmation said "Logged with
//    missing field. You can edit the file later", which reads as a gap worth
//    tidying rather than a dead item. It sat unworked for four days.
//
// The last check ties the second fault to the thing that causes it. If the
// repo guard in /apply-fix is ever relaxed, the warning /flag-issue prints
// becomes false and this file says so, rather than the two drifting apart.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUILD_LOOP = path.join(__dirname, '..', 'plugins', 'build-loop');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const FLAG_ISSUE = read(BUILD_LOOP, 'skills', 'flag-issue', 'SKILL.md');
const APPLY_FIX = read(BUILD_LOOP, 'skills', 'apply-fix', 'SKILL.md');
const WHATS_BREAKING = read(BUILD_LOOP, 'skills', 'whats-breaking', 'SKILL.md');
const TO_BUILD = read(BUILD_LOOP, 'skills', 'to-build', 'SKILL.md');
const SCHEMA = read(BUILD_LOOP, 'reference', 'SCHEMA.md');
const SCHEMA_BUILD = read(BUILD_LOOP, 'reference', 'SCHEMA-BUILD.md');

// Derived and compared, for the reason set out in deps-keys.test.js: counting
// as they run fixes a stale tally, and comparing still catches a check that
// quietly disappears.
const EXPECTED_CHECKS = 10;

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

// --- session_id ------------------------------------------------------------

check('session_id is not offered as an optional field', () => {
  // The exact old wording. It sat in the field list with no resolution step
  // anywhere near it, so "" was the only reachable answer.
  assert.ok(
    !/session_id:\s+current Claude Code session ID \(fill "" if not available\)/
      .test(FLAG_ISSUE),
    'the session_id field line still reads as optional, with no way to resolve it'
  );
});

check('flag-issue says where the session id actually is', () => {
  assert.ok(
    /scratchpad/.test(FLAG_ISSUE),
    'flag-issue never mentions the scratchpad path, which is where the id is'
  );
  assert.ok(
    /\{session-id\}\/scratchpad|session-id\}\/scratchpad/.test(FLAG_ISSUE),
    'flag-issue does not give the shape of the scratchpad path, so the segment '
    + 'holding the id has to be guessed'
  );
});

check('the derived session id is verified, not trusted', () => {
  // The path shape is a convention, not a guarantee. An id recorded from it
  // without a check is worse than "", because it looks usable and is not.
  assert.ok(
    /~\/\.claude\/projects\/\*\/\{session_id\}\.jsonl/.test(FLAG_ISSUE),
    'flag-issue derives the session id but never checks it against a transcript '
    + 'on disk'
  );
});

// --- blocked entries -------------------------------------------------------

check('a missing target_path is called blocked, not partial', () => {
  assert.ok(
    /blocked/i.test(FLAG_ISSUE),
    'flag-issue never uses the word blocked, so a dead entry still reads as a '
    + 'partial one'
  );
  assert.ok(
    /cannot be started/.test(FLAG_ISSUE),
    'flag-issue does not say that an entry with no path cannot be started'
  );
});

check('the user is warned before the write, not after it', () => {
  // The whole failure is that the cost was described once the entry already
  // existed. The warning has to sit ahead of the write to be worth anything.
  const warning = FLAG_ISSUE.indexOf('Without a file path this cannot be started');
  assert.notStrictEqual(warning, -1, 'the pre-write warning is gone');
  assert.ok(
    /Log it anyway, or name the file\?/.test(FLAG_ISSUE),
    'the warning does not offer to take the path instead, so it reads as a '
    + 'notice rather than a question'
  );
});

// --- the claim matches the thing it describes ------------------------------

check('apply-fix really does refuse repo unknown', () => {
  // flag-issue now tells the user that /apply-fix will refuse the entry. That
  // sentence is only true while this guard exists.
  assert.ok(
    /If `repo` ?== ?"unknown"/.test(APPLY_FIX)
    || /repo == "unknown"/.test(APPLY_FIX),
    'apply-fix no longer guards on repo unknown, so the warning flag-issue '
    + 'prints before writing a pathless entry is now false'
  );
});

// --- nothing else may depend on session_id being empty ---------------------
//
// Devin caught this on PR #96, before it shipped. Filling in session_id is only
// safe if nothing downstream was reading its emptiness as a signal. One thing
// was: whats-breaking counted unique sessions, and slash-capture entries each
// counted separately purely because the field happened to be blank. Resolving
// the id would have collapsed three corrections filed in one sitting into one
// data point, dropped them below the threshold of three, and reported no
// recurring problem. Nothing would have failed. The report would just have
// quietly stopped naming things.

check('whats-breaking counts from source, not from an empty session_id', () => {
  assert.ok(
    !/Dedup token = `entry\.session_id` if it is a non-empty string, else `entry\.id`/
      .test(WHATS_BREAKING),
    'the counting token still keys off session_id being empty, so filling the '
    + 'field in silently stops recurring problems being reported'
  );
  assert.ok(
    /entry\.source/.test(WHATS_BREAKING),
    'whats-breaking never reads source, which is the only field that says '
    + 'whether an entry was typed by a person or fired by a hook'
  );
  assert.ok(
    /"slash-capture"/.test(WHATS_BREAKING) && /"manual"/.test(WHATS_BREAKING),
    'the counting rule does not name the deliberate sources it counts per entry'
  );
});

check('whats-breaking loads the field its counting rule reads', () => {
  // Step 2b reads `source`. Step 1 lists the fields to collect off each entry.
  // A rule reading a field the loader never mentions is the shape that makes a
  // skill work in testing and quietly misbehave against a real queue.
  const step1 = WHATS_BREAKING.slice(0, WHATS_BREAKING.indexOf('## Step 2'));
  assert.ok(
    /^source: string/m.test(step1),
    'Step 2b counts by `source` but Step 1 never loads it'
  );
  assert.ok(
    /Missing `source`/.test(step1),
    'no default is given for a missing `source`, so entries written before the '
    + 'field existed have undefined counting behaviour'
  );
});

check('the schema restates the counting rule the same way', () => {
  // SCHEMA.md carries its own copy of the detection rule. It said
  // `session_id || id` and was the second place the old coupling lived.
  assert.ok(
    !/Dedup by `session_id \|\| id` when counting unique sessions/.test(SCHEMA),
    'SCHEMA.md still documents the old session-based dedup, so the schema and '
    + 'the skill disagree about how a pattern is counted'
  );
  assert.ok(
    /`source`/.test(SCHEMA.slice(SCHEMA.indexOf('### Detection rule'))),
    'the schema detection rule never mentions source'
  );
});

// --- one contract, described once ------------------------------------------

check('no reference still documents session_id as optional', () => {
  for (const [name, text] of Object.entries({
    'SCHEMA.md': SCHEMA,
    'SCHEMA-BUILD.md': SCHEMA_BUILD,
    'to-build/SKILL.md': TO_BUILD,
  })) {
    assert.ok(
      !/\| `session_id` \| string \| yes \|[^|]*\| Fill `""` if not available\. \|/.test(text),
      `${name} still tells the writer to fill "" when it is not available, `
      + 'which contradicts flag-issue'
    );
    assert.ok(
      !/session_id:\s+current session ID, or ""/.test(text),
      `${name} still offers "" as an equal option`
    );
    assert.ok(
      /scratchpad/.test(text),
      `${name} requires a session id but never says where to get one`
    );
  }
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
