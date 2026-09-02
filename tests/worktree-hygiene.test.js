#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'git-hygiene');
const configModule = require(path.join(ROOT, 'scripts', 'worktree-config'));
const worktrees = require(path.join(ROOT, 'scripts', 'worktrees'));

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
  const hidden = path.join(base, '.worktrees');
  const repo = path.join(projects, 'example');
  fs.mkdirSync(projects, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const checked = configModule.validate({
    projectRoots: [projects], worktreeRoot: hidden,
    enforceWorktreeRoot: true, sessionNotice: true,
  });
  const config = {
    ...checked.config,
    exists: true,
    valid: true,
    errors: [],
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

check('configuration normalizes home paths and rejects overlapping visible and hidden roots', () => {
  const good = configModule.validate({
    projectRoots: ['~/Projects'], worktreeRoot: '~/.worktrees',
    enforceWorktreeRoot: true, sessionNotice: true,
  });
  assert.strictEqual(good.valid, true, good.errors.join('; '));
  assert.ok(path.isAbsolute(good.config.projectRoots[0]));
  const bad = configModule.validate({
    projectRoots: ['~/Projects'], worktreeRoot: '~/Projects/worktrees',
    enforceWorktreeRoot: true, sessionNotice: true,
  });
  assert.strictEqual(bad.valid, false);
  assert.match(bad.errors.join(' '), /must not overlap/);
  const reverse = configModule.validate({
    projectRoots: ['~/.worktrees/projects'], worktreeRoot: '~/.worktrees',
    enforceWorktreeRoot: true, sessionNotice: true,
  });
  assert.strictEqual(reverse.valid, false);
});

check('configuration writes atomically with private permissions and reads back', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-config-'));
  const projects = path.join(base, 'Projects');
  const hidden = path.join(base, '.worktrees');
  const file = path.join(base, '.claude', 'git-hygiene.config.json');
  fs.mkdirSync(projects, { recursive: true });
  const before = process.env.GIT_HYGIENE_CONFIG;
  process.env.GIT_HYGIENE_CONFIG = file;
  try {
    const written = configModule.writeConfig({
      projectRoots: [projects], worktreeRoot: hidden,
      enforceWorktreeRoot: true, sessionNotice: true,
    });
    assert.strictEqual(written.valid, true);
    assert.strictEqual(written.exists, true);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(configModule.loadConfig().projectRoots, [fs.realpathSync.native(projects)]);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).sort(), ['git-hygiene.config.json']);
  } finally {
    if (before === undefined) delete process.env.GIT_HYGIENE_CONFIG;
    else process.env.GIT_HYGIENE_CONFIG = before;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

check('setup proposed from a hidden linked checkout uses the primary project root', () => {
  const f = fixture();
  try {
    const linked = f.add('setup-linked', path.join(f.hidden, 'local', 'example', 'setup-linked'));
    const proposed = configModule.propose(linked, f.base);
    assert.deepStrictEqual(proposed.projectRoots, [fs.realpathSync.native(f.projects)]);
    assert.strictEqual(proposed.worktreeRoot, fs.realpathSync.native(f.hidden));
    assert.strictEqual(configModule.validate(proposed).valid, true);
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

check('a GitHub open pull request wins over local merge evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hygiene-gh-'));
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' \'[{"number":7,"state":"OPEN","mergedAt":null,"headRefOid":"abc","baseRefName":"main"}]\'\n');
  fs.chmodSync(gh, 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  try {
    const evidence = worktrees.pullRequestEvidence('.', {
      github: true, owner: 'owner', repository: 'repo',
    }, 'feature', 'abc', 'main');
    assert.strictEqual(evidence.available, true);
    assert.strictEqual(evidence.open, true);
  } finally {
    process.env.PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('an unavailable GitHub lookup is unknown, never merged', () => {
  const before = process.env.PATH;
  process.env.PATH = '';
  try {
    const evidence = worktrees.pullRequestEvidence('.', {
      github: true, owner: 'owner', repository: 'repo',
    }, 'feature', 'abc', 'main');
    assert.strictEqual(evidence.available, false);
    assert.strictEqual(evidence.merged, false);
  } finally { process.env.PATH = before; }
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

check('non-GitHub destinations include the host and full remote namespace', () => {
  const f = fixture();
  try {
    git(f.repo, 'remote', 'add', 'origin', 'https://gitlab.example.com/group/team/example.git');
    const target = worktrees.destinationFor(f.repo, 'feature/remote', f.config);
    assert.match(target.replace(/\\/g, '/'), /\/gitlab\.example\.com\/group\/team\/example\/feature\/remote$/);
    git(f.repo, 'remote', 'set-url', 'origin', 'https://other.example.com/group/team/example.git');
    assert.notStrictEqual(worktrees.destinationFor(f.repo, 'feature/remote', f.config), target);
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

check('canonical destination refuses a symlink escape inside the hidden root', () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(f.hidden, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(f.hidden, 'owner'));
    git(f.repo, 'remote', 'add', 'origin', 'https://github.com/owner/example.git');
    assert.throws(
      () => worktrees.destinationFor(f.repo, 'feature/symlink', f.config),
      /escaped|symlink/
    );
  } finally { f.cleanup(); }
});

check('canonical destinations preserve distinct valid branch names', () => {
  const f = fixture();
  try {
    const plus = worktrees.destinationFor(f.repo, 'feature/a+b', f.config);
    const dash = worktrees.destinationFor(f.repo, 'feature/a-b', f.config);
    const unicode = worktrees.destinationFor(f.repo, 'feature/\u96ea', f.config);
    assert.notStrictEqual(plus, dash);
    assert.match(plus, /a%2Bb$/);
    assert.match(dash, /a-b$/);
    assert.match(unicode, /%E9%9B%AA$/);
  } finally { f.cleanup(); }
});

check('a clean branch can move to its canonical hidden path and is locked there', () => {
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
    assert.match(created.path.replace(/\\/g, '/'), /\/local\/example-[a-f0-9]{10}\/feature\/new$/);
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
    const noConfig = { ...configModule.defaults(), exists: false, valid: true, errors: [] };
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
