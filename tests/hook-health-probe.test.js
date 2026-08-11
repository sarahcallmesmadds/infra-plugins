#!/usr/bin/env node
// The probe that says which hook interpreter went missing.
//
// Run: node tests/hook-health-probe.test.js
//
// Written after the 2026-08-07 UserPromptSubmit entry, which recorded that a
// hook failed with exit code 127 and not which hook. Two commands run on that
// event on this machine, either can 127, Claude Code writes no UserPromptSubmit
// hook runs to the transcript, and the session that filed the report left none
// either. Identifying it four days later took a whole session and still stopped
// short of proof.
//
// This suite runs the probe rather than reading it. That distinction is the one
// hook-executable.test.js was written about: a hook tested by a route the shell
// never takes is a hook nobody has tested. Every case below drives it the way
// Claude Code does, through its shebang with an event on stdin, and asserts on
// the file it leaves behind.
//
// The environment is stripped with env -i for the failure cases. That is the
// whole point: `node` is on PATH here through a shell profile, so the only
// honest way to test "node is missing" is to take it away.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'plugins', 'build-loop', 'hooks', 'hook-health-probe.sh');

const EXPECTED_CHECKS = 9;

let failed = 0;
let ran = 0;
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

const EVENT = JSON.stringify({
  session_id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
  transcript_path: '/dev/null',
  cwd: '/tmp',
  hook_event_name: 'UserPromptSubmit',
  prompt: 'anything',
});

// A HOME per case, so one case cannot read another's log. The probe writes to
// $HOME/.claude/build-loop/hook-health.log and nothing else.
function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
}

function logPath(home) {
  return path.join(home, '.claude', 'build-loop', 'hook-health.log');
}

function readLog(home) {
  const p = logPath(home);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Drive the probe exactly as a shell would: execute the file, let the shebang
// pick the interpreter, hand it the event on stdin. `env` builds the whole
// environment from scratch so a PATH inherited from this process cannot quietly
// rescue a case that is meant to fail.
function runProbe(home, { withNode, env = {} } = {}) {
  const parts = ['-i', `HOME=${home}`];
  // /usr/bin and /bin hold sh, sed, date, grep, tail. Never node on this
  // machine: it lives under ~/.local/bin, which is what makes the negative
  // case meaningful rather than contrived.
  parts.push(withNode
    ? `PATH=${path.dirname(process.execPath)}:/usr/bin:/bin`
    : 'PATH=/usr/bin:/bin');
  for (const [k, v] of Object.entries(env)) parts.push(`${k}=${v}`);
  parts.push(PROBE);
  return spawnSync('env', parts, { input: EVENT, encoding: 'utf8' });
}

// --- the interpreter it cannot report on itself ----------------------------

check('the probe is not written in node', () => {
  // A node script cannot tell you node is missing. If this file is ever
  // rewritten in the language of the thing it watches, it stops working in the
  // only situation it was built for, and every test still passes.
  const shebang = fs.readFileSync(PROBE, 'utf8').split('\n')[0];
  assert.ok(
    /^#!\/bin\/sh$/.test(shebang),
    `the probe's shebang is "${shebang}". It has to be /bin/sh: it exists to `
    + 'report a missing interpreter, so it cannot depend on one that can go '
    + 'missing.'
  );
});

check('the probe is executable, in the index and on disk', () => {
  // Same contract hook-executable.test.js enforces. Restated here because a
  // .sh hook is the first of its kind in this repository and the walker there
  // has only ever seen .js files.
  fs.accessSync(PROBE, fs.constants.X_OK);
  const mode = execFileSync('git', ['ls-files', '-s', '--', PROBE], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(
    mode.startsWith('100755'),
    `the probe is mode ${mode.slice(0, 6)} in the git index, so a fresh clone `
    + 'cannot run it'
  );
});

check('hooks.json runs it on UserPromptSubmit', () => {
  const hooks = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'plugins', 'build-loop', 'hooks', 'hooks.json'), 'utf8')
  );
  const ups = JSON.stringify(hooks.hooks.UserPromptSubmit || []);
  assert.ok(
    ups.includes('hook-health-probe.sh'),
    'the probe is not registered on UserPromptSubmit, which is the event whose '
    + 'failures leave no transcript record'
  );
  assert.ok(
    ups.includes('notice-correction.js'),
    'the probe replaced notice-correction.js rather than running beside it'
  );
});

// --- it catches the thing it was built for ---------------------------------

check('a missing node is recorded', () => {
  const home = sandbox();
  const r = runProbe(home, { withNode: false });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}, it must never fail a prompt`);
  const log = readLog(home);
  assert.ok(log.includes('MISSING'), `nothing was recorded. log: ${JSON.stringify(log)}`);
  assert.ok(log.includes('node'), `the log does not name node. log: ${JSON.stringify(log)}`);
});

check('a working environment records nothing', () => {
  const home = sandbox();
  const r = runProbe(home, { withNode: true });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(
    readLog(home), '',
    'the probe wrote a line while everything was fine, which is how a log stops '
    + 'being read'
  );
});

check('a stale cmux binary path is recorded', () => {
  // The specific shape an app update leaves behind: an absolute path exported
  // at launch that no longer resolves. cmux hooks 127 on every prompt until
  // the session restarts.
  const home = sandbox();
  const r = runProbe(home, {
    withNode: true,
    env: { CMUX_CLAUDE_HOOK_CMUX_BIN: path.join(home, 'gone', 'cmux') },
  });
  assert.strictEqual(r.status, 0);
  const log = readLog(home);
  assert.ok(log.includes('cmux_bin=stale'), `the stale path was not recorded. log: ${JSON.stringify(log)}`);
});

check('cmux is not reported on a machine that does not run it', () => {
  // Without this the probe writes a line about missing software on every
  // prompt for every user who does not use cmux.
  const home = sandbox();
  runProbe(home, { withNode: true });
  assert.ok(
    !readLog(home).includes('cmux'),
    'cmux was reported absent with no sign the session is running inside it'
  );
});

// --- it stays readable -----------------------------------------------------

check('an unchanged state is not written twice', () => {
  // A line per prompt for the length of a broken session buries the transition
  // that matters under thousands of copies of itself.
  const home = sandbox();
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: false });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 1,
    `three identical states produced ${lines.length} lines:\n        ` + lines.join('\n        ')
  );
});

check('a recovery is recorded once', () => {
  const home = sandbox();
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: true });
  runProbe(home, { withNode: true });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 2,
    `expected one failure and one recovery, got ${lines.length}:\n        ` + lines.join('\n        ')
  );
  assert.ok(lines[0].includes('MISSING'), 'the first line is not the failure');
  assert.ok(lines[1].includes('RECOVERED'), 'the recovery was not recorded');
});

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + `check, move EXPECTED_CHECKS. If you did not, one has gone missing.`
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
