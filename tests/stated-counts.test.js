#!/usr/bin/env node
// A number stated in prose must match the list standing next to it.
//
// Run: node tests/stated-counts.test.js
//
// This failure has appeared in several live shapes: a heading said "four
// things" above a five-row table, a constant reported 17 checks while 20
// executed, and a derived expression reported 10 updaters while 13 executed.
// Correcting the number lasts only until somebody adds a row.
// A count stated in prose should therefore be derived from the list it
// describes, checked against it, or omitted when the list already is the count.
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

// The detector moved into the plugin on 2026-08-04, so that consistency-lint.js
// could report the same fault at write time. It lived here first and every
// comment in it describes a false positive that reached this suite, which is
// why it was moved rather than copied: a second implementation of this would
// drift, and the subtle one is the one nobody rereads.
//
// This file keeps what it always had, which is the sweep over the repository's
// own markdown and the fixtures that pin each round of fixes. Those are the
// reason to believe the detector works, and they are worth more here, where a
// failure stops a merge, than inside the plugin.
const {
  staleCounts: detect,
} = require(path.join(ROOT, 'plugins', 'slop-check', 'scripts', 'consistency.js'));

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

let failed = 0;
let ran = 0;
let checked = 0;
let repoChecked = 0;
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
//
// A wrapper over the detector, kept so every fixture below reads exactly as it
// did when it was written. Each one pins a false positive that once reached
// this suite, and rewriting them to a new shape at the same time as moving the
// code would have meant changing the evidence and the thing it is evidence for
// in one commit.
//
// `checked` counts every comparison the detector actually made, which is what
// the "is this guard looking at anything" assertion reads. It counts pairs
// found, not problems, so it has to include the ones that came back correct.
function staleCounts(text, file) {
  const problems = [];
  for (const found of detect(text)) {
    checked += 1;
    if (found.ok) continue;
    problems.push(
      `${path.relative(ROOT, file)}:${found.line} says "${found.stated}" `
      + `above a ${found.kind} of ${found.count}`
    );
  }
  return problems;
}

check('no stated count contradicts the list beside it', () => {
  const problems = [];
  const before = checked;
  for (const file of markdownFiles(ROOT)) {
    problems.push(...staleCounts(fs.readFileSync(file, 'utf8'), file));
  }
  repoChecked = checked - before;
  assert.deepStrictEqual(
    problems, [],
    `a number in prose disagrees with the list under it:\n        ${problems.join('\n        ')}\n`
    + '        Correct the number, or drop it: the list is already the count.'
  );
});

check('the guard is actually looking at the repository', () => {
  // This used to print `checked`, which every fixture also increments, and it
  // ran before the fixtures so the number looked plausible while the summary
  // line at the end reported eleven. The repository was contributing none of
  // them: a change three commits earlier had made every real list unreadable,
  // and the mixed counter hid it. A guard that matches nothing passes forever.
  console.log(`        (${repoChecked} count-and-list pairs found in the repository)`);
  assert.ok(repoChecked > 0,
    'no count sits next to a list anywhere in the repository, so this guard is checking nothing. '
    + 'Either the pattern has stopped matching, or every such sentence has gone.');
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

  // A divider written the compact way GitHub also accepts.
  const compact = [
    'it checks four things:',
    '',
    '| a | b |',
    '|-|-|',
    '| 1 | 2 |',
    '| 3 | 4 |',
    '| 5 | 6 |',
    '| 7 | 8 |',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(compact, path.join(ROOT, 'sample.md')), [],
    'a one-dash-per-column divider was counted as content');

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

check('a list has to be directly under the sentence to be its list', () => {
  // "Within two lines" was claimed and not enforced. The blank-line skip was
  // unbounded and the second attempt stepped over whatever line was in the
  // way, so a sentence was compared against a list further down the page, one
  // in a following paragraph, and one inside a fenced code example.
  const farBelow = ['it checks two things.', '', '', '', '', '- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(staleCounts(farBelow, path.join(ROOT, 'sample.md')), [],
    'a list several blank lines away was treated as this sentence\'s list');

  // Prose continuing the same paragraph is part of the announcement, not a
  // barrier. This fixture used to assert the opposite, and that assertion was
  // what made the guard miss every real case: the sentence it was written for
  // is followed by another sentence before its table.
  const restOfParagraph = ['it checks three things, and here is why.', 'A second sentence.', '- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(staleCounts(restOfParagraph, path.join(ROOT, 'sample.md')), [],
    'a correct count was reported wrong because its sentence continued');

  const staleAcrossParagraph = ['it checks two things, and here is why.', 'A second sentence.', '- a', '- b', '- c'].join('\n');
  assert.strictEqual(staleCounts(staleAcrossParagraph, path.join(ROOT, 'sample.md')).length, 1,
    'a stale count was missed because its sentence continued onto another line');

  const inCodeFence = ['it checks two things:', '```', '- a', '- b', '- c', '```'].join('\n');
  assert.deepStrictEqual(staleCounts(inCodeFence, path.join(ROOT, 'sample.md')), [],
    'a list inside a code example was compared against the sentence above it');

  // But the two shapes that are genuinely its list still count.
  const immediate = ['it checks three things:', '- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(staleCounts(immediate, path.join(ROOT, 'sample.md')), [], 'a list on the next line was missed');
  const oneBlank = ['it checks three things:', '', '- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(staleCounts(oneBlank, path.join(ROOT, 'sample.md')), [], 'a list after one blank line was missed');
});

check('a list with a blank line in it is left alone', () => {
  // Two lists separated by a blank, and one loose list with a blank between
  // items, are the same characters. Markdown renders both as one list; a reader
  // writing the first means two. Neither reading can be recovered from the
  // text, so both are skipped rather than one of them being reported as wrong.
  const twoLists = ['it checks two things:', '', '- a', '- b', '', '- c', '- d'].join('\n');
  assert.deepStrictEqual(staleCounts(twoLists, path.join(ROOT, 'sample.md')), [],
    'an ambiguous run of bullets was compared rather than skipped');

  const loose = ['it checks three things:', '', '- a', '', '- b', '', '- c'].join('\n');
  assert.deepStrictEqual(staleCounts(loose, path.join(ROOT, 'sample.md')), [],
    'an ambiguous run of bullets was compared rather than skipped');

  // A tight list, with no blanks in it, is unambiguous and still checked.
  const tight = ['it checks two things:', '', '- a', '- b', '- c'].join('\n');
  const problems = staleCounts(tight, path.join(ROOT, 'sample.md'));
  assert.strictEqual(problems.length, 1, 'a tight list stopped being checked');
  assert.match(problems[0], /says "two things" above a list of 3/);
});

check('a divider without a trailing bar is still a divider', () => {
  const noTrailingBar = ['it checks two things:', '', '| a | b', '|---|---', '| 1 | 2', '| 3 | 4'].join('\n');
  assert.deepStrictEqual(staleCounts(noTrailingBar, path.join(ROOT, 'sample.md')), [],
    'a table written without closing bars had its heading counted as content');
});

check('a count inside a code example is not read as a real one', () => {
  // The walk already refused to step into a fence. It did not know whether the
  // sentence itself was inside one, so a document demonstrating a stale count
  // was reported as containing one. Writing up this check would have done it.
  const fenced = [
    'Example of the thing this catches:',
    '```markdown',
    'it checks two things:',
    '- a',
    '- b',
    '- c',
    '```',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(fenced, path.join(ROOT, 'sample.md')), [],
    'a count inside a fenced example was checked as though it were prose');

  const indentedBlock = [
    'Example:',
    '',
    '    it checks two things:',
    '    - a',
    '    - b',
    '    - c',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(indentedBlock, path.join(ROOT, 'sample.md')), [],
    'a count inside an indented example was checked as though it were prose');

  // The sentence outside the block and the list inside it. The fixtures above
  // put both inside, which is why this went unnoticed: the map was consulted
  // for the sentence and never for the list.
  const listOnlyIndented = [
    'It checks three things:',
    '',
    '    - a',
    '    - b',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(listOnlyIndented, path.join(ROOT, 'sample.md')), [],
    'a list inside an indented example was counted as the sentence\'s list');

  const listOnlyFenced = [
    'It checks three things:',
    '```',
    '- a',
    '- b',
    '```',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(listOnlyFenced, path.join(ROOT, 'sample.md')), [],
    'a list inside a fenced example was counted as the sentence\'s list');

  // And prose after the example closes is checked again.
  const after = fenced + '\n\nit checks two things:\n- a\n- b\n- c';
  assert.strictEqual(staleCounts(after, path.join(ROOT, 'sample.md')).length, 1,
    'the file stopped being checked after a code block closed');
});

check('a count of a table\'s width is not compared against its length', () => {
  const columns = [
    'The report has three columns:',
    '',
    '| a | b | c |',
    '|---|---|---|',
    '| 1 | 2 | 3 |',
    '| 4 | 5 | 6 |',
    '| 7 | 8 | 9 |',
    '| 1 | 2 | 3 |',
    '| 4 | 5 | 6 |',
    '| 7 | 8 | 9 |',
  ].join('\n');
  assert.deepStrictEqual(staleCounts(columns, path.join(ROOT, 'sample.md')), [],
    'a column count was compared against the row count');
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

console.log(`\n${ran} checks, ${failed} failed  (${repoChecked} pairs in the repository, ${checked - repoChecked} in fixtures)`);
process.exit(failed === 0 ? 0 : 1);
