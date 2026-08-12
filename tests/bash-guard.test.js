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
function runHook(command, { eventCwd, processCwd, permissionMode = 'default' } = {}) {
  const event = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    ...(eventCwd ? { cwd: eventCwd } : {}),
    // Real Claude Code events carry the field, so ordinary tests use `default`.
    // Passing null is the explicit degraded-harness case that omits it.
    ...(permissionMode !== null ? { permission_mode: permissionMode } : {}),
  });
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: event,
    encoding: 'utf8',
    cwd: processCwd || __dirname,
    env: { ...process.env, HOME: FAKE_HOME },
  }).trim();
  return stdout ? JSON.parse(stdout) : null;
}

// A decision has to arrive in the one shape PreToolUse reads. Asserting the
// whole envelope rather than a substring is deliberate: the bug this pins was a
// well-formed JSON object with correct content under the wrong field names.
//
// Which decision it is matters as much as its shape, so the two have separate
// helpers below rather than one taking a flag. A rule that prompts and a rule
// that refuses are different promises to the user, and a test that accepts
// either cannot tell you which one a change just turned the other into.
function assertDecides(out, what, decision) {
  assert.ok(out, `${what}: hook wrote nothing, so the command would run`);
  assert.ok(
    !('decision' in out),
    `${what}: emitted a top-level "decision", which PreToolUse ignores in silence`
  );
  const specific = out.hookSpecificOutput;
  assert.ok(specific, `${what}: no hookSpecificOutput`);
  assert.strictEqual(specific.hookEventName, 'PreToolUse', `${what}: wrong hookEventName`);
  assert.strictEqual(
    specific.permissionDecision,
    decision,
    `${what}: expected ${decision}, got ${specific.permissionDecision}`
  );
  assert.ok(
    typeof specific.permissionDecisionReason === 'string'
      && specific.permissionDecisionReason.length > 0,
    `${what}: decided without saying why`
  );
  return specific.permissionDecisionReason;
}

// The guard knows a better command and names it, so there is nothing to weigh.
// Protected branches and commit message format are the only two.
function assertDenies(out, what) {
  return assertDecides(out, what, 'deny');
}

// The guard knows what the command does and not whether it is wanted, so the
// user is asked. Every destructive rule and the commit-hook-skip rule land
// here. These arrived as `deny` until 0.5.1, which made a reason ending in
// "confirm this is intended before running it" impossible to confirm, and left
// running the command by hand outside the session as the only way through.
function assertAsks(out, what) {
  return assertDecides(out, what, 'ask');
}

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

// Every fixture repository here gets a commit, so that these describe a repo
// somebody is actually working in rather than the output of `git init`. That
// distinction is not load-bearing for the guard, which reads the branch name
// and nothing else, and the two tests further down cover the empty case
// directly. It is here because a fixture that matches reality is the one that
// keeps being right when the code around it changes.
function initRepo(dir, branch) {
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.t'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'base'], { stdio: 'ignore' });
}

// --- the three things the guard exists to stop ---------------------------

check('recursive force-delete is put to the user, in the shape PreToolUse reads', () => {
  const reason = assertAsks(runHook('rm -rf ~/live'), 'rm -rf ~/live');
  assert.ok(reason.includes('~/live'), `reason did not name the path: ${reason}`);
});

check('a delete inside a quoted bash -c is put to the user', () => {
  assertAsks(runHook('bash -c "rm -rf ~/live"'), 'bash -c "rm -rf ~/live"');
});

check('committing on a protected branch is denied', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'main');
  const reason = assertDenies(
    runHook(`git -C ${repo} commit -m "wip"`),
    'commit on main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- the reason text has to be answerable --------------------------------
//
// `git branch -D` had no coverage at this layer, and it is the command that
// exposed the defect. On 2026-08-11 a branch already confirmed merged could not
// be deleted through the tool at all: the guard said "confirm this is intended
// before running it", arrived as a `deny`, and the only way past it was to
// leave the session and run it by hand. Approving it twice in conversation
// changed nothing, because a deny has nowhere to put an approval.
//
// So this asserts the pairing rather than the decision alone. A reason that
// asks for confirmation and a decision that cannot accept one is the bug, and
// either half on its own looks correct.
check('a command whose reason asks for confirmation is answerable', () => {
  const reason = assertAsks(
    runHook('git branch -D some-merged-branch'),
    'git branch -D'
  );
  assert.ok(
    /confirm this is intended/i.test(reason),
    `reason no longer asks for confirmation, so this test is pinning the wrong thing: ${reason}`
  );
});

// The mirror of it. These two know the better command and print it, so there is
// nothing for the user to weigh and a prompt would be noise. If a later change
// makes every verdict a prompt, this is what fails.
check('a rule that names the better command still denies', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'main');
  const reason = assertDenies(
    runHook(`git -C ${repo} commit -m "wip"`),
    'commit on main'
  );
  assert.ok(
    reason.includes('git checkout -b'),
    `a deny has to name the way forward: ${reason}`
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- one command, two rules, one decision --------------------------------
//
// A hook emits a single decision, so whichever rule speaks first is the whole
// answer. While every verdict was a `deny` that was invisible: the command was
// stopped whichever rule got there first. Introducing `ask` made the order
// load-bearing, and the first version of it asked at the point of assessment,
// before the protected-branch rule ran at all.
//
// The effect was that adding `--no-verify` to a commit on main downgraded the
// strongest rule in the plugin to a prompt, and one approval put a commit
// straight on the protected branch. The same held for any line combining a
// delete with a commit. Caught in review on #98 rather than by these tests,
// which had no case where two rules fired on one command.
check('a refusal is not downgraded by a question on the same command', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'main');

  // Each of these trips a rule that asks and a rule that refuses. The refusal
  // has to win every time, whichever one the code happens to assess first.
  for (const command of [
    `git -C ${repo} commit --no-verify -m "wip"`,
    `git -C ${repo} commit -n -m "wip"`,
    `rm -rf ~/live && git -C ${repo} commit -m "wip"`,
  ]) {
    const reason = assertDenies(runHook(command), command);
    assert.ok(
      reason.includes('protected branch'),
      `the deny has to be the branch rule, not something weaker: ${reason}`
    );
  }

  fs.rmSync(repo, { recursive: true, force: true });
});

check('the same commands still ask once nothing refuses them', () => {
  // The control. Off the protected branch there is no refusal to lose, so these
  // are questions again. Without this the test above passes just as well
  // against a hook that denies everything, which is what this replaced.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'some-feature');

  for (const command of [
    `git -C ${repo} commit --no-verify -m "wip"`,
    `git -C ${repo} commit -n -m "wip"`,
  ]) {
    assertAsks(runHook(command), command);
  }

  fs.rmSync(repo, { recursive: true, force: true });
});

// --- asking needs somebody to ask ----------------------------------------
//
// `ask` is settled by whatever answers permission prompts, and in an
// unattended run that is not a person. A guard that prompts there has the form
// of a check and none of the effect, which is worse than either real answer,
// because the transcript still reads as though something was considered.
//
// So the decision follows who is listening. This was raised in review as
// documented-but-unsettled, and documenting it was not enough: the event says
// which mode it is in, so the hook can stop guessing.
check('every unattended refusal is actionable and names its own switch', () => {
  for (const mode of ['bypassPermissions', 'dontAsk', 'auto', 'somethingNewer']) {
    for (const [command, setting] of [
      ['rm -rf ~/live', 'blockDestructiveCommands'],
      ['git clean -fd', 'blockDestructiveCommands'],
      ['git push --force origin feature', 'blockDestructiveCommands'],
      ['git branch -D unmerged', 'blockDestructiveCommands'],
      ['git reset --hard HEAD~1', 'blockDestructiveCommands'],
      ['git commit --no-verify -m "x"', 'blockCommitHookSkip'],
    ]) {
      const reason = assertDenies(
        runHook(command, { permissionMode: mode }),
        `${command} in ${mode}`
      );
      assert.ok(reason.includes(mode), `the refusal has to name the mode: ${reason}`);
      assert.ok(
        !/confirm this is intended/i.test(reason),
        `a refusal must not ask for a confirmation nobody can give: ${reason}`
      );
      assert.ok(
        reason.includes(`${setting} to false`),
        `the refusal must name the switch for the rule that fired: ${reason}`
      );
    }
  }
});

check('a mode where somebody is watching still asks', () => {
  // The control, and the more important half. Denying in a mode that would
  // have prompted refuses a command somebody was standing there to approve,
  // which is the fault this whole release exists to fix.
  //
  for (const mode of ['default', 'plan', 'acceptEdits']) {
    assertAsks(runHook('rm -rf ~/live', { permissionMode: mode }), `rm -rf in ${mode}`);
  }
});

check('an event with no permission mode fails closed', () => {
  const reason = assertDenies(
    runHook('rm -rf ~/live', { permissionMode: null }),
    'no permission_mode'
  );
  assert.ok(reason.includes('(missing)'), `the refusal has to name the missing mode: ${reason}`);
});

check('an unattended run does not turn ordinary commands into refusals', () => {
  assert.strictEqual(
    runHook('ls -la', { permissionMode: 'bypassPermissions' }),
    null,
    'the mode changes which answer a flagged command gets, not what counts as flagged'
  );
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
  initRepo(repo, 'some-feature');
  assert.strictEqual(
    runHook(`git -C ${repo} commit -m "wip"`),
    null,
    'hook objected to a commit on a feature branch'
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- the exception that should not exist ----------------------------------
//
// For one day this guard waved through any commit in a repository with no
// history, on the grounds that such a repository cannot be branched and its
// first commit is therefore necessarily on main. That is false, and the pair
// below is what proves it rather than argues it.
//
// The effect of the exception was the worst possible one. The first commit is
// what establishes main as the branch everybody then keeps committing to, so
// the guard was off for precisely the commit that matters most.

check('git can branch a repository that has no commits, so the advice works', () => {
  // Pins the premise the guard's message rests on. If git ever stopped
  // allowing this, "branch first, then commit" would become advice nobody can
  // follow, and that should surface here rather than in somebody's terminal.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'checkout', '-b', 'feature'], { stdio: 'ignore' });
  const now = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.strictEqual(now, 'feature', 'checkout -b did not move an unborn HEAD');
  fs.rmSync(repo, { recursive: true, force: true });
});

check('the first commit of a brand new repository is still denied', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const reason = assertDenies(
    runHook(`git -C ${repo} commit -m "first"`),
    'first commit on main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

// --- skipping the commit hooks --------------------------------------------

check('committing with --no-verify is put to the user', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'some-feature');
  const reason = assertAsks(
    runHook(`git -C ${repo} commit --no-verify -m "wip"`),
    'commit --no-verify'
  );
  // On a feature branch, so the protected-branch rule is not what fired. A
  // test that only asserted "denied" would pass on either.
  assert.ok(
    reason.includes('no-verify'),
    `something else denied this, not the hook-skipping rule: ${reason}`
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

check('the short form -n is put to the user too', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'some-feature');
  const reason = assertAsks(
    runHook(`git -C ${repo} commit -n -m "wip"`),
    'commit -n'
  );
  assert.ok(reason.includes('no-verify'), `wrong rule fired: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

// The dry run, in the spellings people actually use. `-n` alone is not one of
// them: a preview is only useful when it names what it would remove, and those
// letters are the destructive ones, so every real spelling of "show me first"
// was refused. Pinning only the bare form, which is what this test did at
// first, left the whole gap invisible.
for (const command of ['git clean -n', 'git clean -nd', 'git clean -ndx', 'git clean --dry-run -d']) {
  check(`a dry run is left alone: ${command}`, () => {
    assert.strictEqual(runHook(command), null, 'hook objected to a preview');
  });
}

check('git clean -fd, which really does delete, still prompts', () => {
  assertAsks(runHook('git clean -fd'), 'git clean -fd');
});

// --- the switches, at the layer that owns them ----------------------------
//
// The rules above are checked against checkCommand directly. These go through
// the hook with a real config file, because the hook is the thing being turned
// off and the arrangement has been wrong twice: once with both families
// sharing a switch, once with the switch reaching into the advisory that
// cli.js and the Codex surface depend on.

function hookWithConfig(settings, command) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'guardrails.config.json'),
    JSON.stringify(settings)
  );
  const stdout = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      permission_mode: 'default',
    }),
    encoding: 'utf8',
    cwd: NOWHERE,
    env: { ...process.env, HOME: home },
  }).trim();
  fs.rmSync(home, { recursive: true, force: true });
  return stdout ? JSON.parse(stdout) : null;
}

check('turning off delete prompts leaves the commit-hook rule running', () => {
  const off = { blockDestructiveCommands: false };
  assert.strictEqual(hookWithConfig(off, 'rm -rf ~/live'), null, 'the delete was still blocked');
  assertAsks(
    hookWithConfig(off, 'git commit --no-verify -m "x"'),
    'no-verify with deletes off'
  );
});

check('turning off the commit-hook rule leaves delete prompts running', () => {
  const off = { blockCommitHookSkip: false };
  assert.strictEqual(
    hookWithConfig(off, 'git commit --no-verify -m "x"'),
    null,
    'the commit was still blocked'
  );
  assertAsks(hookWithConfig(off, 'rm -rf ~/live'), 'delete with the commit rule off');
});

check('the on-demand check answers honestly with the prompts turned off', () => {
  // The question people ask deliberately, and the only protection at all on a
  // surface that cannot register hooks. It must not agree with the config.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'guardrails.config.json'),
    JSON.stringify({ blockDestructiveCommands: false })
  );
  const cli = path.join(__dirname, '..', 'plugins', 'guardrails', 'scripts', 'cli.js');
  const out = execFileSync(process.execPath, [cli, 'check', '--command', 'rm -rf ~/live'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.ok(
    out.includes('verdict: confirm'),
    `asked plainly whether a delete was safe, it said: ${out.trim()}`
  );
});

check('a commit run under another program is left alone', () => {
  // `nice -n 10` is not the commit asking to skip anything.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'some-feature');
  assert.strictEqual(
    runHook(`nice -n 10 git -C ${repo} commit -m "wip"`),
    null,
    'hook read another program\'s flag as the commit\'s'
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
  initRepo(repo, 'main');
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
  initRepo(onMain, 'main');
  initRepo(onFeature, 'some-feature');
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
  initRepo(repo, 'main');
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
  initRepo(repo, 'main');
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
  initRepo(repo, branch);
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
  initRepo(path.join(parent, 'sub'), 'main');
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
  initRepo(path.join(parent, 'sub'), 'some-feature');
  assert.strictEqual(
    runHook('cd sub && git commit -m "wip"', { eventCwd: parent, processCwd: NOWHERE }),
    null,
    'hook objected to a commit on a feature branch reached by a relative path'
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

check('a relative path with .. is resolved too', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-parent-'));
  initRepo(path.join(parent, 'sub'), 'main');
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

// --- a path only the shell can resolve ------------------------------------
//
// The text after `cd` is often something this hook cannot turn into a path:
// `$REPO`, `"$(git rev-parse --show-toplevel)"`, or a directory created
// earlier on the same line. Refusing those was tried and it stopped real work,
// while telling people to write out a path that is computed. The fallback is
// the directory the command runs in, which answers the common shapes correctly
// rather than as a consolation.

check('a command substitution falls back to the directory the command runs in', () => {
  // `$(git rev-parse --show-toplevel)` IS the repository already in play, so
  // reading the event directory answers it exactly rather than approximately.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'main');
  const reason = assertDenies(
    runHook('cd "$(git rev-parse --show-toplevel)" && git commit -m "wip"', {
      eventCwd: repo,
      processCwd: NOWHERE,
    }),
    'cd "$(...)"'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('a shell variable falls back the same way', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-repo-'));
  initRepo(repo, 'main');
  const reason = assertDenies(
    runHook('cd $REPO && git commit -m "wip"', { eventCwd: repo, processCwd: NOWHERE }),
    'cd $REPO'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(repo, { recursive: true, force: true });
});

check('a directory created earlier in the same line is not refused', () => {
  // `git clone x r && cd r && git commit`. `r` does not exist when this hook
  // looks, and a fresh clone has no branch worth protecting yet. The parent is
  // not a repository, so nothing fires and the work proceeds.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-parent-'));
  assert.strictEqual(
    runHook('git clone https://example.com/x r && cd r && git commit -m "wip"', {
      eventCwd: parent,
      processCwd: NOWHERE,
    }),
    null,
    'hook refused a commit into a directory the command itself creates'
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

check('cloning inside a repo on main and committing into the clone is stopped', () => {
  // The known cost of the fallback, pinned so it is a decision rather than a
  // surprise. The commit is aimed at the clone, but the clone does not exist
  // yet, so the answer comes from the outer repository, which is on main.
  //
  // Left as is on purpose. It errs toward interrupting rather than toward
  // missing, which is the right way round for a guard, and the alternative is
  // special-casing `git clone <url> <dir>` followed by `cd <dir>`, which is
  // more moving parts than the workflow is worth.
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-outer-'));
  initRepo(outer, 'main');
  const reason = assertDenies(
    runHook('git clone https://example.com/x r && cd r && git commit -m "wip"', {
      eventCwd: outer,
      processCwd: NOWHERE,
    }),
    'clone inside a repo on main'
  );
  assert.ok(reason.includes('main'), `reason did not name the branch: ${reason}`);
  fs.rmSync(outer, { recursive: true, force: true });
});

check('an unresolvable path outside any repository is left alone', () => {
  assert.strictEqual(
    runHook('cd $REPO && git commit -m "wip"', { eventCwd: NOWHERE, processCwd: NOWHERE }),
    null,
    'hook objected when neither the named path nor the fallback is a repository'
  );
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
  initRepo(repo, 'main');
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

check('a real path outside the disposable list still prompts', () => {
  // The pair above widens one directory. It must not have widened the prefix.
  assertAsks(runHook('rm -rf /private/etc/something'), '/private/etc/something');
});

check('build output is allowed, in any project and however it is spelled', () => {
  // These three shipped as `/dist/`, `/build/` and `/coverage/`. A leading
  // slash means one specific absolute location, so they matched no project
  // directory anywhere, and this hook turns a confirm verdict into a hard
  // deny. `rm -rf dist` was refused outright rather than prompted.
  for (const command of [
    'rm -rf dist',
    'rm -rf ./dist',
    'rm -rf build',
    'rm -rf coverage',
    'rm -rf /Users/someone/Projects/app/dist',
  ]) {
    assert.strictEqual(runHook(command), null, `hook denied ${command}`);
  }
});

check('a path that merely starts with a disposable name prompts', () => {
  // isDisposable used to allow any target beginning with an anchored entry,
  // with nothing checking that it ended at a segment boundary. The
  // /private/etc/something case above does not catch that: it diverges at a
  // slash and was denied under the broken code too. These do not.
  assertAsks(runHook('rm -rf /tmpfoo'), '/tmpfoo');
  assertAsks(runHook('rm -rf /private/tmp-backup'), '/private/tmp-backup');
  assertAsks(runHook('rm -rf /distributed-system'), '/distributed-system');
});

check('a disposable name that climbs back out prompts', () => {
  // Matching is on the path as typed, because the target of a delete often
  // does not exist yet, so there is nothing to resolve. That means a `..`
  // segment used to carry the verdict somewhere the text no longer described:
  // every one of these was allowed, and the last two are the whole filesystem
  // talking its way past the prompt on the strength of its first segment.
  assertAsks(runHook('rm -rf dist/../../important'), 'dist/../../important');
  assertAsks(runHook('rm -rf node_modules/../../important'), 'node_modules/../..');
  assertAsks(runHook('rm -rf ~/app/dist/../src'), '~/app/dist/../src');
  assertAsks(runHook('rm -rf /tmp/../etc'), '/tmp/../etc');
  assertAsks(runHook('rm -rf /private/tmp/../../Users'), '/private/tmp/../../Users');
});

check('a disposable name reached from a subdirectory is still allowed', () => {
  // The counterpart to the check above, and the reason a blanket refusal of
  // anything containing `..` is wrong. Here the `..` comes first and the last
  // segment is still the disposable directory, which is what someone working
  // in a subdirectory types to clear a sibling project. A confirm verdict
  // arrives as a deny, so getting this wrong refuses an ordinary command.
  for (const command of [
    'rm -rf ../node_modules',
    'rm -rf ../dist',
    'rm -rf ../../packages/app/dist',
  ]) {
    assert.strictEqual(runHook(command), null, `hook denied ${command}`);
  }
});

check('an alternative spelling of a root directory prompts too', () => {
  // The root-level guard compares text, so it has to compare tidied text.
  // `//build` and `/./build` name the same directory as `/build`.
  assertAsks(runHook('rm -rf //build'), '//build');
  assertAsks(runHook('rm -rf /./build'), '/./build');
  assertAsks(runHook('rm -rf /.//dist'), '/.//dist');
});

check('a disposable name at the filesystem root prompts', () => {
  // Unanchoring the build directories means they match at any depth, and the
  // root is a depth. `/build` is not a project's build output, so deleting the
  // whole of it goes to the user rather than through.
  assertAsks(runHook('rm -rf /build'), '/build');
  assertAsks(runHook('rm -rf /dist'), '/dist');
  assertAsks(runHook('rm -rf /coverage'), '/coverage');
  assertAsks(runHook('rm -rf /node_modules'), '/node_modules');
  // But only the directory itself. A confirm verdict arrives at the user as an
  // outright deny, so withholding the subtree as well would deny real deletes
  // on a machine that does keep a checkout up there.
  assert.strictEqual(runHook('rm -rf /build/artifacts'), null, 'hook denied /build/artifacts');
});

fs.rmSync(FAKE_HOME, { recursive: true, force: true });
fs.rmSync(NOWHERE, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
