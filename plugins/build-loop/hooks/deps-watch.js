#!/usr/bin/env node
// deps-watch.js — PostToolUse hook on Write and Edit.
//
// Keeps DEPS.json honest without anybody remembering to. When a mapped file is
// edited, this reads what the file now calls and compares it to what the map
// records. Two outcomes and nothing in between:
//
//   nothing new appeared   The entry is stamped as confirmed against the file
//                          as it now stands, silently. This is the common case
//                          and the whole point: ordinary edits stop
//                          accumulating a warning nobody can act on.
//
//   something new appeared The file calls a mapped target with no recorded
//                          edge. That is the case where /flag-issue would miss
//                          a dependent, so it is said out loud and the entry is
//                          NOT stamped, leaving the drift visible until
//                          /audit-deps records the edge properly.
//
// THE WARNING AND THE DRIFT NAMED ABOVE ARE GONE AS OF SESSION 0.8.7. Both
// meant the session brief's drift line, which compared a file's modification
// time against its entry's recorded date. It was removed for reporting 82 of
// 127 entries as changed with nothing actually missing, because `last_updated`
// is a review date that is never bumped by machine. So the first row's "stop
// accumulating a warning" describes a warning that no longer exists, and the
// second row's "leaving the drift visible" points at a line that is not there.
//
// What survives is the second row's other half: saying it out loud in the
// conversation. That was always the useful part and it is untouched. The stamp
// still happens and nothing reads it, which is a live question rather than an
// oversight, filed as queue entry 2026-08-15T19-17-34-deps-watch.
//
// It never edits the edges itself. Writing an edge means writing the `reason`
// that goes with it, and a sentence explaining why two things are connected is
// a judgment, not an extraction. /audit-deps still owns that, with its
// approval gate intact.
//
// Fails open like every hook here. A dependency map that cannot be checked is
// a smaller problem than a session that cannot write a file.

'use strict';

const fs = require('fs');
const path = require('path');
const { readEvent, advise } = require('../scripts/hook-io.js');
const { DEPS_PATH, bump, entryByPath, extractRefs, unrecorded } = require('../scripts/deps-refs.js');

// The manifest matcher is `Write|Edit`, and that is an exact-string list, not a
// regex. A matcher built only from letters, digits, `_`, `-`, spaces, `,` and
// `|` is read as a list of exact names; anything carrying another character
// becomes an unanchored regex. So this hook is never handed a MultiEdit or a
// NotebookEdit, and the check below is agreement with the manifest rather than
// a second filter narrowing it.
//
// Worth writing down because the repository has been wrong about it before, in
// the other direction: a matcher here was once anchored to `^(Write|Edit)$` to
// close a gap the exact-string path had already closed, which made one manifest
// differ from every other for no gain. tests/hook-executable.test.js pins the
// form. If a MultiEdit ever needs stamping, the manifest is what has to change,
// and adding a tool name here alone would do nothing.
readEvent((event) => {
  if (event.tool_name !== 'Write' && event.tool_name !== 'Edit') return;

  const filePath = event.tool_input && event.tool_input.file_path;
  if (!filePath) return;
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.js' && ext !== '.md' && ext !== '.json') return;   // nothing else carries a reference this can read

  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return; }                          // the write did not land

  let deps;
  try { deps = JSON.parse(fs.readFileSync(DEPS_PATH, 'utf8')); }
  catch (_) { return; }                          // no map yet, so nothing to keep in step

  const hit = entryByPath(deps, filePath);
  if (!hit) return;                              // not something the map covers

  const refs = extractRefs(filePath, content);
  // null means nothing could be read from this file, which is not the same as
  // reading it and finding nothing new. Stamping here would mark the entry
  // confirmed without a single reference having been checked. Leave it
  // unstamped and say nothing.
  //
  // This used to say the entry "would never report drift again" and to leave it
  // drifted, which named the session brief's drift line. That line is gone as
  // of session 0.8.7. The reason to skip the stamp is unchanged and does not
  // depend on it: a file that could not be read has had nothing checked, so
  // recording it as confirmed is a false statement about work that never
  // happened, and /audit-deps compares `last_updated` rather than this field
  // when it decides what to look at.
  if (refs === null) return;

  const missing = unrecorded(deps, hit.entry, refs);

  if (missing.length === 0) {
    bump(hit.key, new Date().toISOString());
    return;
  }

  const names = missing.map((m) => m.id);
  advise('PostToolUse', [
    `deps-watch: ${hit.key} now calls ${names.length === 1 ? 'something' : `${names.length} things`} `
    + `the dependency map does not record: ${names.join(', ')}.`,
    'Run /audit-deps to add the edge, or say why it is not one.',
    'Until it is recorded, a fix to '
    + `${names.length === 1 ? 'that' : 'any of those'} will not flag ${hit.entry.target || hit.key} for review.`,
  ].join(' '));
});
