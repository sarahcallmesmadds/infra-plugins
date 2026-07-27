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

// Somewhere to stand that is definitely not a git repository. The home
// directory is the obvious choice and the wrong one: plenty of people keep
// their dotfiles in a repo at $HOME, and on those machines a test meaning "the
// hook is nowhere useful" would quietly start meaning something else.
const NOWHERE = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-nowhere-'));

// Runs the hook the way the harness does and returns its parsed stdout, or
// null when it stays quiet, which is how a hook says "no objection".
// `eventCwd` goes in the event, the way the harness reports where the command
// will run. `processCwd` is where the hook process itself is spawned. Keeping
// them separate is the whole point: they are frequently different, and the
// guard used to read only the second one.
function runHook(command, { eventCwd, processCwd } = {}) {
  const event = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    ...(eventCwd ? { cwd: eventCwd } : {}),
  });
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: event,
    encoding: 'utf8',
    cwd: processCwd || __dirname,
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

// --- the repository the guard reads ---------------------------------------
//
// A hook runs in its own process, spawned wherever the harness chose. That is
// not necessarily where the command will run, and the Bash tool keeps its
// working directory across calls, so `cd repo` in one call and a bare
// `git commit` in the next is ordinary. Only the event knows about the first
// call. These two pin that the event is what gets believed.

check('a bare commit is judged against the event cwd, not the hook process cwd', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const reason = assertDenies(
    // No `-C` and no `cd`, so the only clue to the repository is the event.
    // The hook process deliberately sits somewhere else entirely.
    runHook('git commit -m "wip"', { eventCwd: repo, processCwd: NOWHERE }),
    'bare commit with event cwd on main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('an explicit -C still wins over the event cwd', () => {
  // Precedence matters: the command says where it acts, and it overrides the
  // ambient directory. A feature branch named explicitly must not be blocked
  // just because the session happens to be sitting on main.
  const onMain = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  const onFeature = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', onMain], { stdio: 'ignore' });
  execFileSync('git', ['init', '-b', 'some-feature', onFeature], { stdio: 'ignore' });
  assert.strictEqual(
    runHook(`git -C ${onFeature} commit -m "wip"`, { eventCwd: onMain }),
    null,
    'hook read the event cwd instead of the -C path'
  );
  fs.rmSync(onMain, { recursive: true, force: true });
  fs.rmSync(onFeature, { recursive: true, force: true });
});

// The field name above is not a guess. `cwd` is a documented common field on
// every hook event, and it appears in the published PreToolUse example next to
// session_id, transcript_path, permission_mode and hook_event_name. This test
// feeds that whole documented event rather than the two fields the guard reads,
// so the assertion is against the contract as published and not against a
// convenient subset of it. If the harness ever renames the field, this is where
// it surfaces.
check('the guard reads the PreToolUse event exactly as documented', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const documented = JSON.stringify({
    session_id: 'abc123',
    transcript_path: '/home/user/.claude/projects/x/transcript.jsonl',
    cwd: repo,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "wip"', description: 'Commit' },
    tool_use_id: 'toolu_01ABC123',
  });
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: documented,
    encoding: 'utf8',
    cwd: NOWHERE,
    env: { ...process.env, HOME: FAKE_HOME },
  }).trim();
  const reason = assertDenies(stdout ? JSON.parse(stdout) : null, 'documented event');
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

// The fallback is deliberate, and it fails open. Worth being explicit about
// why, because the alternative looks safer and is not.
//
// If `cwd` ever went missing, hard-failing every commit would take the guard
// from "checks the wrong repo in one uncommon case" to "nobody can commit
// anything", for everyone, on a plugin whose whole job is to stay out of the
// way until it matters. Degrading to the process directory is what the guard
// did for its entire life before this change, so the floor here is the
// previous shipped behaviour rather than nothing at all.
check('a missing cwd degrades to the process directory rather than crashing', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  // No cwd in the event, hook process sitting in the repo. It should still
  // find main from where it stands, and it must not throw.
  const reason = assertDenies(
    runHook('git commit -m "wip"', { processCwd: repo }),
    'no cwd in event'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('a missing cwd outside any repository stays silent rather than erroring', () => {
  assert.strictEqual(
    runHook('git commit -m "wip"', { processCwd: NOWHERE }),
    null,
    'hook objected or crashed when it could not identify a repository'
  );
});

// --- paths written the way people write them ------------------------------
//
// `~` is expanded by the shell, so a path taken out of the command text still
// has it and there is nothing on disk by that name. The guard used to look,
// fail to find it, and allow the commit without a word. `cd ~/repo && git
// commit` is the ordinary way to write this, so whether the guard worked came
// down to how the path happened to be typed.
//
// HOME is FAKE_HOME for these, so `~` resolves there and nothing touches the
// real home directory.

function repoIn(dir, branch) {
  const repo = path.join(dir, `repo-${branch}`);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', branch, repo], { stdio: 'ignore' });
  return repo;
}

check('a tilde path after cd is expanded before the branch is read', () => {
  repoIn(FAKE_HOME, 'main');
  const reason = assertDenies(
    runHook('cd ~/repo-main && git commit -m "wip"', { processCwd: NOWHERE }),
    'cd ~/repo-main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
});

check('a tilde path after -C is expanded too', () => {
  repoIn(FAKE_HOME, 'main');
  assertDenies(
    runHook('git -C ~/repo-main commit -m "wip"', { processCwd: NOWHERE }),
    'git -C ~/repo-main'
  );
});

check('a tilde path on a feature branch is still left alone', () => {
  // The expansion must not turn into "block anything with a tilde in it".
  repoIn(FAKE_HOME, 'some-feature');
  assert.strictEqual(
    runHook('cd ~/repo-some-feature && git commit -m "wip"', { processCwd: NOWHERE }),
    null,
    'hook objected to a commit on a feature branch'
  );
});

// --- relative paths belong to the command, not to the hook -----------------
//
// `cd subdir && git commit` is ordinary. A relative path means relative to
// where the command runs, which is the event directory, never this process's
// own location. Resolving it against the hook points somewhere unrelated, so a
// repository that is right there looks missing. Before the unresolved check
// existed that only meant a silent miss; with it, the same mistake turns into
// an interruption on a commit that was fine, which is worse.

check('a relative path is resolved against the event directory', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-parent-'));
  execFileSync('git', ['init', '-b', 'main', path.join(parent, 'sub')], { stdio: 'ignore' });
  const reason = assertDenies(
    runHook('cd sub && git commit -m "wip"', { eventCwd: parent, processCwd: NOWHERE }),
    'cd sub'
  );
  assert.ok(
    reason.includes('main'),
    `expected the branch name, got a different refusal: ${reason}`
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

check('a relative path on a feature branch is left alone', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-parent-'));
  execFileSync('git', ['init', '-b', 'some-feature', path.join(parent, 'sub')], { stdio: 'ignore' });
  assert.strictEqual(
    runHook('cd sub && git commit -m "wip"', { eventCwd: parent, processCwd: NOWHERE }),
    null,
    'hook objected to a commit on a feature branch reached by a relative path'
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

check('a relative path with .. is resolved too', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-parent-'));
  execFileSync('git', ['init', '-b', 'main', path.join(parent, 'sub')], { stdio: 'ignore' });
  fs.mkdirSync(path.join(parent, 'other'));
  const reason = assertDenies(
    runHook('cd ../sub && git commit -m "wip"', {
      eventCwd: path.join(parent, 'other'),
      processCwd: NOWHERE,
    }),
    'cd ../sub'
  );
  // Asserting on the reason, not just on the deny. Resolved against the wrong
  // base this path does not exist either, so it gets refused as unresolvable
  // and a test that only checked "denied" would pass on the broken code.
  assert.ok(
    reason.includes('main'),
    `expected the branch name, got the cannot-find refusal instead: ${reason}`
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

// --- when the guard cannot tell, it says so --------------------------------

check('a named directory that does not exist is refused rather than waved through', () => {
  // A shell variable is the usual cause. The shell expands it and the guard
  // only ever sees the text, so there is no way to know which branch this
  // would land on.
  const reason = assertDenies(
    runHook('cd $REPO && git commit -m "wip"', { processCwd: NOWHERE }),
    'cd $REPO'
  );
  assert.ok(reason.includes('$REPO'), `reason did not name the path: ${reason}`);
});

check('a directory that exists but is not a repository is left alone', () => {
  // `git commit` fails on its own here, so there is nothing to protect and an
  // interruption would be pure noise.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-plain-'));
  assert.strictEqual(
    runHook(`cd ${plain} && git commit -m "wip"`, { processCwd: NOWHERE }),
    null,
    'hook objected in a directory that is not a repository'
  );
  fs.rmSync(plain, { recursive: true, force: true });
});

check('a detached HEAD is left alone rather than treated as unresolvable', () => {
  // symbolic-ref fails on a detached HEAD in a perfectly valid repository
  // doing perfectly normal work. That is not the guard being unable to tell.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'base'], { stdio: 'ignore' });
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'checkout', sha], { stdio: 'ignore' });
  assert.strictEqual(
    runHook(`git -C ${repo} commit -m "wip"`, { processCwd: NOWHERE }),
    null,
    'hook treated a detached HEAD as a path it could not resolve'
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- disposable paths spelled either way ----------------------------------

check('/private/tmp is as disposable as /tmp, being the same directory', () => {
  // On macOS /tmp is a symlink to /private/tmp. Anything that reports a real
  // path rather than the symlink produced the blocked spelling every time, so
  // the guard fired constantly on genuinely throwaway directories, which is
  // how a guard teaches people to click through it.
  assert.strictEqual(
    runHook('rm -rf /tmp/scratch-dir'),
    null,
    'hook objected to /tmp, which was already meant to be allowed'
  );
  assert.strictEqual(
    runHook('rm -rf /private/tmp/scratch-dir'),
    null,
    'hook objected to /private/tmp while allowing the identical /tmp path'
  );
});

check('a real path outside the disposable list is still denied', () => {
  // The pair above widens one directory. It must not have widened the prefix.
  assertDenies(runHook('rm -rf /private/etc/something'), '/private/etc/something');
});

fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.rmSync(NOWHERE, { recursive: true, force: true });

console.log(`\n23 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
