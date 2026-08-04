#!/usr/bin/env node
// consistency-lint.js — PostToolUse hook on Write and Edit.
//
// Reports a markdown file that contradicts itself, straight back into the
// conversation, so the model that just wrote it is the one that fixes it.
// Never blocks. These are prose-pattern checks and a false positive that stops
// work costs far more than one that adds a line nobody needed.
//
// Three checks, and each exists because the fault has actually shipped here:
//
//   a stale count      "checks four things" above a table of five. Three times
//                      in three days, each caught by a person reading carefully,
//                      which is not a control.
//   surviving text     a value changed in one place and left standing in
//                      another. Only checkable on an Edit, which is the only
//                      event that says what the old text was.
//   a broken own rule  a file that states "no em dashes" and then uses one.
//
// Any markdown file, not only SKILL.md. The count fault has hit a README, a
// rebuild index and a plugin's upgrade notes, and none of those are skills.
//
// Fails open throughout, like every hook in this plugin.

'use strict';

const fs = require('fs');
const path = require('path');

const { readEvent, advise } = require(path.join(__dirname, '..', 'scripts', 'hook-io.js'));
const { loadConfig } = require(path.join(__dirname, '..', 'scripts', 'config.js'));
const {
  staleCounts, survivingText, brokenOwnRule,
} = require(path.join(__dirname, '..', 'scripts', 'consistency.js'));

// Files nobody should be told about. A handoff is a session note whose counts
// go stale by design between one session and the next, and it is rewritten
// wholesale every time; a warning on it is noise on every single wrap.
const IGNORED_NAMES = new Set(['HANDOFF.md', 'CHANGELOG.md']);

// Line numbers, with a ceiling on how many are named.
//
// Found by sweeping her own markdown rather than by any test: one archived file
// states a rule against em dashes and then breaks it on 509 lines. Naming all
// of them produces a wall of numbers that says less than a count does, and it
// is dropped into the conversation, where it is charged for. The first few and
// a total are what anyone acts on.
const MAX_LINES_NAMED = 6;

function where(lines) {
  if (lines.length === 1) return `line ${lines[0]}`;
  if (lines.length <= MAX_LINES_NAMED) return `lines ${lines.join(', ')}`;
  const shown = lines.slice(0, MAX_LINES_NAMED).join(', ');
  return `${lines.length} lines, starting ${shown}`;
}

// The lines this edit landed on, or null when that cannot be pinned down.
//
// Null means check the whole file, which is the safe answer: reporting a
// finding twice is a nuisance, and missing one is the thing this exists to
// prevent. So every uncertain case fails towards reporting.
//
// A Write has no range at all. It replaces the file, so all of it is new.
function changedRange(content, input) {
  if (input.replace_all) return null;            // many regions, not one
  const needle = input.new_string;
  if (typeof needle !== 'string' || needle === '') return null;

  const first = content.indexOf(needle);
  if (first === -1) return null;                 // not on disk as written
  if (content.indexOf(needle, first + 1) !== -1) return null;  // ambiguous

  const start = content.slice(0, first).split('\n').length;
  return { start, end: start + needle.split('\n').length - 1 };
}

// Would this edit have had anything to do with that finding?
//
// Without this, the two whole-file checks re-report every pre-existing
// contradiction on every subsequent edit to the file. Measured against her own
// history: MEMORY.md was touched 28 times while stating a rule it breaks on 68
// lines, so the same advice would have gone into the conversation 28 times,
// costing tokens each time and being ignored by the second.
//
// 24 of those 28 were Edits and are covered here. The other four were Writes
// and are not, deliberately: a Write replaces the file, so all of it is new
// and all of it is this write's doing. An earlier version of this comment said
// "written 28 times", which read as though the fix missed the case it was
// justified by. The split is stated now rather than the total.
//
// A span rather than a line, because the count check is about a sentence and
// the list under it, and adding a row to that list is exactly how the sentence
// goes stale. Scoping to the edited line alone would miss the case the check
// was written for.
function touches(range, from, to) {
  if (!range) return true;
  return !(to < range.start || from > range.end);
}

// Could taking this text out have changed how long some list is?
//
// List markers and table rows are the direct way. A blank line counts too,
// because removing one joins two lists into one and adding one splits them,
// and the grouping is what gets counted.
function couldChangeAList(removed) {
  if (typeof removed !== 'string') return true;
  return removed.split('\n').some((line) => (
    /^\s*([-*]|\d+\.)\s/.test(line) || /^\s*\|/.test(line) || line.trim() === ''
  ));
}

function ignored(filePath) {
  if (IGNORED_NAMES.has(path.basename(filePath))) return true;
  // Not ours, and not the author's problem either.
  return filePath.split(path.sep).includes('node_modules');
}

// The manifest matcher is a regex against the tool name, so an unanchored
// `Write|Edit` also selects MultiEdit and NotebookEdit, which this then drops
// on the next line. Harmless, and it made the manifest claim a reach the code
// does not have, so the matcher is anchored and these two agree.
//
// Neither is a coverage gap worth closing here. NotebookEdit takes
// `notebook_path` and only ever edits an .ipynb, so it cannot produce the
// markdown this reads, and it carries no `file_path` at all. MultiEdit is not
// in the current tool set. If one returns, the two checks that need no
// old_string could be run for it, and that is a change to make when there is
// something to test it against.
readEvent((event) => {
  if (event.tool_name !== 'Write' && event.tool_name !== 'Edit') return;

  const config = loadConfig();
  if (config.enforce === false) return;

  const input = event.tool_input || {};
  const filePath = input.file_path;
  if (!filePath || !filePath.endsWith('.md')) return;
  if (ignored(filePath)) return;

  // The write may not have landed. Nothing to say about a file that is not
  // there, and reading the event's own copy of the content instead would be
  // reporting on text that never reached the disk.
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const issues = [];

  // A Write makes the whole file new, so there is nothing to narrow to.
  const range = event.tool_name === 'Edit' ? changedRange(content, input) : null;

  // A deletion has no new text, so there is nothing to search the file for and
  // `changedRange` cannot place it. Falling back to the whole file made a
  // deletion the noisiest event there is, re-reporting every old contradiction
  // in a long document every time a line came out of it.
  //
  // Placing it is not possible from the event: the file no longer holds the
  // removed text and the event does not carry what surrounded it. What each
  // check can do instead is say whether a deletion could have caused its kind
  // of finding at all, which is a cheaper question and has a definite answer.
  //
  // Never observed: 0 of 804 markdown edits in her history had an empty
  // new_string. Fixed because it is cheap and right, not because it was hurting.
  const isDeletion = event.tool_name === 'Edit'
    && input.new_string === ''
    && typeof input.old_string === 'string'
    && input.old_string !== '';

  // Removing list items is a real way to make a count above them stale, so a
  // deletion is checked. One that took no list structure with it cannot have
  // changed any list's length, and every finding it would report is older than
  // the edit.
  const countsWorthChecking = !isDeletion || couldChangeAList(input.old_string);

  for (const problem of staleCounts(content)) {
    if (problem.ok) continue;
    if (!countsWorthChecking) continue;
    if (!touches(range, problem.from, problem.to)) continue;
    issues.push(
      `Line ${problem.line} says "${problem.stated}" directly above a `
      + `${problem.kind} of ${problem.count}. Correct the number, or drop it: `
      + `the list is already the count.`
    );
  }

  // Only an Edit carries the text that was replaced. A Write hands over the
  // whole file and has no before, so this check does not apply to one.
  if (event.tool_name === 'Edit') {
    for (const hit of survivingText(content, input.old_string, input.new_string)) {
      issues.push(
        `"${hit.fragment}" was just replaced, but it is still there on ${where(hit.lines)}. `
        + `Either those need the same change, or the edit was narrower than intended.`
      );
    }
  }

  // Taking text out cannot put an em dash in, and cannot state a rule that was
  // not already there. So after a deletion every breach is one that was in the
  // file before, and the author has already seen it.
  for (const broken of isDeletion ? [] : brokenOwnRule(content)) {
    // A rule the edit itself introduced is reported in full, however far the
    // breaches are from it. Adding "never use em dashes" to a file already
    // full of them is a contradiction the edit created, and every one of them
    // is news.
    const ruleIsNew = touches(range, broken.statedAt, broken.statedAt);
    const lines = ruleIsNew ? broken.lines : broken.lines.filter((n) => touches(range, n, n));
    if (!lines.length) continue;

    issues.push(
      `Line ${broken.statedAt} states a rule against ${broken.what}, and there `
      + `is one on ${where(lines)}. Fix the text, or drop the rule if it no longer holds.`
    );
  }

  if (issues.length === 0) return;

  advise('PostToolUse', [
    `consistency-lint: ${filePath} contradicts itself in `
    + `${issues.length === 1 ? 'one place' : `${issues.length} places`}.`,
    ...issues.map((issue, n) => `${n + 1}. ${issue}`),
    'Nothing is blocked. These are checks against the file itself, so each one '
    + 'is either a real contradiction or a bug in this hook, and neither is '
    + 'worth leaving in place.',
  ].join(' '));
});
