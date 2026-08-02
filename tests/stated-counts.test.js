#!/usr/bin/env node
// A number stated in prose must match the list standing next to it.
//
// Run: node tests/stated-counts.test.js
//
// The bug, three times in three days:
//
//   The 0.3.0 upgrade note said the hook "checks four things" directly above a
//   table of five, and inspect() implements five. REBUILD-INDEX.md called the
//   export 112 files, when 112 is the zip's entry count including directories
//   and 88 are files. Earlier, EXPECTED_CHECKS printed 17 while 20 ran, and
//   `UPDATERS.length * 2 + 4` printed 10 while 13 ran.
//
// Each was fixed by correcting the number, which is the fix that lasts until
// somebody adds a row. The queue entry asked for something else: a count stated
// in prose should be derived from the list it describes, or checked against it,
// and where neither is possible it should not be stated at all, because the
// list is already the count.
//
// Prose cannot derive, so this checks. It finds a count sitting immediately
// above a table or a bullet list and compares it to what is actually there.
//
// What it deliberately does not do. It does not try to understand every
// sentence containing a number. A count is only checked when it is directly
// above a list, within two lines, because that is the shape that goes stale:
// the list grows and the sentence does not. A number anywhere else is left
// alone, which is why this can run over every markdown file in the repository
// without a pile of exclusions.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// Every markdown file that is ours. node_modules and .git are not.
// Files git ignores are not ours to police. HANDOFF.md is a session note that
// changes every time one ends, and failing the suite over its wording would be
// noise nobody can act on.
const IGNORED = new Set(['node_modules', '.git', 'HANDOFF.md']);

function markdownFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, found);
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

// The list that begins at `from`, or null if there is not one. A table counts
// its body rows; a bullet or numbered list counts its top-level items, so a
// nested bullet does not inflate the total.
function listAt(lines, from) {
  let i = from;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return null;

  if (/^\s*\|/.test(lines[i])) {
    const rows = [];
    for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i]);

    // The header rule is found by position, not by shape. The first attempt
    // matched any row built only from pipes, spaces, dashes and colons, and
    // then reset the running total when it saw one. A body row of `| - | - |`
    // meaning "none", or a blank spacer row, matched that and silently
    // discarded every row above it, so a correct sentence above a four-row
    // table was reported as wrong and failed the suite.
    //
    // A real header rule is always the second line of the table and always
    // holds a run of dashes. Both conditions, so a body row cannot be mistaken
    // for one wherever it sits.
    const HEADER_RULE = /^\s*\|[\s|:-]*-{3,}[\s|:-]*\|\s*$/;
    const hasHeader = rows.length > 1 && HEADER_RULE.test(rows[1]);
    const count = hasHeader ? rows.length - 2 : rows.length;
    return count > 0 ? { kind: 'table', count } : null;
  }

  if (/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
    const indent = lines[i].match(/^\s*/)[0].length;
    let items = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const here = line.match(/^\s*/)[0].length;
      if (here < indent) break;
      if (here === indent && /^\s*([-*]|\d+\.)\s/.test(line)) items++;
      else if (here === indent) break;
    }
    return items > 1 ? { kind: 'list', count: items } : null;
  }

  return null;
}

// Every count on a line, with the noun each one counts. The caller picks which
// matters, because only the caller knows the allowlist.
//
// This used to return the last match on the line and nothing else, which was
// wrong in both directions once the allowlist existed. "The four checks below
// apply to 3 fields:" ended on `3 fields`, and `fields` is allowlisted, so 3
// was compared against a four-row list and correct text was reported as wrong.
// "It checks four things across 12 files:" ended on `12 files`, which is not
// allowlisted, so the genuinely stale `four things` was never looked at.
function countIn(line) {
  const re = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+([a-z][a-z-]*s)\b/gi;
  const found = [];
  let hit;
  while ((hit = re.exec(line)) !== null) {
    const raw = hit[1].toLowerCase();
    const value = WORDS[raw] !== undefined ? WORDS[raw] : Number(raw);
    // A year or a version is not a count of anything.
    if (value > 100) continue;
    found.push({ value, noun: hit[2].toLowerCase(), text: hit[0] });
  }
  return found;
}

// The count that is announcing the list, or nothing when that cannot be told.
//
// One allowlisted count on the line is the announcer. Two or more and the line
// is ambiguous, so it is skipped rather than guessed at.
//
// Taking the last one was tried and does not survive "The four checks below
// apply to 3 fields:", where both nouns are allowlisted and the announcer is
// the first. Taking the first does not survive "There are 2 modes and 5
// options:" above a list of options. Nothing short of reading the sentence
// distinguishes them, so neither is chosen.
//
// The cost is a stale count in a two-count sentence going unnoticed. That is
// the right way round: this fails a build, and a guard that fails on correct
// prose gets switched off, after which it catches nothing at all.
function announcedCount(line) {
  const candidates = countIn(line).filter((c) => LIST_NOUNS.has(c.noun));
  return candidates.length === 1 ? candidates[0] : null;
}

// Nouns that name the list itself rather than something else in the sentence.
//
// An allowlist, arrived at by running the loose version over the repository and
// reading all eight things it caught. Every one was wrong: "three plugins here
// ship a cli" above an unrelated list, "up to 20 rows" above a six-row example,
// and "Exit 1 is a real error" read as a count of the word "is". A rule that
// fires eight times and is wrong eight times gets switched off by whoever sees
// it, so the loose version is worse than nothing.
//
// These are the words used when a sentence is announcing what the list under it
// contains. The original bug said "it checks four things" above a table of five.
const LIST_NOUNS = new Set([
  'things', 'checks', 'steps', 'rules', 'cases', 'reasons', 'options',
  'states', 'statuses', 'modes', 'kinds', 'fields', 'columns', 'phases',
  'stages', 'conditions', 'requirements', 'branches', 'outcomes', 'variants',
]);

let failed = 0;
let ran = 0;
let checked = 0;
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

// Collected rather than asserted one at a time, so a run reports every stale
// count rather than only the first.
function staleCounts(text, file) {
  const lines = text.split('\n');
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*([-*]|\d+\.)\s/.test(line)) continue;

    const stated = announcedCount(line);
    if (!stated) continue;

    // Directly above means within two lines, allowing for one blank and a
    // trailing colon on its own line.
    let list = null;
    for (let gap = 1; gap <= 2 && !list; gap++) list = listAt(lines, i + gap);
    if (!list) continue;

    checked += 1;
    if (list.count !== stated.value) {
      problems.push(
        `${path.relative(ROOT, file)}:${i + 1} says "${stated.text}" above a ${list.kind} of ${list.count}`
      );
    }
  }
  return problems;
}

check('no stated count contradicts the list beside it', () => {
  const problems = [];
  for (const file of markdownFiles(ROOT)) {
    problems.push(...staleCounts(fs.readFileSync(file, 'utf8'), file));
  }
  assert.deepStrictEqual(
    problems, [],
    `a number in prose disagrees with the list under it:\n        ${problems.join('\n        ')}\n`
    + '        Correct the number, or drop it: the list is already the count.'
  );
});

check('a pass is reported honestly, however few pairs there were', () => {
  // There may be no count-and-list pairs in the repository at all right now, and
  // that is the expected state: the three known instances were corrected before
  // this file existed. So this does not demand a minimum. What stops it becoming
  // a checker that silently matches nothing forever is the fixture below, which
  // fails if the pattern stops recognising the shape it was written for.
  console.log(`        (${checked} count-and-list pairs found in the repository)`);
});

check('it catches the shape it was written for', () => {
  const sample = [
    'and when the file is a `SKILL.md` it checks four things and reports back',
    '',
    '| Check | What it means |',
    '|-------|---------------|',
    '| one | a |',
    '| two | b |',
    '| three | c |',
    '| four | d |',
    '| five | e |',
  ].join('\n');
  const problems = staleCounts(sample, path.join(ROOT, 'sample.md'));
  assert.strictEqual(problems.length, 1, `expected one problem, got ${problems.length}`);
  assert.match(problems[0], /says "four things" above a table of 5/);

  const fixed = sample.replace('four things', 'five things');
  assert.deepStrictEqual(staleCounts(fixed, path.join(ROOT, 'sample.md')), [], 'a correct count is reported as wrong');
});

check('a body row that looks like a header rule does not eat the table', () => {
  // `| - | - |` meaning "none", and a blank spacer row, both matched the first
  // version of the separator test, which then reset the count to zero. Every
  // row above one was discarded, so a correct count was reported as wrong and
  // the suite failed until the table was rewritten.
  const withDashRow = [
    'it checks four things:',
    '',
    '| Check | Meaning |',
    '|-------|---------|',
    '| a | x |',
    '| - | - |',
    '| c | z |',
    '| d | w |',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(withDashRow, path.join(ROOT, 'sample.md')), [],
    'a body row of dashes was counted as the header rule');

  const withBlankRow = withDashRow.replace('| - | - |', '|   |   |');
  assert.deepStrictEqual(staleCounts(withBlankRow, path.join(ROOT, 'sample.md')), [],
    'a blank spacer row was counted as the header rule');

  // And a table with no header rule at all counts every row.
  const headerless = [
    'it checks two things:',
    '',
    '| a | x |',
    '| b | y |',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(headerless, path.join(ROOT, 'sample.md')), [],
    'a table without a header rule was miscounted');
});

check('a second number in the sentence does not hijack the comparison', () => {
  // Both directions of the same mistake. Taking the last number on the line
  // regardless of its noun compared the wrong one when the sentence ended on
  // an allowlisted noun, and skipped the line entirely when it ended on one
  // that was not.
  const correct = [
    'The four checks below apply to 3 fields:',
    '',
    '| Check | Meaning |',
    '|-------|---------|',
    '| a | 1 |',
    '| b | 2 |',
    '| c | 3 |',
    '| d | 4 |',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(correct, path.join(ROOT, 'sample.md')), [],
    'an ambiguous sentence with two list-nouns was compared rather than skipped');

  const stale = [
    'It checks four things across 12 files:',
    '',
    '| Check | Meaning |',
    '|-------|---------|',
    '| a | 1 |',
    '| b | 2 |',
    '| c | 3 |',
    '| d | 4 |',
    '| e | 5 |',
  ].join('\n');
  const problems = staleCounts(stale, path.join(ROOT, 'sample.md'));
  assert.strictEqual(problems.length, 1, 'a stale count was skipped because the sentence ended on another number');
  assert.match(problems[0], /says "four things" above a table of 5/);
});

check('it leaves a number that is not counting the list alone', () => {
  const sample = [
    'The wait is five seconds, and the options are:',
    '',
    '- one',
    '- two',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(sample, path.join(ROOT, 'sample.md')), [],
    'a duration next to a list was read as a count of it');
});

console.log(`\n${ran} checks, ${failed} failed  (${checked} count-and-list pairs compared)`);
process.exit(failed === 0 ? 0 : 1);
