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

  for (const problem of staleCounts(content)) {
    if (problem.ok) continue;
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

  for (const broken of brokenOwnRule(content)) {
    issues.push(
      `Line ${broken.statedAt} states a rule against ${broken.what}, and there `
      + `is one on ${where(broken.lines)}. Fix the text, or drop the rule if it no longer holds.`
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
