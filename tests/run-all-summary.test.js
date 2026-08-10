#!/usr/bin/env node
// run-all.js must summarise a suite by what that suite reported, not by the
// last thing it happened to write to stderr.
//
// Run: node tests/run-all-summary.test.js
//
// The fault: the summary came from `stdout + stderr` concatenated, and stderr
// is appended after stdout, so one line on stderr became the summary of the
// whole suite. Two suites hit it. stale-branches reported "never-existed is not
// in this repository any more" and queue-count reported the text of a refusal
// it raises on purpose. Both lines are incidental output from checks that
// exercise an error path, so the suites testing error handling most carefully
// were the ones whose results were hidden.
//
// It also silently capped what a suite could say. stale-branches moved its
// skipped-check count into its final line precisely so a full run would show
// it, and a stray stderr line outranked it anyway.
//
// Driven rather than asserted on the source, because the question is what
// run-all prints, and a source check would pass on any rewrite that still
// mentioned stdout.

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN_ALL = path.join(__dirname, 'run-all.js');

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try { fn(); console.log(`  ok    ${what}`); }
  catch (e) { failed += 1; console.log(`  FAIL  ${what}\n        ${e.message}`); }
}

// A filter, so this spawns one suite rather than every suite including itself.
// `queue-count` is the probe on purpose: one of its checks asserts that an
// unknown list is refused, and the refusal it drives goes to stderr. That makes
// it a suite which genuinely writes to both streams, which is the whole case.
function runFiltered(filter) {
  const r = spawnSync(process.execPath, [RUN_ALL, filter], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

check('a suite that writes to stderr is still summarised by its own last stdout line', () => {
  const { out } = runFiltered('queue-count');
  const line = out.split('\n').find((l) => /queue-count\.test\.js/.test(l) && /PASS|FAIL/.test(l));
  assert.ok(line, `no result line for queue-count in:\n${out}`);
  assert.match(line, /checks, 0 failed/,
    'the summary is not the suite\'s own reported result');
  assert.ok(!/unknown list/.test(line),
    'a refusal the suite raises on purpose was shown as its summary, which is the bug this pins');
});

check('the filtered run still passes, so the probe is measuring a green suite', () => {
  const { code } = runFiltered('queue-count');
  assert.strictEqual(code, 0, 'the probe suite is failing, so this test proves nothing about summaries');
});

check('a suite reporting only on stdout is unaffected', () => {
  const { out } = runFiltered('resolution');
  const line = out.split('\n').find((l) => /resolution\.test\.js/.test(l) && /PASS|FAIL/.test(l));
  assert.ok(line, `no result line for resolution in:\n${out}`);
  assert.ok(!/\(no output\)/.test(line), 'a suite with ordinary output lost its summary');
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
