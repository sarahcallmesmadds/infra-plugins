#!/usr/bin/env node
// Exercise plugin-version-drift.test.js against disposable repositories so its
// answer does not depend on whatever happens to be edited in this checkout.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CHECK = path.join(__dirname, 'plugin-version-drift.test.js');
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const GIT_SHIM = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const target = process.env.PLUGIN_VERSION_DRIFT_FAKE_DIFF_TARGET || 'worktree';
const targetMatches = target === 'index' ? args.includes('--cached') : !args.includes('--cached');
if (args.includes('diff') && args.includes('--quiet') && targetMatches) {
  if (process.env.PLUGIN_VERSION_DRIFT_FAKE_DIFF === 'exit') {
    process.stderr.write('synthetic git diff failure\\n');
    process.exit(2);
  }
  if (process.env.PLUGIN_VERSION_DRIFT_FAKE_DIFF === 'signal') {
    process.kill(process.pid, 'SIGTERM');
  }
}
const result = spawnSync(process.env.PLUGIN_VERSION_DRIFT_REAL_GIT, args, { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status === null ? 1 : result.status);
`;

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}`);
    console.log(`        ${error.message}`);
  }
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-version-drift-'));
  const gitArgs = (...args) => [
    '-C', repo,
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=Test',
    ...args,
  ];
  const git = (...args) => execFileSync('git', gitArgs(...args), {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const gitStatus = (...args) => spawnSync('git', gitArgs(...args), {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).status;
  const write = (relative, contents) => {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };

  git('init', '-q', '-b', 'main');
  write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  write('plugins/demo/README.md', '# Demo\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  git('checkout', '-qb', 'feature');

  return {
    repo,
    git,
    gitStatus,
    write,
    squashFeature() {
      const featureTip = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('merge', '--squash', 'feature');
      git('commit', '-qm', 'squash feature');
      git('update-ref', 'refs/remotes/origin/main', 'main');
      git('checkout', '-q', 'feature');
      return featureTip;
    },
    run({ gitDiffFailure = null, gitDiffTarget = 'worktree' } = {}) {
      const env = { ...process.env, PLUGIN_VERSION_DRIFT_REPO: repo };
      if (gitDiffFailure) {
        const shim = path.join(repo, '.test-bin', 'git');
        fs.mkdirSync(path.dirname(shim), { recursive: true });
        fs.writeFileSync(shim, GIT_SHIM);
        fs.chmodSync(shim, 0o755);
        env.PATH = `${path.dirname(shim)}${path.delimiter}${env.PATH}`;
        env.PLUGIN_VERSION_DRIFT_REAL_GIT = REAL_GIT;
        env.PLUGIN_VERSION_DRIFT_FAKE_DIFF = gitDiffFailure;
        env.PLUGIN_VERSION_DRIFT_FAKE_DIFF_TARGET = gitDiffTarget;
      }
      const result = spawnSync(process.execPath, [CHECK], {
        encoding: 'utf8',
        env,
      });
      return {
        status: result.status,
        output: `${result.stdout || ''}${result.stderr || ''}`,
      };
    },
    remove() {
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

function withFixture(fn) {
  const f = fixture();
  try {
    fn(f);
  } finally {
    f.remove();
  }
}

function assertMissingBump(result, file) {
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /version is still 1\.0\.0/, result.output);
  assert.match(result.output, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), result.output);
}

function commitFeature(f, version = '1.0.1') {
  f.write('plugins/demo/README.md', '# Demo\nFeature content.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', `{\n  "name": "demo",\n  "version": "${version}"\n}\n`);
  f.git('add', '.');
  f.git('commit', '-qm', 'change plugin');
}

check('a clean branch passes', () => withFixture((f) => {
  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /no plugin changed/, result.output);
}));

check('an unstaged plugin edit fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('a staged plugin edit fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.git('add', 'plugins/demo/README.md');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('a staged edit hidden by a restored working file still fails', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nStaged content.\n');
  f.git('add', 'plugins/demo/README.md');
  f.write('plugins/demo/README.md', '# Demo\n');
  assert.match(f.git('status', '--short'), /^MM plugins\/demo\/README\.md$/);
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('a valid staged bump passes when the working files are restored', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nStaged content.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');
  f.git('add', 'plugins/demo');
  f.write('plugins/demo/README.md', '# Demo\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
  assert.match(f.git('status', '--short'), /MM plugins\/demo\/\.claude-plugin\/plugin\.json/);
  assert.match(f.git('status', '--short'), /MM plugins\/demo\/README\.md/);

  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /ok    demo changed, so its version moved/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
  assert.match(result.output, /1 checks, 0 failed/, result.output);
}));

check('an unreadable staged manifest fails even when the working version is valid', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', 'not json\n');
  f.git('add', 'plugins/demo');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /staged snapshot has no readable version/, result.output);
  assert.doesNotMatch(result.output, /staged snapshot changed, so its version moved\n\n2 checks, 0 failed/, result.output);
}));

check('a staged manifest without a version fails when the working version is valid', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo"\n}\n');
  f.git('add', 'plugins/demo');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /staged snapshot has no readable version/, result.output);
  assert.doesNotMatch(result.output, /undefined could not be compared/, result.output);
}));

check('an untracked plugin file fails before commit', () => withFixture((f) => {
  f.write('plugins/demo/new.js', 'module.exports = {};\n');
  assertMissingBump(f.run(), 'plugins/demo/new.js');
}));

check('a worktree version bump satisfies a worktree edit', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');
  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /1 checks, 0 failed/, result.output);
}));

check('a committed plugin edit without a bump still fails', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');
  f.git('add', 'plugins/demo/README.md');
  f.git('commit', '-qm', 'change plugin');
  assertMissingBump(f.run(), 'plugins/demo/README.md');
}));

check('a squash-merged branch whose plugin matches main is skipped', () => withFixture((f) => {
  commitFeature(f);
  const featureTip = f.squashFeature();
  assert.strictEqual(
    f.gitStatus('merge-base', '--is-ancestor', featureTip, 'origin/main'),
    1,
    'the fixture used an ancestry merge instead of a squash merge'
  );
  assert.strictEqual(
    f.git('diff', '--name-only', 'origin/main', '--', 'plugins/demo'),
    '',
    'the feature plugin does not match the squash-merged plugin on origin/main'
  );

  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /SKIP  demo changed, but its files already match origin\/main at 1\.0\.1/, result.output);
  assert.doesNotMatch(result.output, /Pick a number above/, result.output);
}));

check('a matching squash merge with changed unorderable versions is skipped', () => withFixture((f) => {
  f.git('checkout', '-q', 'main');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "release-a"\n}\n');
  f.git('add', 'plugins/demo/.claude-plugin/plugin.json');
  f.git('commit', '-qm', 'use an unorderable baseline version');
  f.git('branch', '-f', 'feature', 'main');
  f.git('checkout', '-q', 'feature');
  f.write('plugins/demo/README.md', '# Demo\nFeature content.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "release-b"\n}\n');
  f.git('add', 'plugins/demo');
  f.git('commit', '-qm', 'change plugin with unorderable version');
  f.squashFeature();

  const result = f.run();
  assert.strictEqual(result.status, 0, result.output);
  assert.match(result.output, /SKIP  demo changed, but its files already match origin\/main at release-b/, result.output);
  assert.doesNotMatch(result.output, /Pick a number above/, result.output);
}));

check('a squash merge without a version bump still fails', () => withFixture((f) => {
  commitFeature(f, '1.0.0');
  f.squashFeature();

  const result = f.run();
  assertMissingBump(result, 'plugins/demo/README.md');
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('a squash merge fails when main consumed its version first', () => withFixture((f) => {
  commitFeature(f);
  f.git('checkout', '-q', 'main');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');
  f.git('add', 'plugins/demo/.claude-plugin/plugin.json');
  f.git('commit', '-qm', 'release version before feature content');
  f.git('merge', '--squash', 'feature');
  f.git('commit', '-qm', 'squash feature without another bump');
  f.git('update-ref', 'refs/remotes/origin/main', 'main');
  f.git('checkout', '-q', 'feature');

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /origin\/main has already released/, result.output);
  assert.match(result.output, /Pick a number above 1\.0\.1/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('staged content hidden after a squash merge still fails', () => withFixture((f) => {
  commitFeature(f);
  f.squashFeature();
  f.write('plugins/demo/new.js', 'module.exports = {};\n');
  f.git('add', 'plugins/demo/new.js');
  fs.rmSync(path.join(f.repo, 'plugins/demo/new.js'));
  assert.match(f.git('status', '--short'), /^AD plugins\/demo\/new\.js$/);

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /plugins\/demo\/new\.js/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('same-version content that differs from main still fails', () => withFixture((f) => {
  commitFeature(f);
  f.git('checkout', '-q', 'main');
  f.write('plugins/demo/README.md', '# Demo\nDifferent content on main.\n');
  f.write('plugins/demo/.claude-plugin/plugin.json', '{\n  "name": "demo",\n  "version": "1.0.1"\n}\n');
  f.git('add', '.');
  f.git('commit', '-qm', 'release different content');
  f.git('update-ref', 'refs/remotes/origin/main', 'main');
  f.git('checkout', '-q', 'feature');

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /origin\/main has already released/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('an untracked file after the squash merge still fails', () => withFixture((f) => {
  commitFeature(f);
  f.squashFeature();
  f.write('plugins/demo/new.js', 'module.exports = {};\n');

  const result = f.run();
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /plugins\/demo\/new\.js/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('a Git diff failure fails the comparison instead of skipping', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');

  const result = f.run({ gitDiffFailure: 'exit' });
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /could not compare plugins\/demo\/ working snapshot with main/, result.output);
  assert.match(result.output, /synthetic git diff failure/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

check('a signal-terminated Git diff names the signal and fails', () => withFixture((f) => {
  f.write('plugins/demo/README.md', '# Demo\nChanged.\n');

  const result = f.run({ gitDiffFailure: 'signal' });
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /git diff terminated by SIGTERM/, result.output);
  assert.doesNotMatch(result.output, /exited null|SKIP/, result.output);
}));

check('a signal-terminated cached-index diff names the signal and fails', () => withFixture((f) => {
  commitFeature(f);
  f.squashFeature();

  const result = f.run({ gitDiffFailure: 'signal', gitDiffTarget: 'index' });
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /git diff --cached terminated by SIGTERM/, result.output);
  assert.doesNotMatch(result.output, /exited null|SKIP/, result.output);
}));

check('a cached-index Git diff failure fails the comparison', () => withFixture((f) => {
  commitFeature(f);
  f.squashFeature();

  const result = f.run({ gitDiffFailure: 'exit', gitDiffTarget: 'index' });
  assert.strictEqual(result.status, 1, result.output);
  assert.match(result.output, /staged snapshot/, result.output);
  assert.match(result.output, /synthetic git diff failure/, result.output);
  assert.doesNotMatch(result.output, /SKIP/, result.output);
}));

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
