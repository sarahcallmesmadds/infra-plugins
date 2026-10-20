#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'git-hygiene');
const HOOK = path.join(ROOT, 'hooks', 'session-notice.js');
const CLI = path.join(ROOT, 'scripts', 'worktrees.js');

// A developer's own Git config (url.insteadOf rewrites, a global hooks path,
// signing) must not change what these fixtures see. Child processes inherit it.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`); }
}

function fixture({ linked = false, missing = false, notice = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-notice-'));
  const projects = path.join(base, 'Projects');
  const hidden = path.join(projects, 'Worktrees');
  const repo = path.join(projects, 'example');
  // The hook reads ~/.claude/git-hygiene.config.json, so each check runs with
  // HOME pointed here. Never let a check fall through to the real home folder:
  // it then audits the developer's own projects and its counts mean nothing.
  const config = path.join(base, '.claude', 'git-hygiene.config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.mkdirSync(projects, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=Test',
    'commit', '-q', '--allow-empty', '-m', 'base']);
  let target = null;
  if (linked) {
    target = path.join(projects, 'example-feature');
    execFileSync('git', ['-C', repo, 'branch', 'feature', 'main']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', target, 'feature']);
    if (missing) fs.rmSync(target, { recursive: true, force: true });
  }
  fs.writeFileSync(config, JSON.stringify(notice
    ? { worktreeLocation: { projectRoot: projects, worktreeRoot: hidden } }
    : { branchCleanup: { staleAfterDays: 30 } }));
  return { base, projects, hidden, repo, config, target, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function fire(f, source = 'startup') {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: f.base, source }),
    encoding: 'utf8',
    env: { ...process.env, HOME: f.base },
    timeout: 5000,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

check('a healthy configured session start stays silent', () => {
  const f = fixture();
  try { assert.strictEqual(fire(f), null); }
  finally { f.cleanup(); }
});

check('a home-directory-style session reports visible linked worktree clutter once', () => {
  const f = fixture({ linked: true });
  try {
    const event = fire(f);
    assert.strictEqual(event.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(event.hookSpecificOutput.additionalContext, /1 linked worktree sits in the project folder instead of the worktree folder/);
    assert.match(event.hookSpecificOutput.additionalContext, /nothing was moved or removed/);
  } finally { f.cleanup(); }
});

check('missing registrations are reported without pruning them', () => {
  const f = fixture({ linked: true, missing: true });
  try {
    const event = fire(f);
    assert.match(event.hookSpecificOutput.additionalContext, /1 missing worktree registration needs review/);
    assert.doesNotMatch(event.hookSpecificOutput.additionalContext, /sits in the project folder/);
    const list = execFileSync('git', ['-C', f.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    assert.match(list, /prunable/);
  } finally { f.cleanup(); }
});

check('a config with only branch settings keeps the worktree notice silent', () => {
  const f = fixture({ linked: true, notice: false });
  try { assert.strictEqual(fire(f), null); }
  finally { f.cleanup(); }
});

check('resume and compact stay silent even when visible clutter exists', () => {
  const f = fixture({ linked: true });
  try {
    assert.strictEqual(fire(f, 'resume'), null);
    assert.strictEqual(fire(f, 'compact'), null);
  } finally { f.cleanup(); }
});

check('an incomplete worktree scan makes no count claim', () => {
  const source = fs.readFileSync(HOOK, 'utf8');
  assert.match(source, /if \(counts\.truncated\) return null;/);
  assert.doesNotMatch(source, /auditConfigured/);
});

check('a slow Git command is stopped by the session deadline', () => {
  const f = fixture({ linked: true });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-slow-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = worktree ]; then sleep 3; fi
  if [ "$argument" = for-each-ref ]; then sleep 3; fi
done
exec "${realGit}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  // Slow the one per-repository command the notice scan runs. If the scan ever
  // stops passing its deadline down as a timeout, this hangs past the budget.
  try {
    const started = Date.now();
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: f.base, source: 'startup' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: f.base,
      },
      timeout: 5000,
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, '');
    assert.ok(elapsed < 2500, `session hook took ${elapsed} ms`);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

check('current-repository status works without configuration', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [CLI, 'audit', '--repo', f.repo, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(f.base, 'empty-home') },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout);
    assert.strictEqual(audit.summary.repositories, 1);
    assert.strictEqual(audit.repositories[0].worktrees[0].state, 'primary');
  } finally { f.cleanup(); }
});

check('the notice scan counts exactly what the full audit counts', () => {
  for (const options of [{ linked: true }, { linked: true, missing: true }, {}]) {
    const f = fixture(options);
    try {
      const managed = path.join(f.hidden, 'example', 'managed');
      execFileSync('git', ['-C', f.repo, 'branch', 'managed', 'main']);
      execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-q', managed, 'managed']);
      const script = `const w = require(${JSON.stringify(CLI)});
        const full = w.auditConfigured({ skipRemote: true }).summary;
        const fast = w.placementCounts({});
        process.stdout.write(JSON.stringify({ full: [full.visible, full.missing], fast: [fast.visible, fast.missing], truncated: fast.truncated }));`;
      const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: f.base }, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      const counts = JSON.parse(result.stdout);
      assert.strictEqual(counts.truncated, false);
      assert.deepStrictEqual(counts.fast, counts.full, JSON.stringify(options));
    } finally { f.cleanup(); }
  }
});

check('configured global status discovers repositories from outside them', () => {
  const f = fixture({ linked: true });
  try {
    const result = spawnSync(process.execPath, [CLI, 'audit', '--all-configured', '--json'], {
      cwd: f.base,
      encoding: 'utf8',
      env: { ...process.env, HOME: f.base },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout);
    assert.strictEqual(audit.summary.repositories, 1);
    assert.strictEqual(audit.summary.visible, 1);
  } finally { f.cleanup(); }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
