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
  const hidden = path.join(base, '.worktrees');
  const repo = path.join(projects, 'example');
  const config = path.join(base, 'config.json');
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
  fs.writeFileSync(config, JSON.stringify({
    projectRoots: [projects], worktreeRoot: hidden,
    enforceWorktreeRoot: true, sessionNotice: notice,
  }));
  return { base, projects, hidden, repo, config, target, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function fire(f, source = 'startup') {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: f.base, source }),
    encoding: 'utf8',
    env: { ...process.env, GIT_HYGIENE_CONFIG: f.config },
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
    assert.match(event.hookSpecificOutput.additionalContext, /1 linked worktree still sits/);
    assert.match(event.hookSpecificOutput.additionalContext, /nothing was moved or removed/);
  } finally { f.cleanup(); }
});

check('missing registrations are reported without pruning them', () => {
  const f = fixture({ linked: true, missing: true });
  try {
    const event = fire(f);
    assert.match(event.hookSpecificOutput.additionalContext, /1 missing worktree registration needs review/);
    assert.doesNotMatch(event.hookSpecificOutput.additionalContext, /still sits inside/);
    const list = execFileSync('git', ['-C', f.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    assert.match(list, /prunable/);
  } finally { f.cleanup(); }
});

check('turning off the worktree session notice keeps visible clutter silent', () => {
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
  assert.match(source, /if \(audit\.truncated\) return null;/);
});

check('a slow Git command is stopped by the session deadline', () => {
  const f = fixture({ linked: true });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-slow-git-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = status ]; then sleep 2; fi
  if [ "$argument" = for-each-ref ]; then sleep 3; fi
done
exec "${realGit}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  try {
    const started = Date.now();
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: f.base, source: 'startup' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GIT_HYGIENE_CONFIG: f.config,
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
      env: { ...process.env, GIT_HYGIENE_CONFIG: path.join(f.base, 'absent.json') },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout);
    assert.strictEqual(audit.summary.repositories, 1);
    assert.strictEqual(audit.repositories[0].worktrees[0].state, 'primary');
  } finally { f.cleanup(); }
});

check('configured global status discovers repositories from outside them', () => {
  const f = fixture({ linked: true });
  try {
    const result = spawnSync(process.execPath, [CLI, 'audit', '--all-configured', '--json'], {
      cwd: f.base,
      encoding: 'utf8',
      env: { ...process.env, GIT_HYGIENE_CONFIG: f.config },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const audit = JSON.parse(result.stdout);
    assert.strictEqual(audit.summary.repositories, 1);
    assert.strictEqual(audit.summary.visible, 1);
  } finally { f.cleanup(); }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
