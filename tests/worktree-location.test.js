#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { misplacedTarget } = require('../plugins/git-hygiene/scripts/worktree-location');

const policy = { projectRoot: '/P', worktreeRoot: '/P/Worktrees' };
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${error.message}`); }
}
function inspect(command, cwd = '/P') { return misplacedTarget(command, cwd, policy); }
function blocked(command, cwd = '/P') { return Boolean(inspect(command, cwd)); }

check('allows a worktree under the required repository and task folders', () => {
  assert.strictEqual(inspect('git worktree add /P/Worktrees/repo/task', '/P'), null);
  assert.strictEqual(inspect('git -C /P/repo worktree add --detach ../Worktrees/repo/task HEAD', '/P'), null);
  assert.strictEqual(inspect('git worktree add -b topic /P/Worktrees/repo/task HEAD', '/P'), null);
  assert.strictEqual(inspect('git worktree add --track -b tracked /P/Worktrees/repo/task main', '/P'), null);
  assert.strictEqual(inspect('git worktree add --orphan /P/Worktrees/repo/task', '/P'), null);
  assert.strictEqual(inspect('git worktree add --orphan -b topic /P/Worktrees/repo/task', '/P'), null);
  assert.strictEqual(inspect('git worktree add -d /P/Worktrees/repo/task HEAD', '/P'), null);
  assert.strictEqual(inspect('git worktree add -btopic -q --no-guess-remote /P/Worktrees/repo/task', '/P'), null);
  assert.strictEqual(inspect('git worktree add --relative-paths /P/Worktrees/repo/task', '/P'), null);
  assert.strictEqual(inspect('git worktree add --no-relative-paths /P/Worktrees/repo/task', '/P'), null);
  assert.ok(blocked('git worktree add --orphan /P/bad', '/P'));
  assert.ok(blocked('git worktree add --orphan=topic /P/Worktrees/repo/task', '/P'));
  assert.strictEqual(inspect('git worktree add "/P/Worktrees/my repo/task"', '/P'), null);
});

check('rejects destinations outside the exact two-level worktree layout', () => {
  for (const command of [
    'git worktree add /P/bad',
    'git worktree add /outside/task',
    'git worktree add /P/Worktrees/task',
    'git worktree add /P/Worktrees/repo/task/child',
    'git worktree -- add /P/bad',
    'git worktree -- move old /P/bad',
    'git worktree add "/P/Worktrees/repo/task extra/child"',
    'git worktree move old /P/bad',
    'git worktree move old /P/Worktrees/repo/task/child',
  ]) assert.ok(blocked(command), command);
});

check('reads supported add and move options and rejects options it cannot model', () => {
  assert.strictEqual(inspect('git worktree add --detach --reason="task" /P/Worktrees/repo/task HEAD'), null);
  assert.strictEqual(inspect('git worktree add --track=direct /P/Worktrees/repo/task origin/main'), null);
  assert.ok(blocked('git worktree add -b topic --track direct Worktrees/repo/task', '/P'));
  assert.deepStrictEqual(inspect('git worktree add -b topic --track direct Worktrees/repo/task', '/P'),
    { target: '/P/direct' });
  assert.ok(blocked('git worktree add --unknown /P/Worktrees/repo/task'));
  assert.ok(blocked('git worktree repair'));
  assert.ok(blocked('git worktree repair -- --help'));
  assert.ok(blocked('git worktree add --detach -- --help HEAD'));
  assert.ok(blocked('git worktree add "$DEST"'));
  assert.ok(blocked('git worktree "$ACTION" /P/Worktrees/repo/task'));
});

check('checks one standalone literal Git command and rejects shell syntax in it', () => {
  assert.ok(blocked('git worktree add /P/bad && echo done'));
  assert.ok(blocked('\ngit worktree add /P/bad'));
  assert.strictEqual(inspect('git worktree add /P/Worktrees/repo/task\n'), null);
  assert.ok(blocked('git worktree add /P/bad >/dev/null'));
  assert.ok(blocked('git worktree add /P/bad # --help'));
  assert.strictEqual(inspect('git > /tmp/log worktree add /P/bad'), null);
  assert.ok(blocked('git worktree add "$(printf /P/bad)"'));
  assert.strictEqual(inspect('git worktree add "/P/Worktrees/repo/task\\$literal"'), null);
  assert.ok(blocked('git worktree add ~"/Projects/Worktrees/repo/task"', '/P'));
  assert.ok(blocked('git worktree add "/tmp/\\\n../worktree-review-task"'));
  assert.ok(blocked('git worktree add /P/Worktrees/repo/task /child'));
  const homePolicy = { projectRoot: require('os').homedir(), worktreeRoot: path.join(require('os').homedir(), 'Projects') };
  assert.ok(misplacedTarget('git -C"~/Projects" worktree add review-repo/review-task', '/P', homePolicy));
  assert.strictEqual(inspect("bash -c 'git worktree add /P/bad'"), null);
  assert.strictEqual(inspect('echo before; git worktree add /P/bad'), null);
  assert.strictEqual(inspect('2>/dev/null git worktree add /P/bad'), null);
});

check('ignores quoted examples and comments', () => {
  assert.strictEqual(inspect("printf '%s\\n' 'git worktree add /P/bad'"), null);
  assert.strictEqual(inspect("echo 'git worktree add /P/bad'"), null);
  assert.strictEqual(inspect('echo "\\$(git worktree add /P/bad)"'), null);
  assert.strictEqual(inspect('git status # example; git worktree add /P/bad'), null);
  assert.strictEqual(inspect(':;# example; git worktree add /P/bad'), null);
});

check('does not scan command wrappers or function bodies', () => {
  assert.strictEqual(inspect('command git worktree add /P/bad'), null);
  assert.strictEqual(inspect('f() { git worktree add /P/bad; }; echo ready'), null);
});

check('does not interpret unrelated Git commands as worktree operations', () => {
  for (const command of ['git status', 'git rev-parse --show-toplevel', 'git ls-files',
    'git merge-base HEAD origin/main', 'git worktree list', 'git log --oneline', 'git --version',
    'command git status', 'env LC_ALL=C git status', 'git -cuser.name=Example status',
    'git -C "$PWD" status', 'git -C"$PWD" status', 'git --git-dir="$REPO/.git" status',
    'git -C $PWD status', 'git --git-dir=$REPO/.git log',
    'rm /tmp/worktree-probe.log', 'echo safe']) {
    assert.strictEqual(inspect(command), null, command);
  }
  assert.strictEqual(inspect('git worktree add --help'), null);
  assert.strictEqual(inspect('git worktree'), null);
  assert.strictEqual(inspect('git worktree repair --help'), null);
  assert.strictEqual(inspect('git -C "$PWD" worktree list'), null);
  assert.strictEqual(inspect('git --git-dir=/P/repo/.git status'), null);
  assert.strictEqual(inspect('git --git-dir "$REPO/.git" worktree list --porcelain'), null);
  assert.strictEqual(inspect('git -c "$CFG" worktree list'), null);
  assert.strictEqual(inspect('git --work-tree "$WT" worktree list'), null);
  assert.strictEqual(inspect('git -C /P/repo status'), null);
  assert.strictEqual(inspect('git -p status'), null);
  assert.strictEqual(inspect('git -P worktree list'), null);
  assert.strictEqual(inspect('git --glob-pathspecs status'), null);
  assert.strictEqual(inspect('git --exec-path'), null);
  assert.strictEqual(inspect('git --html-path'), null);
  assert.strictEqual(inspect('git --exec-path=/usr/bin status'), null);
  assert.strictEqual(inspect('git --attr-source=HEAD --version'), null);
  assert.strictEqual(inspect('git --list-cmds=builtins'), null);
  assert.strictEqual(inspect('PYTHONPATH=$PWD python script.py'), null);
  assert.strictEqual(inspect('git worktree list --porcelain | head -n 20'), null);
  assert.strictEqual(inspect('git worktree list\n'), null);
  assert.strictEqual(inspect('git worktree prune --verbose >/tmp/worktree-prune.log'), null);
  assert.strictEqual(inspect('git worktree remove /P/Worktrees/repo/task && git worktree prune'), null);
  assert.strictEqual(inspect('GIT status'), null);
  assert.ok(blocked('GIT worktree add /P/bad'));
  assert.ok(blocked('GIT=git git worktree add /P/bad'));
  assert.strictEqual(inspect('X=$(hostname) git worktree add /P/bad'), null);
  assert.strictEqual(inspect('GIT status', null), null);
  assert.ok(blocked('GIT worktree add /P/bad', null));
  assert.strictEqual(inspect('git -c alias.wt=worktree wt add /P/bad'), null);
  assert.strictEqual(inspect('git -c alias.wt=worktree wt add /P/Worktrees/repo/task'), null);
  assert.strictEqual(inspect('git --config-env=alias.wt=GIT_WORKTREE wt add /P/bad'), null);
  assert.strictEqual(inspect('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.wt GIT_CONFIG_VALUE_0=worktree git wt add /P/bad'), null);
});

check('expands unquoted home-relative destinations before applying the folder rule', () => {
  assert.ok(blocked('git worktree add ~/task HEAD', '/P'));
  assert.ok(blocked("git worktree add --detach '~/Worktrees/repo/task'", '/P'));
});

check('resolves Git -C before checking a standalone destination', () => {
  assert.strictEqual(inspect('git -C /P/repo worktree add ../Worktrees/repo/task HEAD', '/P'), null);
  assert.ok(blocked('git -C /P/repo worktree add ../bad HEAD', '/P'));
  assert.ok(blocked('git -C "$REPO" worktree add Worktrees/repo/task', '/P'));
  assert.strictEqual(inspect('git -C "$REPO" worktree add /P/Worktrees/repo/task', '/P'), null);
});

check('does not claim to parse shell syntax or compound commands', () => {
  assert.strictEqual(inspect('git > /tmp/log worktree add /P/bad'), null);
  assert.strictEqual(inspect('git worktree 2>/tmp/wt.log add --detach /P/bad'), null);
  assert.strictEqual(inspect('echo x | git worktree add ../Worktrees/repo/task', '/P/repo'), null);
  assert.strictEqual(inspect('(cd /P/Worktrees/repo/foo; true); git worktree add ../bad', '/P/repo'), null);
});

check('expands home paths across line continuations and resolves symlinked parents portably', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-home-paths-')));
  try {
    const home = path.join(root, 'home');
    const external = path.join(root, 'external');
    const allowed = path.join(home, 'P', 'Worktrees');
    const escaped = path.join(external, 'P');
    fs.mkdirSync(path.join(home, 'P', 'repo'), { recursive: true });
    fs.mkdirSync(path.join(allowed, 'repo'), { recursive: true });
    fs.mkdirSync(path.join(external, 'nested'), { recursive: true });
    fs.mkdirSync(path.join(escaped, 'repo'), { recursive: true });
    fs.mkdirSync(path.join(escaped, 'Worktrees'), { recursive: true });
    fs.symlinkSync(path.join(external, 'nested'), path.join(home, 'link'));
    const script = `
      const f = require(${JSON.stringify(path.resolve(__dirname, '../plugins/git-hygiene/scripts/worktree-location'))}).misplacedTarget;
      const p = ${JSON.stringify({ projectRoot: path.join(home, 'P'), worktreeRoot: allowed })};
      const cwd = ${JSON.stringify(path.join(home, 'P', 'repo'))};
      const cases = [
        f('git worktree add ~\\\\\\n/P/Worktrees/repo/task', cwd, p),
        f('git worktree add ~/link/../P/Worktrees/repo/task', cwd, p),
        f('git -C ~/link/../P/repo worktree add ../Worktrees/repo/task', cwd, p),
      ];
      process.stdout.write(JSON.stringify(cases));
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const [continuedHomePath, symlinkedDestination, symlinkedGitCwd] = JSON.parse(result.stdout);
    assert.strictEqual(continuedHomePath, null);
    assert.ok(symlinkedDestination);
    assert.ok(symlinkedGitCwd);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('resolves existing symlink ancestry before applying the folder rule', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-location-')));
  try {
    const project = path.join(root, 'P');
    const worktrees = path.join(project, 'Worktrees');
    const repo = path.join(project, 'repo');
    fs.mkdirSync(worktrees, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(worktrees, 'repo', 'foo'), { recursive: true });
    assert.ok(misplacedTarget(`git worktree add '${path.join(worktrees, 'repo', 'foo', 'bad')}'`, repo,
      { projectRoot: project, worktreeRoot: worktrees }));
    assert.strictEqual(misplacedTarget('echo x | git worktree add ../Worktrees/repo/task', repo,
      { projectRoot: project, worktreeRoot: worktrees }), null);
    fs.symlinkSync(project, path.join(worktrees, 'escape'));
    const result = misplacedTarget(`git worktree add '${path.join(worktrees, 'escape', 'task')}'`, repo,
      { projectRoot: project, worktreeRoot: worktrees });
    assert.ok(result);
    const repository = path.join(worktrees, 'repo');
    fs.mkdirSync(repository, { recursive: true });
    fs.symlinkSync(project, path.join(repository, 'link'));
    assert.ok(misplacedTarget(`git worktree add '${repository}/link/../bad'`, repo,
      { projectRoot: project, worktreeRoot: worktrees }));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(path.join(outside, 'missing'), path.join(repository, 'dangling'));
    const dangling = misplacedTarget(`git worktree add '${repository}/dangling/../bad'`, repo,
      { projectRoot: project, worktreeRoot: worktrees });
    assert.deepStrictEqual(dangling, { target: path.join(outside, 'bad') });
    assert.ok(misplacedTarget('git -C link/.. worktree add task', repository,
      { projectRoot: project, worktreeRoot: worktrees }));
    const existingDirectory = path.join(worktrees, 'repo', 'existing');
    fs.mkdirSync(existingDirectory, { recursive: true });
    assert.ok(misplacedTarget(`git worktree move '${path.join(repo, 'old')}' '${existingDirectory}'`, repo,
      { projectRoot: project, worktreeRoot: worktrees }));
    const currentWorktree = path.join(worktrees, 'repo', 'current');
    fs.mkdirSync(currentWorktree, { recursive: true });
    assert.ok(misplacedTarget(`git worktree move . '${existingDirectory}'`, currentWorktree,
      { projectRoot: project, worktreeRoot: worktrees }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('loads only an absolute worktree policy nested inside the project root', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-policy-')));
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'git-hygiene.config.json'), JSON.stringify({
      worktreeLocation: { projectRoot: path.join(root, 'Projects'), worktreeRoot: path.join(root, 'Projects', 'Worktrees') },
    }));
    const result = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.resolve(__dirname, '../plugins/git-hygiene/scripts/worktree-location.js'))}).loadPolicy()))`], {
      env: { ...process.env, HOME: root }, encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      projectRoot: path.join(root, 'Projects'), worktreeRoot: path.join(root, 'Projects', 'Worktrees'),
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

check('hook emits the documented PreToolUse denial shape for an unapproved path', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-hook-')));
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'git-hygiene.config.json'), JSON.stringify({
      worktreeLocation: { projectRoot: path.join(root, 'Projects'), worktreeRoot: path.join(root, 'Projects', 'Worktrees') },
    }));
    const event = { tool_name: 'Bash', cwd: path.join(root, 'Projects'), tool_input: { command: 'git worktree add ../bad' } };
    const result = spawnSync(process.execPath, ['plugins/git-hygiene/hooks/worktree-location-guard.js'], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOME: root }, input: JSON.stringify(event), encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${passed + failed} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
