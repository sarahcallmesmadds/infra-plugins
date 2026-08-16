#!/usr/bin/env node
// deps-watch.js — PostToolUse hook on Write and Edit.
//
// Keeps DEPS.json honest without anybody remembering to. When a mapped file is
// edited, this reads what the file now calls and compares it to what the map
// records. Two outcomes and nothing in between:
//
//   nothing new appeared   Nothing happens. This is the common case, and
//                          silence is the whole point: ordinary edits should
//                          cost nothing and say nothing.
//
//   something new appeared The file calls a mapped target with no recorded
//                          edge. That is the case where /flag-issue would miss
//                          a dependent, so it is said out loud in the
//                          conversation, where somebody can act on it.
//
// READ-ONLY. This hook never writes DEPS.json, and there is no path through it
// that does. It used to stamp `last_auto_checked` on the quiet branch, taking a
// lock and rewriting the map on every ordinary save; that field had no reader
// once session 0.8.7 removed the session brief's drift line, so the stamp and
// its lock came out on 2026-08-15. Queue entry 2026-08-15T19-17-34-deps-watch
// carries the decision, and deps-refs.js carries the longer note.
//
// The consequence worth knowing: a mapped file can now be edited any number of
// times without the map recording that anything looked at it. That is correct
// here. The map's review date means a person or /audit-deps judged the edges,
// and this hook does neither. It reads what a file mechanically calls, which
// cannot see one thing reading a file another writes, so it was never evidence
// of review in the first place.
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
const { DEPS_PATH, entryByPath, extractRefs, unrecorded } = require('../scripts/deps-refs.js');

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
// form. If a MultiEdit ever needs checking, the manifest is what has to change,
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
  // reading it and finding nothing new. The two used to be worth separating
  // because one of them stamped the entry and the other did not. Now that
  // nothing is written either way, the distinction survives only as a reason
  // not to warn: an unreadable file has no missing edges to report, and
  // claiming otherwise would name edges nobody checked for.
  if (refs === null) return;

  const missing = unrecorded(deps, hit.entry, refs);

  if (missing.length === 0) return;

  const names = missing.map((m) => m.id);
  advise('PostToolUse', [
    `deps-watch: ${hit.key} now calls ${names.length === 1 ? 'something' : `${names.length} things`} `
    + `the dependency map does not record: ${names.join(', ')}.`,
    'Run /audit-deps to add the edge, or say why it is not one.',
    'Until it is recorded, a fix to '
    + `${names.length === 1 ? 'that' : 'any of those'} will not flag ${hit.entry.target || hit.key} for review.`,
  ].join(' '));
});
