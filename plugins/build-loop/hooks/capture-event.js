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

// Written to a temporary name and renamed into place. `existsSync` then
// `writeFileSync` is not atomic, and a session runs tool calls in parallel, so
// two hooks can both pass the existence test and write the same file. The
// content is derived from the shape either way so the result is not wrong, but
// the second writer can tear the first, and a torn file is dropped as
// unparseable and then reported as "no captured shape", which points at the
// wrong problem entirely. Rename is atomic on the same filesystem.
function writeOnce(target, body) {
  if (fs.existsSync(target)) return;
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, target);
  } catch (_) {
    fs.unlinkSync(tmp);
  }
}

function main(raw) {
  const event = JSON.parse(raw);

  // Claude Code names the event on the payload itself. Falling back to a guess
  // would file a shape under the wrong event, which is worse than not filing
  // it: the test would then check hooks against a shape from somewhere else and
  // report a clean pass.
  const name = event && event.hook_event_name;
  if (typeof name !== 'string' || !/^[A-Za-z]+$/.test(name)) return;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const stamp = (extra) => `${JSON.stringify(Object.assign({
    // The provenance stamp, and the whole reason a capture is worth more than a
    // fixture somebody typed. The test refuses any file without it, because a
    // hand-typed shape is indistinguishable from a captured one once it is on
    // disk, and belief is the thing this file exists to stop being evidence.
    source: 'capture-event.js',
    hook_event_name: name,
    captured_at: new Date().toISOString(),
    keys_only: true,
  }, extra), null, 2)}\n`;

  // The envelope: the fields every event of this type carries whatever tool
  // triggered it. One per event type, because a second one would say the same
  // thing.
  writeOnce(path.join(OUT_DIR, `${name}.json`), stamp({ shape: shapeOf(event, 0) }));

  // And one per tool, because `tool_input` and `tool_response` are not part of
  // the envelope. They hold whatever that tool carries: `command` for Bash,
  // `file_path` for Write, `page_id` for a Notion call. A single capture per
  // event says nothing about a hook that reads `tool_input.file_path` unless
  // the capture happened to land on a Write, which is a coin toss, and a coin
  // toss reported as a defect is worse than no check.
  //
  // So the payload is filed under the tool it came from, and the check matches
  // it against the matcher the hook is wired to.
  const tool = event.tool_name;
  if (typeof tool !== 'string' || !/^[\w.-]+$/.test(tool)) return;
  writeOnce(path.join(OUT_DIR, `${name}.${tool}.json`), stamp({
    tool_name: tool,
    shape: shapeOf({ tool_input: event.tool_input, tool_response: event.tool_response }, 0),
  }));
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
