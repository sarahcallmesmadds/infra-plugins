#!/usr/bin/env node
// Regression tests for the bash guard as Claude Code actually runs it.
//
// Run: node tests/bash-guard.test.js
//
// command.test.js covers the verdicts by importing checkCommand directly, and
// every one of them passed while the guard blocked nothing at all. The verdict
// was right; the JSON carrying it was a shape PreToolUse ignores. So these
// tests spawn hooks/bash-guard.js as a subprocess, feed it a real hook event on
// stdin, and assert on the bytes it writes back. That is the only layer where
// the 0.2.0 bug was visible.
//
// HOME is redirected to an empty directory so the assertions describe the
// shipped defaults rather than whatever config the machine running them has.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'plugins', 'guardrails', 'hooks', 'bash-guard.js');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-home-'));

// Runs the hook the way the harness does and returns its parsed stdout, or
// null when it stays quiet, which is how a hook says "no objection".
function runHook(command, cwd) {
  const event = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: event,
    encoding: 'utf8',
    cwd: cwd || __dirname,
    env: { ...process.env, HOME: FAKE_HOME },
  }).trim();
  return stdout ? JSON.parse(stdout) : null;
}

// A deny has to arrive in the one shape PreToolUse reads. Asserting the whole
// envelope rather than a substring is deliberate: the bug this pins was a
// well-formed JSON object with correct content under the wrong field names.
function assertDenies(out, what) {
  assert.ok(out, `${what}: hook wrote nothing, so the command would run`);
  assert.ok(
    !('decision' in out),
    `${what}: emitted a top-level "decision", which PreToolUse ignores in silence`
  );
  const specific = out.hookSpecificOutput;
  assert.ok(specific, `${what}: no hookSpecificOutput`);
  assert.strictEqual(specific.hookEventName, 'PreToolUse', `${what}: wrong hookEventName`);
  assert.strictEqual(specific.permissionDecision, 'deny', `${what}: did not deny`);
  assert.ok(
    typeof specific.permissionDecisionReason === 'string'
      && specific.permissionDecisionReason.length > 0,
    `${what}: denied without saying why`
  );
  return specific.permissionDecisionReason;
}

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- the three things the guard exists to stop ---------------------------

check('recursive force-delete is denied, in the shape PreToolUse reads', () => {
  const reason = assertDenies(runHook('rm -rf ~/live'), 'rm -rf ~/live');
  assert.ok(reason.includes('~/live'), `reason did not name the path: ${reason}`);
});

check('a delete inside a quoted bash -c is denied', () => {
  assertDenies(runHook('bash -c "rm -rf ~/live"'), 'bash -c "rm -rf ~/live"');
});

check('committing on a protected branch is denied', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const reason = assertDenies(
    runHook(`git -C ${repo} commit -m "wip"`),
    'commit on main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- and the half that matters just as much ------------------------------

check('an ordinary command is left alone', () => {
  assert.strictEqual(runHook('ls -la'), null, 'hook objected to ls -la');
});

check('a configured disposable path is left alone', () => {
  assert.strictEqual(runHook('rm -rf node_modules'), null, 'hook objected to node_modules');
});

check('a command that only mentions a delete is left alone', () => {
  assert.strictEqual(
    runHook('echo "run rm -rf later"'),
    null,
    'hook objected to a command that only quotes a delete'
  );
});

check('committing on a feature branch is left alone', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'some-feature', repo], { stdio: 'ignore' });
  assert.strictEqual(
    runHook(`git -C ${repo} commit -m "wip"`),
    null,
    'hook objected to a commit on a feature branch'
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

fs.rmSync(FAKE_HOME, { recursive: true, force: true });

console.log(`\n7 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
