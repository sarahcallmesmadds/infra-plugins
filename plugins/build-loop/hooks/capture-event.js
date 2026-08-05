#!/usr/bin/env node
// Records the SHAPE of a real hook event, so a test has something to check
// against that nobody in this repository made up.
//
// Why this exists rather than a fixture somebody wrote:
//
// guardrails blocked nothing for its entire life because its hooks emitted a
// top-level `decision` key that PreToolUse does not read. Claude Code ignores
// an unrecognised shape with exit 0 and no message, so every guard reached the
// right verdict, printed it, and watched the command run anyway.
//
// A test harness cannot catch that on its own. A harness written by the author
// of the hooks drives them with the payload that author BELIEVES arrives, and
// if the belief is wrong then hook and harness are wrong the same way, the
// harness passes, and the hook still does nothing. The only thing that breaks
// the shared assumption is an event that actually came from Claude Code.
//
// ---------------------------------------------------------------------------
// What gets written, and what deliberately does not.
//
// Keys only. Every leaf value is replaced by the name of its type before
// anything is written, so `{"command": "rm -rf /tmp/x"}` is recorded as
// `{"command": "string"}`.
//
// That is not caution for its own sake. A real PreToolUse event on Bash carries
// the command being run, and a real Write event carries the entire file being
// written. This repository is public. Recording values would put whatever was
// on screen at capture time into a fixture and then into a commit, and the
// checks that read this file only ever ask which keys exist.
//
// ---------------------------------------------------------------------------
// Not wired into hooks.json, on purpose.
//
// It would have to run on PreToolUse and PostToolUse to capture them, and those
// fire on every single tool call. A node process is tens of milliseconds of
// spawn, and paying that forever to re-learn a shape that changes about once a
// release is a bad trade.
//
// Capturing is a deliberate act instead. `tests/hook-event-shape.test.js`
// prints the exact settings.json block when a shape is missing. Wire it, start
// one session, use it normally, then take it out again and commit what landed
// in tests/fixtures/hook-events/.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = path.join(os.homedir(), '.claude', 'build-loop', 'hook-events');

// Deep enough to reach the fields hooks actually read, which bottom out at
// event.tool_input.file_path and event.tool_response.filePath. Past that it is
// recording the internals of somebody else's payload for no one's benefit, and
// a deeply nested tool_response would make the file large enough that nobody
// reads the diff when it changes.
const MAX_DEPTH = 4;

function shapeOf(value, depth) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return 'array';
    // The first element only. An array here is a list of like things, and
    // recording twenty of them says nothing the first one did not.
    return value.length ? [shapeOf(value[0], depth + 1)] : [];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = shapeOf(value[k], depth + 1);
    return out;
  }
  return typeof value;
}

function main(raw) {
  const event = JSON.parse(raw);

  // Claude Code names the event on the payload itself. Falling back to a guess
  // would file a shape under the wrong event, which is worse than not filing
  // it: the test would then check hooks against a shape from somewhere else and
  // report a clean pass.
  const name = event && event.hook_event_name;
  if (typeof name !== 'string' || !/^[A-Za-z]+$/.test(name)) return;

  const target = path.join(OUT_DIR, `${name}.json`);

  // One capture per event type. A second session should cost a stat and
  // nothing else, and re-capturing would rewrite the file with whatever
  // happened to be in flight rather than adding anything.
  if (fs.existsSync(target)) return;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // `source` is the provenance stamp, and the test refuses any file without
  // it. That is the whole guarantee: a shape somebody typed by hand looks
  // exactly like a captured one otherwise, and a hand-typed shape is the belief
  // this file exists to stop being treated as evidence.
  fs.writeFileSync(target, `${JSON.stringify({
    source: 'capture-event.js',
    hook_event_name: name,
    captured_at: new Date().toISOString(),
    keys_only: true,
    shape: shapeOf(event, 0),
  }, null, 2)}\n`);
}

let buffer = '';
const timer = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buffer += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    main(buffer);
  } catch (_) {
    // A capture is a convenience. Never turn a failure here into a failed tool
    // call, which is the rule every other hook in this repository follows.
  }
  process.exit(0);
});
