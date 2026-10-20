#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'git-hygiene');
const configModule = require(path.join(ROOT, 'scripts', 'worktree-config'));
const worktrees = require(path.join(ROOT, 'scripts', 'worktrees'));
const { misplacedTarget, resolveRoots } = require(path.join(ROOT, 'scripts', 'worktree-location'));

// A developer's own Git config (url.insteadOf rewrites, a global hooks path,
// signing) must not change what these fixtures see. Child processes inherit it.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';

let failed = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL  ${name}\n        ${error.stack || error.message}\n`); }
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function failingLockGit() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-fail-lock-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(bin, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
previous=
for argument in "$@"; do
  if [ "$previous" = worktree ] && [ "$argument" = lock ]; then exit 73; fi
  previous="$argument"
done
exec "${realGit}" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  return bin;
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-worktrees-'));
  const projects = path.join(base, 'Projects');
  const hidden = path.join(projects, 'Worktrees');
  const repo = path.join(projects, 'example');
  fs.mkdirSync(projects, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const roots = resolveRoots(projects, hidden);
  const config = {
    exists: true,
    valid: true,
    errors: [],
    projectRoots: [roots.projectRoot],
    worktreeRoot: roots.worktreeRoot,
  };
  return {
    base, projects, hidden, repo, config,
    add(branch, location, options = {}) {
      if (options.detached) git(repo, 'worktree', 'add', '--detach', location, 'main');
      else {
        git(repo, 'branch', branch, options.base || 'main');
        git(repo, 'worktree', 'add', location, branch);
      }
      return location;
    },
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

check('configuration reads only the shared worktreeLocation setting', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-config-')));
  try {
    fs.mkdirSync(path.join(base, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(base, 'Projects'), { recursive: true });
    const load = (contents) => {
      const file = path.join(base, '.claude', 'git-hygiene.config.json');
      if (contents === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, JSON.stringify(contents));
      const result = spawnSync(process.execPath, ['-e',
        `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'scripts', 'worktree-config'))}).loadConfig()))`,
      ], { env: { ...process.env, HOME: base }, encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const configured = load({ worktreeLocation: { projectRoot: '~/Projects', worktreeRoot: '~/Projects/Worktrees' } });
    assert.strictEqual(configured.exists, true);
    assert.strictEqual(configured.valid, true, configured.errors.join('; '));
    assert.deepStrictEqual(configured.projectRoots, [path.join(base, 'Projects')]);
    assert.strictEqual(configured.worktreeRoot, path.join(base, 'Projects', 'Worktrees'));
    // Branch settings alone must not switch on the worktree audit or notice.
    assert.strictEqual(load({ branchCleanup: { staleAfterDays: 30 } }).exists, false);
    assert.strictEqual(load(undefined).exists, false);
    // The rule the guard and setup enforce: the worktree folder sits inside the
    // project folder. A hidden sibling root is invalid here too.
    const outside = load({ worktreeLocation: { projectRoot: '~/Projects', worktreeRoot: '~/.worktrees' } });
    assert.strictEqual(outside.exists, true);
    assert.strictEqual(outside.valid, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

check('destinations are <worktreeRoot>/<repo>/<task> and the location guard accepts them', () => {
  const f = fixture();
  try {
    const policy = { projectRoot: f.config.projectRoots[0], worktreeRoot: f.config.worktreeRoot };
    const fromBranch = worktrees.destinationFor(f.repo, 'feature/new', f.config);
    assert.strictEqual(fromBranch, path.join(f.config.worktreeRoot, 'example', 'feature-new'));
    const named = worktrees.destinationFor(f.repo, 'feature/new', f.config, 'my-task');
    assert.strictEqual(named, path.join(f.config.worktreeRoot, 'example', 'my-task'));
    for (const destination of [fromBranch, named]) {
      assert.strictEqual(misplacedTarget(`git worktree add '${destination}' feature/new`, f.repo, policy), null, destination);
    }
    assert.throws(() => worktrees.destinationFor(f.repo, 'feature/new', f.config, 'a/b'), /unsafe task folder name/);
  } finally { f.cleanup(); }
});

check('porcelain parsing keeps spaces in exact worktree paths', () => {
  const parsed = worktrees.parsePorcelain('worktree /tmp/a path\0HEAD abc\0branch refs/heads/fix/x\0\0');
  assert.deepStrictEqual(parsed, [{ path: '/tmp/a path', head: 'abc', branch: 'fix/x' }]);
});

check('the audit classifies primary, merged, unique, dirty, locked, detached, and missing worktrees', () => {
  const f = fixture();
  try {
    const merged = f.add('merged', path.join(f.projects, 'example-merged'));
    const unique = f.add('unique', path.join(f.projects, 'example-unique'));
    fs.writeFileSync(path.join(unique, 'unique.txt'), 'unique\n');
    git(unique, 'add', '.'); git(unique, 'commit', '-qm', 'unique');
    const dirty = f.add('dirty', path.join(f.projects, 'example-dirty'));
    fs.writeFileSync(path.join(dirty, 'untracked.txt'), 'not committed\n');
    const locked = f.add('locked', path.join(f.projects, 'example-locked'));
    git(f.repo, 'worktree', 'lock', '--reason', 'test session', locked);
    f.add(null, path.join(f.base, 'review-detached'), { detached: true });
    const missing = f.add('missing', path.join(f.base, 'gone'));
    fs.rmSync(missing, { recursive: true, force: true });

    const audit = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true });
    const states = new Map(audit.worktrees.map((entry) => [entry.branch || entry.path, entry.state]));
    assert.strictEqual(audit.worktrees[0].state, worktrees.STATES.PRIMARY);
    assert.strictEqual(states.get('merged'), worktrees.STATES.MERGED);
    assert.strictEqual(states.get('unique'), worktrees.STATES.UNIQUE);
    assert.strictEqual(states.get('dirty'), worktrees.STATES.DIRTY);
    assert.strictEqual(states.get('locked'), worktrees.STATES.LOCKED);
    assert.ok(audit.worktrees.some((entry) => entry.state === worktrees.STATES.DETACHED_REVIEW));
    assert.strictEqual(states.get('missing'), worktrees.STATES.MISSING);
    assert.strictEqual(audit.worktrees.find((entry) => entry.branch === 'merged').removable, true);
  } finally { f.cleanup(); }
});

check('staged files make a worktree dirty', () => {
  const f = fixture();
  try {
    const target = f.add('staged', path.join(f.projects, 'example-staged'));
    fs.writeFileSync(path.join(target, 'staged.txt'), 'staged\n');
    git(target, 'add', 'staged.txt');
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'staged');
    assert.strictEqual(entry.state, worktrees.STATES.DIRTY);
  } finally { f.cleanup(); }
});

function withGh(script, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-gh-'));
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\n${script}\n`);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try { return fn(); }
  finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('a GitHub open pull request wins over local merge evidence', () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    const target = f.add('reviewed', path.join(f.projects, 'example-reviewed'));
    const head = git(target, 'rev-parse', 'HEAD');
    // The branch is locally merged (no commits beyond main), so only the open
    // pull request can make it OPEN.
    const row = JSON.stringify([{ number: 7, state: 'OPEN', mergedAt: null, headRefOid: head, baseRefName: 'main' }]);
    withGh(`printf '%s\\n' '${row}'`, () => {
      const entry = worktrees.auditRepository(f.repo, { config: f.config })
        .worktrees.find((candidate) => candidate.branch === 'reviewed');
      assert.strictEqual(entry.state, worktrees.STATES.OPEN);
      assert.strictEqual(entry.removable, false);
    });
  } finally { f.cleanup(); }
});

check('an unavailable GitHub lookup is unknown, never merged', () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    f.add('unreadable', path.join(f.projects, 'example-unreadable'));
    withGh('exit 1', () => {
      const entry = worktrees.auditRepository(f.repo, { config: f.config })
        .worktrees.find((candidate) => candidate.branch === 'unreadable');
      assert.strictEqual(entry.state, worktrees.STATES.UNKNOWN);
      assert.match(entry.reason, /could not be read from GitHub/);
      assert.strictEqual(entry.removable, false);
    });
  } finally { f.cleanup(); }
});

check('HTTPS, SSH URL, and SCP remotes identify GitHub correctly', () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    for (const url of [
      'https://github.com/owner/example.git',
      'ssh://git@github.com/owner/example.git',
      'git@github.com:owner/example.git',
    ]) {
      git(f.repo, 'remote', 'set-url', 'origin', url);
      const identity = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true }).identity;
      assert.strictEqual(identity.github, true, url);
      assert.strictEqual(identity.host, 'github.com', url);
    }
    git(f.repo, 'remote', 'set-url', 'origin', 'https://user:secret@github.com/owner/example.git');
    const credentialed = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true }).identity;
    assert.strictEqual(credentialed.owner, 'owner');
    assert.doesNotMatch(JSON.stringify(credentialed), /secret|user:|"url"/);
  } finally { f.cleanup(); }
});

check('ignored files make a worktree non-removable', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.repo, '.gitignore'), '.env\n');
    git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore local env');
    const target = f.add('ignored', path.join(f.projects, 'example-ignored'));
    fs.writeFileSync(path.join(target, '.env'), 'secret\n');
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'ignored');
    assert.strictEqual(entry.state, worktrees.STATES.DIRTY);
    assert.ok(entry.status.some((line) => line.startsWith('!! ')));
    assert.throws(() => worktrees.verifyRemove(target, { config: f.config, cwd: f.base }), /refusing/);
  } finally { f.cleanup(); }
});

check('review-tool locations win over containing project roots', () => {
  const f = fixture();
  try {
    const target = f.add('review', path.join(f.projects, '.planning', 'review'));
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'review');
    assert.strictEqual(entry.location, 'review-tool');
    assert.strictEqual(entry.state, worktrees.STATES.DETACHED_REVIEW);
    assert.strictEqual(entry.removable, false);
    assert.strictEqual(entry.relocatable, false);
  } finally { f.cleanup(); }
});

check('initialized submodules hold a worktree out of move and removal offers', () => {
  const f = fixture();
  const submodule = path.join(f.base, 'submodule');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', submodule]);
    git(submodule, 'config', 'user.email', 'test@example.com');
    git(submodule, 'config', 'user.name', 'Test User');
    git(submodule, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submodule, 'deps/submodule');
    git(f.repo, 'commit', '-qm', 'add submodule');
    const target = f.add('with-submodule', path.join(f.projects, 'example-with-submodule'));
    git(target, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q');
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'with-submodule');
    assert.strictEqual(entry.state, worktrees.STATES.UNKNOWN);
    assert.strictEqual(entry.removable, false);
    assert.strictEqual(entry.relocatable, false);
    assert.match(entry.reason, /initialized submodules/);
  } finally { f.cleanup(); }
});

check('unsafe, globbed, relative, and parent-traversing paths are refused', () => {
  for (const candidate of ['relative/path', '/tmp/*', '/tmp/$TARGET', '/tmp/a/../b']) {
    assert.throws(() => worktrees.validateExactPath(candidate), /must be absolute|unresolved|parent traversal/);
  }
});

check('verify-remove refuses primary, unique, dirty, and locked worktrees', () => {
  const f = fixture();
  try {
    const unique = f.add('unique', path.join(f.projects, 'example-unique'));
    fs.writeFileSync(path.join(unique, 'unique.txt'), 'unique\n');
    git(unique, 'add', '.'); git(unique, 'commit', '-qm', 'unique');
    const dirty = f.add('dirty', path.join(f.projects, 'example-dirty'));
    fs.writeFileSync(path.join(dirty, 'x'), 'x');
    const locked = f.add('locked', path.join(f.projects, 'example-locked'));
    git(f.repo, 'worktree', 'lock', locked);
    for (const target of [f.repo, unique, dirty, locked]) {
      assert.throws(() => worktrees.verifyRemove(target, { config: f.config, cwd: f.base }), /refusing/);
    }
  } finally { f.cleanup(); }
});

check('a merged worktree is removed through Git and its branch survives', () => {
  const f = fixture();
  try {
    const target = f.add('merged', path.join(f.projects, 'example-merged'));
    const verified = worktrees.verifyRemove(target, { config: f.config, cwd: f.base });
    assert.strictEqual(verified.state, worktrees.STATES.MERGED);
    const removed = worktrees.removeWorktree(target, { config: f.config, cwd: f.base, approved: true });
    assert.strictEqual(removed.removed, true);
    assert.strictEqual(fs.existsSync(target), false);
    assert.ok(git(f.repo, 'show-ref', '--verify', 'refs/heads/merged'));
  } finally { f.cleanup(); }
});

check('removal refuses when GitHub pull requests cannot be read', () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    const target = f.add('offline-remove', path.join(f.projects, 'example-offline-remove'));
    withGh('exit 1', () => {
      assert.throws(() => worktrees.removeWorktree(target, { config: f.config, cwd: f.base, approved: true }),
        /open pull requests could not be read from GitHub/);
    });
    assert.strictEqual(fs.existsSync(target), true);
  } finally { f.cleanup(); }
});

check('a worktree changed after its check fails the final re-check', () => {
  const f = fixture();
  try {
    const target = f.add('changes-later', path.join(f.projects, 'example-changes-later'));
    const verified = worktrees.verifyRemove(target, { config: f.config, cwd: f.base, skipRemote: true });
    // Another session moves it to a detached HEAD with a commit of its own.
    git(target, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(target, 'later.txt'), 'later\n');
    git(target, 'add', '.'); git(target, 'commit', '-qm', 'later');
    assert.throws(() => worktrees.recheckTarget(verified.repository, verified.path, verified), /changed branch or commit/);
    git(target, 'checkout', '-q', 'changes-later');
    fs.writeFileSync(path.join(target, 'scratch.txt'), 'scratch\n');
    assert.throws(() => worktrees.recheckTarget(verified.repository, verified.path, verified), /changes made after/);
    git(f.repo, 'worktree', 'lock', target);
    assert.throws(() => worktrees.recheckTarget(verified.repository, verified.path, verified), /locked after/);
    git(f.repo, 'worktree', 'unlock', target);
  } finally { f.cleanup(); }
});

check('a move refused by its final re-check creates no destination folder', () => {
  const f = fixture();
  const target = f.add('late-change', path.join(f.projects, 'example-late-change'));
  // Dirty the worktree after the first audit has passed it. check-ref-format
  // runs only in destinationFor, which sits between that audit and the final
  // re-check, so this reaches recheckTarget and nothing earlier.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-late-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$*" in *check-ref-format*) printf 'late\\n' > ${JSON.stringify(path.join(target, 'late.txt'))};; esac
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    assert.throws(() => worktrees.moveWorktree(target, { config: f.config, cwd: f.base, approved: true }), /changes made after/);
    assert.strictEqual(fs.existsSync(path.join(f.config.worktreeRoot, 'example')), false);
    assert.strictEqual(fs.existsSync(target), true);
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});


check('removal approval never carries to a later target', () => {
  const f = fixture();
  try {
    const first = f.add('first', path.join(f.projects, 'example-first'));
    const second = f.add('second', path.join(f.projects, 'example-second'));
    worktrees.removeWorktree(first, { config: f.config, cwd: f.base, approved: true });
    assert.throws(() => worktrees.removeWorktree(second, { config: f.config, cwd: f.base }), /without --approved/);
    assert.strictEqual(fs.existsSync(second), true);
  } finally { f.cleanup(); }
});

check('missing registrations are not visible clutter and prune requires the complete approved set', () => {
  const f = fixture();
  try {
    const first = f.add('missing-one', path.join(f.projects, 'example-missing-one'));
    const second = f.add('missing-two', path.join(f.projects, 'example-missing-two'));
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
    const audit = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true });
    assert.strictEqual(worktrees.summarize([audit]).visible, 0);
    assert.strictEqual(worktrees.summarize([audit]).missing, 2);
    assert.throws(() => worktrees.verifyPrune(f.repo, [first], { config: f.config }), /unapproved/);
    const verified = worktrees.verifyPrune(f.repo, [first, second], { config: f.config });
    assert.deepStrictEqual(verified.paths.map((candidate) => path.basename(candidate)).sort(), ['example-missing-one', 'example-missing-two']);
    const pruned = worktrees.pruneWorktrees(f.repo, [first, second], { config: f.config, approved: true });
    assert.strictEqual(pruned.pruned, true);
    assert.ok(git(f.repo, 'show-ref', '--verify', 'refs/heads/missing-one'));
    assert.ok(git(f.repo, 'show-ref', '--verify', 'refs/heads/missing-two'));
  } finally { f.cleanup(); }
});

check('a present prunable registration is held for repair and cannot be pruned', () => {
  const f = fixture();
  try {
    const target = f.add('present-prunable', path.join(f.projects, 'example-present-prunable'));
    const missing = f.add('missing-with-present-prunable', path.join(f.projects, 'example-missing-with-present-prunable'));
    fs.rmSync(missing, { recursive: true, force: true });
    fs.unlinkSync(path.join(target, '.git'));
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'present-prunable');
    assert.strictEqual(entry.present, true);
    assert.strictEqual(entry.state, worktrees.STATES.UNKNOWN);
    assert.match(entry.reason, /requires repair/);
    assert.throws(() => worktrees.verifyPrune(f.repo, [target], { config: f.config }), /would also clear/);
    assert.throws(() => worktrees.verifyPrune(f.repo, [missing], { config: f.config }), /would also clear/);
    assert.match(git(f.repo, 'worktree', 'list', '--porcelain'), /present-prunable/);
  } finally { f.cleanup(); }
});

check('an inaccessible worktree path is unknown rather than missing', () => {
  const f = fixture();
  const inaccessible = path.join(f.projects, 'inaccessible');
  const originalStat = fs.statSync;
  try {
    fs.statSync = function guardedStat(candidate, ...args) {
      if (path.resolve(candidate) === path.resolve(inaccessible)) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    const entry = worktrees.classifyEntry(f.repo, {
      path: inaccessible, branch: 'inaccessible', head: git(f.repo, 'rev-parse', 'HEAD'),
    }, 1, f.config, { skipRemote: true });
    assert.strictEqual(entry.present, false);
    assert.strictEqual(entry.absenceConfirmed, false);
    assert.strictEqual(entry.state, worktrees.STATES.UNKNOWN);
    assert.match(entry.reason, /EACCES/);
  } finally {
    fs.statSync = originalStat;
    f.cleanup();
  }
});

check('destination preview is identical from a linked or primary checkout', () => {
  const f = fixture();
  try {
    const linked = f.add('existing', path.join(f.base, 'elsewhere', 'linked'));
    const fromPrimary = worktrees.destinationFor(f.repo, 'feature/preview', f.config);
    const fromLinked = worktrees.destinationFor(linked, 'feature/preview', f.config);
    assert.strictEqual(fromLinked, fromPrimary);
  } finally { f.cleanup(); }
});

check('a missing locked registration must be finished before it can be pruned', () => {
  const f = fixture();
  try {
    const target = f.add('missing-locked', path.join(f.projects, 'example-missing-locked'));
    git(f.repo, 'worktree', 'lock', '--reason', 'active session', target);
    fs.rmSync(target, { recursive: true, force: true });

    let audit = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true });
    let entry = audit.worktrees.find((row) => row.branch === 'missing-locked');
    assert.strictEqual(entry.state, worktrees.STATES.LOCKED);
    assert.match(entry.reason, /path is absent/);
    assert.strictEqual(worktrees.summarize([audit]).visible, 0);
    assert.strictEqual(worktrees.summarize([audit]).missing, 1);
    assert.throws(() => worktrees.verifyPrune(f.repo, [target], { config: f.config }), /not currently missing/);
    assert.throws(() => worktrees.finishWorktree(target, {
      config: f.config, cwd: f.base, approved: true,
    }), /requires --repo/);

    const finished = worktrees.finishWorktree(target, {
      repo: f.repo, config: f.config, cwd: f.base, approved: true,
    });
    assert.strictEqual(finished.missing, true);
    audit = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true });
    entry = audit.worktrees.find((row) => row.branch === 'missing-locked');
    assert.strictEqual(entry.state, worktrees.STATES.MISSING);
    assert.strictEqual(worktrees.pruneWorktrees(f.repo, [target], {
      config: f.config, approved: true,
    }).pruned, true);
    assert.ok(git(f.repo, 'show-ref', '--verify', 'refs/heads/missing-locked'));
  } finally { f.cleanup(); }
});

check('a symlink cannot change the <repo>/<task> depth of a destination', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.hidden, { recursive: true });
    fs.symlinkSync(f.hidden, path.join(f.hidden, 'example'));
    assert.throws(() => worktrees.destinationFor(f.repo, 'feature', f.config), /not exactly <worktreeRoot>\/<repo>\/<task>/);
  } finally { f.cleanup(); }
});

check('prune reads what Git would clear from its dry run, and refuses anything unapproved', () => {
  const f = fixture();
  try {
    const one = f.add('gone-one', path.join(f.projects, 'example-gone-one'));
    const two = f.add('gone-two', path.join(f.projects, 'example-gone-two'));
    fs.rmSync(one, { recursive: true, force: true });
    fs.rmSync(two, { recursive: true, force: true });
    assert.deepStrictEqual(worktrees.pruneCandidates(f.repo), [one, two].map((p) => fs.realpathSync.native(path.dirname(p)) + path.sep + path.basename(p)).sort());
    assert.throws(() => worktrees.pruneWorktrees(f.repo, [one], { config: f.config, approved: true }), /unapproved/);
    assert.match(git(f.repo, 'worktree', 'list', '--porcelain'), /gone-one/);
  } finally { f.cleanup(); }
});

check('prune maps a relative-paths registration to its real path', () => {
  // --relative-paths arrived in Git 2.48. Older Git cannot write such a
  // registration, so there is nothing to map.
  const help = spawnSync('git', ['worktree', 'add', '-h'], { encoding: 'utf8' });
  if (!`${help.stdout}${help.stderr}`.includes('relative-paths')) return;
  const f = fixture();
  try {
    const target = path.join(f.projects, 'example gone relative');
    git(f.repo, 'worktree', 'add', '-q', '--relative-paths', '-b', 'gone-relative', target);
    const admin = fs.readdirSync(path.join(f.repo, '.git', 'worktrees'))[0];
    assert.ok(!path.isAbsolute(fs.readFileSync(path.join(f.repo, '.git', 'worktrees', admin, 'gitdir'), 'utf8').trim()));
    fs.rmSync(target, { recursive: true, force: true });
    const expected = path.join(fs.realpathSync.native(f.projects), 'example gone relative');
    assert.deepStrictEqual(worktrees.pruneCandidates(f.repo), [expected]);
  } finally { f.cleanup(); }
});

check('a review tool checkout inside the worktree folder is still held as review-tool', () => {
  const f = fixture();
  try {
    const target = f.add('tool-owned', path.join(f.hidden, '.review', 'tool-owned'));
    const entry = worktrees.auditRepository(f.repo, { config: f.config, skipRemote: true })
      .worktrees.find((row) => row.branch === 'tool-owned');
    assert.strictEqual(entry.location, 'review-tool');
    assert.strictEqual(entry.state, worktrees.STATES.DETACHED_REVIEW);
    assert.strictEqual(entry.removable, false);
    assert.ok(target);
  } finally { f.cleanup(); }
});

check('activate refuses a worktree in a review tool folder', () => {
  const f = fixture();
  try {
    const target = f.add('review-lock', path.join(f.base, '.review', 'review-lock'));
    assert.throws(() => worktrees.activateWorktree(target, { config: f.config, approved: true }), /review tool/);
  } finally { f.cleanup(); }
});

check('one unreadable repository is reported and the rest are still audited', () => {
  const f = fixture();
  const other = path.join(f.projects, 'broken');
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  git(other, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'i');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-broken-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
case "$*" in *broken*worktree\\ list*) exit 1;; esac
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    const audit = worktrees.auditConfigured({ config: f.config, skipRemote: true });
    assert.strictEqual(audit.repositories.length, 1);
    assert.strictEqual(audit.errors.length, 1);
    assert.strictEqual(audit.summary.unreadable, 1);
    assert.match(worktrees.renderAudit(audit), /1 repository was not read and is not counted above/);
    assert.match(worktrees.renderAudit(audit), /Could not read .*broken/);
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

check('a rejected setting is named in the audit, not shown as nothing configured', () => {
  const rendered = worktrees.renderAudit({
    config: { exists: true, valid: false, errors: ['Project root is not an existing directory: /nowhere'] },
    truncated: false, repositories: [], errors: [], summary: worktrees.summarize([]),
  });
  assert.match(rendered, /worktreeLocation setting was rejected: Project root is not an existing directory/);
});

check('canonical destination refuses a symlink escape inside the worktree root', () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(f.hidden, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(f.hidden, 'example'));
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    assert.throws(
      () => worktrees.destinationFor(f.repo, 'feature/symlink', f.config),
      /escaped|symlink/
    );
  } finally { f.cleanup(); }
});

check('branch names that flatten to one task folder are refused, never renamed', () => {
  const f = fixture();
  try {
    const plus = worktrees.destinationFor(f.repo, 'feature/a+b', f.config);
    const unicode = worktrees.destinationFor(f.repo, 'feature/\u96ea', f.config);
    assert.match(plus, /feature-a%2Bb$/);
    assert.match(unicode, /feature-%E9%9B%AA$/);
    const slashed = worktrees.destinationFor(f.repo, 'feature/a-b', f.config);
    assert.strictEqual(worktrees.destinationFor(f.repo, 'feature-a-b', f.config), slashed);
    worktrees.createWorktree(f.repo, 'feature/a-b', { config: f.config, approved: true, base: 'main' });
    assert.throws(
      () => worktrees.createWorktree(f.repo, 'feature-a-b', { config: f.config, approved: true, base: 'main' }),
      /destination already exists/
    );
  } finally { f.cleanup(); }
});

check('a clean branch can move to its canonical path and is locked there', () => {
  const f = fixture();
  try {
    const target = f.add('feature/move-me', path.join(f.projects, 'example-move'));
    fs.writeFileSync(path.join(target, 'unique.txt'), 'unique\n');
    git(target, 'add', '.'); git(target, 'commit', '-qm', 'unique');
    const moved = worktrees.moveWorktree(target, { config: f.config, cwd: f.base, approved: true });
    assert.strictEqual(moved.moved, true);
    assert.strictEqual(moved.locked, true);
    assert.ok(configModule.contains(f.config.worktreeRoot, moved.path));
    assert.strictEqual(fs.existsSync(target), false);
    assert.strictEqual(fs.existsSync(moved.path), true);
    assert.match(git(f.repo, 'worktree', 'list', '--porcelain'), /locked git-hygiene: active agent work/);
  } finally { f.cleanup(); }
});

check('relocation does not require GitHub availability', () => {
  const f = fixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-no-gh-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nexec "${realGit}" "$@"\n`);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const before = process.env.PATH;
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    const target = f.add('feature/offline-move', path.join(f.projects, 'example-offline'));
    fs.writeFileSync(path.join(target, 'unique.txt'), 'unique\n');
    git(target, 'add', '.'); git(target, 'commit', '-qm', 'unique');
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    const moved = worktrees.moveWorktree(target, { config: f.config, cwd: f.base, approved: true });
    assert.strictEqual(moved.moved, true);
    assert.ok(configModule.contains(f.config.worktreeRoot, moved.path));
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

check('a failed relocation lock moves the worktree back to its approved source', () => {
  const f = fixture();
  const bin = failingLockGit();
  const before = process.env.PATH;
  try {
    const target = f.add('feature/rollback-move', path.join(f.projects, 'example-rollback'));
    fs.writeFileSync(path.join(target, 'unique.txt'), 'unique\n');
    git(target, 'add', '.'); git(target, 'commit', '-qm', 'unique');
    const destination = worktrees.destinationFor(f.repo, 'feature/rollback-move', f.config);
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    assert.throws(
      () => worktrees.moveWorktree(target, { config: f.config, cwd: f.base, approved: true }),
      /rolled back/
    );
    assert.strictEqual(fs.existsSync(target), true);
    assert.strictEqual(fs.existsSync(destination), false);
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

check('create refuses an unapproved new branch, then creates and locks the approved one', () => {
  const f = fixture();
  try {
    assert.throws(() => worktrees.createWorktree(f.repo, 'feature/new', { config: f.config }), /--approved/);
    const created = worktrees.createWorktree(f.repo, 'feature/new', { config: f.config, approved: true, base: 'main' });
    assert.strictEqual(created.branchCreated, true);
    assert.strictEqual(created.locked, true);
    assert.ok(configModule.contains(f.config.worktreeRoot, created.path));
    assert.match(created.path.replace(/\\/g, '/'), /\/Worktrees\/example\/feature-new$/);
  } finally { f.cleanup(); }
});

check('create starts a remote-only branch at its remote tip', () => {
  const f = fixture();
  const remote = path.join(f.base, 'origin.git');
  try {
    execFileSync('git', ['init', '-q', '--bare', remote]);
    git(f.repo, 'remote', 'add', 'origin', remote);
    git(f.repo, 'checkout', '-qb', 'remote-only');
    fs.writeFileSync(path.join(f.repo, 'remote.txt'), 'remote\n');
    git(f.repo, 'add', 'remote.txt');
    git(f.repo, 'commit', '-qm', 'remote work');
    git(f.repo, 'push', '-q', 'origin', 'remote-only');
    const remoteTip = git(f.repo, 'rev-parse', 'remote-only');
    git(f.repo, 'checkout', '-q', 'main');
    git(f.repo, 'branch', '-D', 'remote-only');

    const created = worktrees.createWorktree(f.repo, 'remote-only', {
      config: f.config, approved: true,
    });
    assert.strictEqual(git(created.path, 'rev-parse', 'HEAD'), remoteTip);
    assert.strictEqual(git(created.path, 'rev-parse', '@{upstream}'), remoteTip);
  } finally { f.cleanup(); }
});

check('relocation is not offered until setup exists', () => {
  const f = fixture();
  try {
    const target = f.add('not-configured', path.join(f.projects, 'example-not-configured'));
    const noConfig = { exists: false, valid: true, errors: [], projectRoots: [], worktreeRoot: null };
    const entry = worktrees.auditRepository(f.repo, { config: noConfig, skipRemote: true })
      .worktrees.find((row) => row.branch === 'not-configured');
    assert.strictEqual(entry.relocatable, false);
    assert.throws(() => worktrees.moveWorktree(target, {
      config: noConfig, cwd: f.base, approved: true,
    }), /refusing to move/);
  } finally { f.cleanup(); }
});

check('create validates a new branch base before making any directories', () => {
  const f = fixture();
  try {
    const unsafe = worktrees.destinationFor(f.repo, 'feature/unsafe-base', f.config);
    assert.throws(
      () => worktrees.createWorktree(f.repo, 'feature/unsafe-base', {
        config: f.config, approved: true, base: '--no-checkout',
      }),
      /unsafe base revision/
    );
    assert.strictEqual(fs.existsSync(path.dirname(unsafe)), false);

    const unknown = worktrees.destinationFor(f.repo, 'feature/unknown-base', f.config);
    assert.throws(
      () => worktrees.createWorktree(f.repo, 'feature/unknown-base', {
        config: f.config, approved: true, base: 'does-not-exist',
      }),
      /unknown base revision/
    );
    assert.strictEqual(fs.existsSync(path.dirname(unknown)), false);
  } finally { f.cleanup(); }
});

check('activate locks one exact existing non-primary worktree', () => {
  const f = fixture();
  try {
    const target = f.add('activate-me', path.join(f.projects, 'example-activate'));
    assert.throws(() => worktrees.activateWorktree(target, {
      config: f.config, cwd: f.base,
    }), /without --approved/);
    const activated = worktrees.activateWorktree(target, {
      config: f.config, cwd: f.base, approved: true,
    });
    assert.strictEqual(activated.locked, true);
    assert.match(git(f.repo, 'worktree', 'list', '--porcelain'), /locked git-hygiene: active agent work/);
    assert.throws(() => worktrees.activateWorktree(f.repo, {
      config: f.config, cwd: f.base, approved: true,
    }), /primary checkout/);
  } finally { f.cleanup(); }
});

check('a failed creation lock removes both the checkout and its newly created branch', () => {
  const f = fixture();
  const bin = failingLockGit();
  const before = process.env.PATH;
  try {
    const destination = worktrees.destinationFor(f.repo, 'feature/rollback-create', f.config);
    process.env.PATH = `${bin}${path.delimiter}${before}`;
    assert.throws(
      () => worktrees.createWorktree(f.repo, 'feature/rollback-create', {
        config: f.config, approved: true, base: 'main',
      }),
      /rolled back/
    );
    assert.strictEqual(fs.existsSync(destination), false);
    assert.throws(() => git(f.repo, 'show-ref', '--verify', 'refs/heads/feature/rollback-create'));
  } finally {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
    f.cleanup();
  }
});

check('finish refuses dirty or current worktrees and unlocks a clean inactive one', () => {
  const f = fixture();
  try {
    const target = f.add('finish-me', path.join(f.hidden, 'local', 'example', 'finish-me'));
    git(f.repo, 'worktree', 'lock', '--reason', 'active', target);
    assert.throws(() => worktrees.finishWorktree(target, { cwd: target, approved: true }), /current working directory/);
    const unregistered = path.join(f.base, 'unregistered');
    fs.mkdirSync(unregistered);
    assert.throws(() => worktrees.finishWorktree(unregistered, {
      repo: f.repo, cwd: f.base, approved: true,
    }), /not a registered worktree/);
    fs.writeFileSync(path.join(target, 'dirty.txt'), 'dirty\n');
    assert.throws(() => worktrees.finishWorktree(target, { cwd: f.base, approved: true }), /dirty/);
    fs.unlinkSync(path.join(target, 'dirty.txt'));
    const finished = worktrees.finishWorktree(target, { cwd: f.base, approved: true });
    assert.strictEqual(finished.locked, false);
    assert.doesNotMatch(git(f.repo, 'worktree', 'list', '--porcelain'), /locked active/);
  } finally { f.cleanup(); }
});

check('configured discovery finds primary repositories without descending into working trees', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.repo, 'nested'), { recursive: true });
    execFileSync('git', ['init', '-q', path.join(f.repo, 'nested')]);
    const found = worktrees.discoverRepositories([f.projects]);
    assert.deepStrictEqual(found.repositories.map((repo) => path.resolve(repo)), [path.resolve(f.repo)]);
    const exact = worktrees.discoverRepositories([f.repo]);
    assert.deepStrictEqual(exact.repositories.map((repo) => path.resolve(repo)), [path.resolve(f.repo)]);
  } finally { f.cleanup(); }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
