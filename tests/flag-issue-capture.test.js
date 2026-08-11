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
const EXPECTED_CHECKS = 18;

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

check('the blocked message names the field that actually unblocks it', () => {
  // Round 1 said the entry could be worked "once someone fills the path in by
  // hand". /apply-fix guards on `repo`, and the Repo Attribution Rule infers
  // repo from the path at capture time and never again, so following that
  // advice leaves the entry refused for the same reason it was refused before.
  //
  // The two checks above pass against the wrong remedy: they pin that the entry
  // is called blocked, and never pin what unblocks it. Naming the blockage and
  // naming the cure are separate assertions, and round 4 exists because only
  // the first was made.
  const bullet = FLAG_ISSUE.slice(
    FLAG_ISSUE.indexOf('is not a partial entry, it is a blocked'),
    FLAG_ISSUE.indexOf('If DEPS.json cannot be read')
  );
  assert.ok(bullet.length > 0, 'the blocked-entry bullet moved and this check no longer reads it');
  assert.ok(
    !/until someone fills the\s+path in by hand/.test(bullet)
    && !/until `target_path` is\s+filled in/.test(bullet),
    'the remedy still points at target_path, which does not move the guard'
  );
  assert.ok(
    /until `repo` is set/.test(bullet),
    'the confirmation does not name `repo`, which is the only field /apply-fix '
    + 'reads before refusing'
  );
  assert.ok(
    /nothing recomputes it afterwards/.test(bullet),
    'nothing tells the reader that editing the path later has no effect, which '
    + 'is the part they would otherwise have to discover by being refused twice'
  );
});

check('flag-issue and apply-fix agree on which field to fix', () => {
  // Agreeing that a guard exists is not the same as agreeing on how to satisfy
  // it. apply-fix's own remedy says to update the repo field; flag-issue's has
  // to send the user to the same place, or the two skills hand out different
  // instructions for one problem.
  assert.ok(
    /update the queue entry's repo field/.test(APPLY_FIX),
    'apply-fix no longer tells the user to set repo, so the two messages have '
    + 'drifted and one of them is now wrong'
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
    /"slash-capture"/.test(WHATS_BREAKING),
    'the counting rule does not name slash-capture, the one source whose '
    + 'behaviour the session_id fix changed'
  );
});

check('only slash-capture counts per entry', () => {
  // Round 1 gave `manual` the same treatment on the argument that a
  // hand-written entry is also deliberate. Devin asked what fault motivated
  // that, and the answer was none: only slash-capture was affected by filling
  // in session_id. The effect would have been to let a few hand-written entries
  // cross the threshold on their own. A behaviour here changes on a fault.
  const rule = WHATS_BREAKING.slice(
    WHATS_BREAKING.indexOf('Counting token, decided by'),
    WHATS_BREAKING.indexOf('Build this map')
  );
  assert.ok(rule.length > 0, 'the counting rule block moved and this check no longer reads it');
  const perEntry = rule.slice(0, rule.indexOf('anything else'));
  assert.ok(
    !/"manual"/.test(perEntry),
    'manual is back in the per-entry branch, which is a behaviour change with '
    + 'no fault behind it'
  );
});

// --- the number and the word beside it --------------------------------------

check('the report does not call occurrences sessions', () => {
  // The failure stated-counts.test.js exists for, in its other form: round 1
  // changed what the number counted and left every sentence printing it still
  // saying "sessions". Three corrections typed in one sitting would have been
  // reported as three sittings, which is the overcounting the dedup half of the
  // rule exists to prevent, arriving through the label instead of the maths.
  assert.ok(
    !/\{N\} corrections across \{M\} sessions/.test(WHATS_BREAKING),
    'the summary template still says the corrections span {M} sessions'
  );
  assert.ok(
    !/has been corrected \{N\} times across \{M\} sessions/.test(WHATS_BREAKING),
    'the diagnosis template still says the corrections span {M} sessions'
  );
  assert.ok(
    !/Threshold is exactly 3 unique sessions/.test(WHATS_BREAKING),
    'the threshold is still stated in sessions'
  );
  assert.ok(
    /occurrence_count/.test(WHATS_BREAKING),
    'the count has no name of its own, so it will be described as whatever the '
    + 'nearest sentence happens to say'
  );
});

check('the renamed count can still be read from an older flags file', () => {
  // pattern-flags.json persists between runs and holds the old key. The file is
  // the only history of what has been flagged, so a rename that cannot read it
  // silently restarts every counter at zero.
  assert.ok(
    /Missing `occurrence_count` → read `session_count` instead/.test(WHATS_BREAKING),
    'nothing maps the old session_count key on read, so a flags file written '
    + 'before 0.9.6 loses its counts'
  );
  assert.ok(
    /`session_count` before 0\.9\.6/.test(SCHEMA),
    'the schema does not record the old field name, so the fallback above reads '
    + 'as unexplained'
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

// --- a version written in prose is still a version -------------------------

check('no prose names a build-loop version this branch does not ship', () => {
  // Round 2 dated the rename to 0.9.7 while every manifest said 0.9.6. The
  // number came from a second branch, built between rounds, that legitimately
  // bumps to 0.9.7. Nothing caught it: plugin-versions.test.js compares the
  // three manifests to each other and plugin-version-drift.test.js compares
  // them to main, and neither reads a sentence.
  //
  // Derived from the manifest rather than written down here, so this check
  // cannot itself go stale the way the prose did.
  const shipped = JSON.parse(
    read(BUILD_LOOP, '.claude-plugin', 'plugin.json')
  ).version;
  const [maj, min] = shipped.split('.');
  const offenders = [];
  for (const [name, text] of Object.entries({
    'whats-breaking/SKILL.md': WHATS_BREAKING,
    'flag-issue/SKILL.md': FLAG_ISSUE,
    'to-build/SKILL.md': TO_BUILD,
    'SCHEMA.md': SCHEMA,
    'SCHEMA-BUILD.md': SCHEMA_BUILD,
  })) {
    text.split('\n').forEach((line, i) => {
      // Only versions in this plugin's own series. A reference to 0.3.1 or
      // 0.9.5 is history and is meant to be there; a number ahead of what
      // ships is the error.
      for (const m of line.matchAll(/\b(\d+)\.(\d+)\.(\d+)\b/g)) {
        if (m[1] !== maj || m[2] !== min) continue;
        if (Number(m[3]) > Number(shipped.split('.')[2])) {
          offenders.push(`${name}:${i + 1} names ${m[0]}, this branch ships ${shipped}`);
        }
      }
    });
  }
  assert.strictEqual(
    offenders.length, 0,
    `prose names a version ahead of the one being released:\n        `
    + offenders.join('\n        ')
  );
});

// --- a renamed field moves the version of the file holding it --------------

check('the pattern-flags rename bumped the file it lives in', () => {
  // SCHEMA.md's own rule: bump when any field is added, renamed, or removed.
  // The previous rename inside this same file followed it, and the v5 changelog
  // row records that. Round 2 renamed session_count and left the version at 2,
  // so a file written with the new name was indistinguishable from one written
  // with the old.
  const writer = WHATS_BREAKING.slice(WHATS_BREAKING.indexOf('## Step 5'));
  assert.ok(
    /"\$schema_version": 3/.test(writer),
    'the pattern-flags writer still stamps a version that predates the '
    + 'occurrence_count rename'
  );
  assert.ok(
    /Version for this file\. Currently 3\./.test(SCHEMA),
    'the schema still describes the pattern-flags version as the pre-rename one'
  );
});

check('the rename is recorded in the changelog', () => {
  // The v5 row set the precedent by recording a pattern-flags bump. A rename
  // that moves a version and leaves no row means the next person reading the
  // history sees a number change with no reason beside it.
  const changelog = SCHEMA.slice(SCHEMA.indexOf('| v1 |'));
  assert.ok(
    /pattern-flags\.json goes to v3/.test(changelog),
    'no changelog row records the pattern-flags v3 bump'
  );
  assert.ok(
    /occurrence_count/.test(changelog),
    'the changelog records a bump without naming the rename that caused it'
  );
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
