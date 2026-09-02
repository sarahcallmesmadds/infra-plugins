#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'git-hygiene');
const HOOK = path.join(ROOT, 'hooks', 'worktree-guard.js');
const { decisionFor } = require(path.join(ROOT, 'scripts', 'worktree-command'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-guard-'));
const projects = path.join(temp, 'Projects');
const hidden = path.join(temp, '.worktrees');
const config = path.join(temp, 'config.json');
fs.mkdirSync(projects, { recursive: true });
execFileSync('git', ['init', '-q', projects]);
fs.writeFileSync(config, JSON.stringify({
  projectRoots: [projects], worktreeRoot: hidden,
  enforceWorktreeRoot: true, sessionNotice: true,
}));

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`); }
}

function fire(command, options = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
      cwd: projects,
    }),
    encoding: 'utf8',
    env: { ...process.env, GIT_HYGIENE_CONFIG: options.config === undefined ? config : options.config },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function denied(command, options) {
  const result = fire(command, options);
  return result && result.hookSpecificOutput && result.hookSpecificOutput.permissionDecision === 'deny';
}

for (const action of ['add', 'move', 'remove', 'lock', 'unlock']) {
  check(`direct git worktree ${action} is denied`, () => {
    assert.strictEqual(denied(`git worktree ${action} /tmp/example`), true);
  });
}

check('denials name supported worktree-hygiene routes', () => {
  for (const [action, route] of Object.entries({
    add: 'create', move: 'relocate', remove: 'cleanup', lock: 'activate', unlock: 'finish',
  })) {
    const result = fire(`git worktree ${action} /tmp/example`);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, new RegExp(`worktree-hygiene ${route}`));
  }
  const prune = fire('git worktree prune');
  assert.match(prune.hookSpecificOutput.permissionDecisionReason, /worktree-hygiene cleanup/);
});

check('direct worktree creation is denied even at a canonical hidden path', () => {
  assert.strictEqual(denied(`git worktree add "${path.join(hidden, 'owner', 'repo', 'branch')}" branch`), true);
});

check('non-dry-run prune is denied and both dry-run spellings are allowed', () => {
  assert.strictEqual(denied('git worktree prune'), true);
  assert.strictEqual(fire('git worktree prune --dry-run'), null);
  assert.strictEqual(fire('git worktree prune -n --verbose'), null);
});

check('list and unrelated Git commands are allowed', () => {
  assert.strictEqual(fire('git worktree list --porcelain'), null);
  assert.strictEqual(fire('git worktree repair /tmp/example'), null);
  assert.strictEqual(fire('git status --short'), null);
});

check('git -C, quoted paths, and compound cd commands are parsed', () => {
  assert.strictEqual(denied('git -C "/tmp/a repo" --no-pager worktree remove "/tmp/a repo/wt"'), true);
  assert.strictEqual(denied('cd "/tmp/a repo" && git worktree move old new'), true);
});

check('shell -c and command substitutions cannot hide a mutation', () => {
  assert.strictEqual(denied('bash -c "git worktree remove /tmp/wt"'), true);
  assert.strictEqual(denied('echo $(git worktree unlock /tmp/wt)'), true);
  assert.strictEqual(denied('echo `git worktree lock /tmp/wt`'), true);
  assert.strictEqual(denied('eval "git worktree move old new"'), true);
  assert.strictEqual(denied("bash <<< 'git worktree remove /tmp/wt'"), true);
  assert.strictEqual(denied('GIT_COMMAND=git; $GIT_COMMAND worktree unlock /tmp/wt'), true);
  assert.strictEqual(denied('CMD="git worktree remove --force"; $CMD /tmp/wt'), true);
  assert.strictEqual(denied('CMD="git worktree remove --force /tmp/wt"; sh -c "$CMD"'), true);
  assert.strictEqual(denied('CMD="git worktree remove --force /tmp/wt"; eval "$CMD"'), true);
  assert.strictEqual(denied('X=worktree; git "$X" remove /tmp/wt'), true);
  assert.strictEqual(denied('ARGS="worktree remove /tmp/wt"; git $ARGS'), true);
  assert.strictEqual(fire("LOOP='$LOOP'; $LOOP"), null);
});

check('xargs dispatch cannot hide or batch a mutation', () => {
  assert.strictEqual(denied("printf '%s\\n' /tmp/wt | xargs git worktree remove"), true);
  assert.strictEqual(denied('xargs -n 1 /usr/bin/git worktree lock <<< /tmp/wt'), true);
});

check('executable and expanding heredocs cannot hide a mutation', () => {
  assert.strictEqual(denied("sh <<'EOF'\ngit worktree remove /tmp/wt\nEOF"), true);
  assert.strictEqual(denied("cat <<'EOF' | sh\ngit worktree unlock /tmp/wt\nEOF"), true);
  assert.strictEqual(denied('cat <<EOF\n$(git worktree move old new)\nEOF'), true);
  assert.strictEqual(denied('cat <<EOF\n`git worktree lock /tmp/wt`\nEOF'), true);
});

check('inline and configured Git aliases cannot hide a mutation', () => {
  assert.strictEqual(denied("git -c alias.wt='worktree remove --force' wt /tmp/wt"), true);
  assert.strictEqual(denied("git -c alias.wt='!git worktree unlock' wt /tmp/wt"), true);
  assert.strictEqual(denied("DANGER='worktree remove' git --config-env=alias.wt=DANGER wt /tmp/wt"), true);
  execFileSync('git', ['-C', projects, 'config', 'alias.wt', 'worktree move']);
  assert.strictEqual(denied('git wt old new'), true);
  assert.strictEqual(denied(`cd "${temp}" && git -C Projects wt old new`), true);
  assert.strictEqual(denied(`env -C "${projects}" git wt old new`), true);
  execFileSync('git', ['-C', projects, 'config', 'alias.wt', 'worktree list']);
  assert.strictEqual(fire('git wt'), null);
  execFileSync('git', ['-C', projects, 'config', 'alias.status', 'worktree remove']);
  assert.strictEqual(fire('git status --short'), null);
});

check('shell control syntax and executable wrappers cannot hide a mutation', () => {
  for (const command of [
    '(git worktree remove /tmp/wt)',
    '{ git worktree remove /tmp/wt; }',
    '/usr/bin/git worktree remove /tmp/wt',
    'if true; then git worktree remove /tmp/wt; fi',
    'while true; do git worktree remove /tmp/wt; done',
    'time git worktree remove /tmp/wt',
    'exec git worktree remove /tmp/wt',
    'env -u NAME git worktree remove /tmp/wt',
    'command -p git worktree remove /tmp/wt',
    '/usr/bin/env git worktree remove /tmp/wt',
    '/usr/bin/nohup git worktree remove /tmp/wt',
  ]) assert.strictEqual(denied(command), true, command);
});

check('an unparseable worktree action fails closed', () => {
  assert.strictEqual(denied('git worktree "$ACTION" /tmp/wt'), true);
});

check('quoted prose and heredoc examples are ignored', () => {
  assert.strictEqual(fire('claude -p "Explain git worktree remove /tmp/wt"'), null);
  assert.strictEqual(fire("printf '%s' '$(git worktree remove /tmp/wt)'"), null);
  assert.strictEqual(fire("printf '%s' '`git worktree remove /tmp/wt`'"), null);
  assert.strictEqual(fire("cat <<'EOF'\ngit worktree remove /tmp/wt\nEOF"), null);
  assert.strictEqual(fire("cat <<'EOF'\n$(git worktree remove /tmp/wt)\nEOF"), null);
  assert.strictEqual(fire("cat <<'EOF'\n`git worktree remove /tmp/wt`\nEOF"), null);
  assert.strictEqual(denied("printf '%s' '<<EOF'; git worktree remove /tmp/wt"), true);
});

check('the governed Node CLI is allowed', () => {
  assert.strictEqual(fire(`node "${path.join(ROOT, 'scripts', 'worktrees.js')}" audit --repo /tmp/repo`), null);
});

check('missing configuration leaves enforcement off', () => {
  assert.strictEqual(fire('git worktree remove /tmp/wt', { config: path.join(temp, 'missing.json') }), null);
});

check('invalid existing configuration fails closed for mutations', () => {
  const bad = path.join(temp, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  const result = fire('git worktree remove /tmp/wt', { config: bad });
  assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /could not validate/);
});

check('the captured Bash event shape receives the denial', () => {
  assert.strictEqual(denied('git worktree add /tmp/wt branch'), true);
});

check('the parser identifies no mutation in ordinary quoted text', () => {
  assert.strictEqual(decisionFor('printf %s "git worktree remove /tmp/wt"'), null);
});

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
