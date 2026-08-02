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
function listAt(lines, from, inExample = null) {
  let i = from;
  // At most one blank line. This used to skip an unbounded run, which meant
  // "directly above" was not enforced at all: a sentence and a list five blank
  // lines apart were compared to each other.
  if (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() === '') return null;
  // A list inside an example belongs to the example. This was the stated
  // intent from the start and only ever held for fenced blocks, because the
  // walk stopped at a fence and nothing looked at an indented one. The map was
  // being built for every line and consulted for exactly one of them, the
  // announcing sentence.
  if (inExample && inExample[i]) return null;

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
    // A real header rule is the second line of the table and holds at least one
    // dash. Position is the load-bearing half: a body row of `| - | - |` cannot
    // be mistaken for a rule anywhere else in the table.
    //
    // It asked for three dashes at first, as belt and braces on top of the
    // position. That was not free. GitHub-flavoured markdown accepts one dash
    // per column, so `|-|-|` was not recognised, the two heading lines were
    // counted as content, and a correct four-row table read as six. The
    // position check was already doing the work the dash count was added for,
    // and the extra condition only ruled out valid tables.
    // The trailing pipe is optional, because markdown makes it optional:
    // `|---|---` is a divider and `| a | b` is a row. Requiring it meant such a
    // table had its heading lines counted as content and read two rows too
    // long, so correct documentation failed the suite.
    const HEADER_RULE = /^\s*\|[\s|:-]*-[\s|:-]*\|?\s*$/;
    const hasHeader = rows.length > 1 && HEADER_RULE.test(rows[1]);
    const count = hasHeader ? rows.length - 2 : rows.length;
    return count > 0 ? { kind: 'table', count } : null;
  }

  if (/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
    const indent = lines[i].match(/^\s*/)[0].length;
    let items = 0;
    for (; i < lines.length; i++) {
      const line = lines[i];
      // A blank line inside a list ends the check rather than the list.
      //
      // Blanks used to be transparent, which merged two consecutive lists into
      // one total. The obvious repair, breaking at the blank, is wrong the
      // other way: in CommonMark `- a`, `- b`, blank, `- c`, `- d` is a single
      // loose list of four, and that is what a reader sees rendered. So one
      // shape wants them joined and the other wants them split, and the text
      // does not say which.
      //
      // Neither is guessed at. An ambiguous grouping means no comparison, the
      // same answer as a sentence carrying two counts.
      if (line.trim() === '') {
        // A blank ends a list. It is also what sits between two lists, and
        // between the items of a loose one, and those two are the same
        // characters. So: if bullets resume at this indent after the blank,
        // the grouping is ambiguous and nothing is compared. If they do not,
        // this is simply where the list stopped.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const resumes = j < lines.length
          && lines[j].match(/^\s*/)[0].length === indent
          && /^\s*([-*]|\d+\.)\s/.test(lines[j]);
        if (resumes) return null;
        break;
      }
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
// Nouns describing the width of a table rather than its length are not here.
// `columns` and `fields` were, and a table is only ever counted by its rows, so
// "The report has three columns:" above a three-column table of six rows was
// reported as a contradiction. The noun decided whether to compare and never
// what to compare against.
//
// Teaching the table branch to count columns for those two was the alternative.
// It was not taken. Seven rounds on this file have all been the same shape, a
// guess about which prose belongs to which list going wrong, and every one was
// fixed by checking less. Adding a second thing to measure adds a second thing
// to get wrong, against prose that is rare.
const LIST_NOUNS = new Set([
  'things', 'checks', 'steps', 'rules', 'cases', 'reasons', 'options',
  'states', 'statuses', 'modes', 'kinds', 'phases',
  'stages', 'conditions', 'requirements', 'outcomes', 'variants',
]);

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
function staleCounts(text, file) {
  const lines = text.split('\n');
  const problems = [];

  // Whether line i is inside a code example, tracked across the whole file.
  //
  // The walk from a sentence to its list already stopped at a fence, which
  // covered a fence opening between the two and nothing else. It did not know
  // whether the sentence itself was inside one. So a document showing an
  // example of a stale count was read as containing one, and the most likely
  // author of such a document is whoever writes up this check.
  //
  // Two shapes. A fenced block, and an indented one: four or more spaces on a
  // line that follows a blank. The indent rule wants the blank, because
  // continuation prose inside a numbered step is indented too and is ordinary
  // text.
  const inExample = new Array(lines.length).fill(false);
  let fenced = false;
  let indented = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inExample[i] = true;
      fenced = !fenced;
      continue;
    }
    if (fenced) { inExample[i] = true; continue; }

    if (line.trim() === '') { indented = false; inExample[i] = false; continue; }
    const lead = line.match(/^ */)[0].length;
    const afterBlank = i > 0 && lines[i - 1].trim() === '';
    if (lead >= 4 && (afterBlank || indented)) indented = true;
    else if (lead < 4) indented = false;
    inExample[i] = indented;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inExample[i]) continue;
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*([-*]|\d+\.)\s/.test(line)) continue;

    const stated = announcedCount(line);
    if (!stated) continue;

    // Directly above means the next line, or the one after it when the line
    // between is blank or a lone colon. It used to try `i + 2` unconditionally,
    // which stepped over whatever was there: an unrelated paragraph, or the
    // opening fence of a code block, so a list inside an example was compared
    // against a sentence that had nothing to do with it.
    // Walk to the end of this paragraph, then look for the list.
    //
    // The announcing sentence is not always the last line of its paragraph.
    // The instance this whole file exists for reads "it checks five things and
    // reports back into / the conversation. It never blocks and it never
    // writes." and the table is four lines below. A window of one or two lines
    // was measured against the repository and found nothing at all: it missed
    // that, and every other real case, while the fixtures kept passing because
    // they were built to end at the last bullet.
    //
    // A code fence stops the walk. A list inside an example belongs to the
    // example, not to the sentence above it.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !/^\s*(\||[-*]\s|\d+\.\s)/.test(lines[j])) {
      if (/^\s*(```|~~~)/.test(lines[j])) { j = -1; break; }
      j++;
    }
    if (j < 0) continue;
    const list = listAt(lines, j, inExample);
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
