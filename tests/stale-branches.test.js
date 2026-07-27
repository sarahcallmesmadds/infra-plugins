#!/usr/bin/env node
// Regression tests for the stale-branch classifier and the command that prints it.
//
// Run: node tests/stale-branches.test.js
//
// The row that matters most is the one where the merge state is unknown. A
// branch we cannot compare must land in "keep". Treating unknown as zero is the
// single bug in this plugin that would destroy work rather than annoy someone,
// so it is pinned here alongside the ordinary cases.

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'git-hygiene');
const { classify, localDeleteCommand, remoteDeleteCommand } = require(path.join(ROOT, 'scripts', 'classify.js'));
const CLI = path.join(ROOT, 'scripts', 'cli.js');

const NOW = Date.parse('2026-07-27T00:00:00Z');
const d = (days) => new Date(NOW - days * 86400000).toISOString();

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

// ---------------------------------------------------- classification ----

const CASES = [
  // [branch, expectedSafe, description]
  [{ name: 'merged-old', lastCommitDate: d(140), aheadBy: 0, isDefault: false }, true,
    'fully merged, old — the whole point of the plugin'],
  [{ name: 'merged-today', lastCommitDate: d(0), aheadBy: 0, isDefault: false }, true,
    'fully merged and recent is still safe, age is not the test'],

  // --- must never be offered for deletion --------------------------------
  [{ name: 'has-work', lastCommitDate: d(90), aheadBy: 3, isDefault: false }, false,
    'three unmerged commits, old — old does NOT mean deletable'],
  [{ name: 'one-commit', lastCommitDate: d(200), aheadBy: 1, isDefault: false }, false,
    'a single unmerged commit is still work'],
  [{ name: 'unknown', lastCommitDate: d(90), aheadBy: null, isDefault: false }, false,
    'merge state unknown must fail into keep, never into safe'],
  [{ name: 'undef', lastCommitDate: d(90), isDefault: false }, false,
    'a missing aheadBy field behaves like null'],
  [{ name: 'main', lastCommitDate: d(0), aheadBy: 0, isDefault: true }, false,
    'the default branch is never deletable'],
  [{ name: 'master', lastCommitDate: d(400), aheadBy: 0, isDefault: false }, false,
    'a protected name is never deletable even when not flagged as default'],
  [{ name: 'develop', lastCommitDate: d(400), aheadBy: 0, isDefault: false }, false,
    'develop is protected by default'],
  [{ name: 'checked-out', lastCommitDate: d(10), aheadBy: 0, isDefault: false, isCurrent: true }, false,
    'never delete the branch you are standing on'],
  [{ name: 'in-review', lastCommitDate: d(10), aheadBy: 0, isDefault: false, hasOpenPR: true }, false,
    'an open pull request keeps a branch alive'],
];

process.stdout.write('classification\n');
for (const [branch, expected, desc] of CASES) {
  check(desc, () => {
    const r = classify([branch], {}, NOW);
    const got = r.safe.length === 1;
    assert.strictEqual(got, expected,
      `expected safeToDelete=${expected} for ${branch.name}, got ${got} (reasons: ${r.all[0].keepReasons.join(', ') || 'none'})`);
  });
}

check('stale flag is independent of deletability', () => {
  const r = classify([
    { name: 'old-unmerged', lastCommitDate: d(140), aheadBy: 2, isDefault: false },
  ], {}, NOW);
  assert.strictEqual(r.all[0].stale, true, 'should be flagged stale');
  assert.strictEqual(r.all[0].safeToDelete, false, 'stale must not imply safe');
});

check('a branch with no date is not crashed on and is not stale', () => {
  const r = classify([{ name: 'x', lastCommitDate: undefined, aheadBy: 0, isDefault: false }], {}, NOW);
  assert.strictEqual(r.all[0].ageDays, null);
  assert.strictEqual(r.all[0].stale, false);
  assert.strictEqual(r.all[0].safeToDelete, true, 'unknown age does not block deletion, unknown merge state does');
});

check('sorting the real 22 splits 12 safe / 10 keep', () => {
  const branches = [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `merged-${i}`, lastCommitDate: d(100), aheadBy: 0, isDefault: false })),
    ...Array.from({ length: 10 }, (_, i) => ({ name: `work-${i}`, lastCommitDate: d(100), aheadBy: 1 + (i % 3), isDefault: false })),
  ];
  const r = classify(branches, {}, NOW);
  assert.strictEqual(r.safe.length, 12);
  assert.strictEqual(r.keep.length, 10);
});

// ------------------------------------------------------ delete commands ----

process.stdout.write('delete commands\n');

check('local delete is always the safe lowercase -d', () => {
  assert.deepStrictEqual(localDeleteCommand('feature'), ['git', 'branch', '-d', 'feature']);
});

check('no input can turn the local delete into -D', () => {
  // -D is what removes git's own merge check. There must be no path to it.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'classify.js'), 'utf8');
  assert.ok(!/'-D'|"-D"|branch -D/.test(src), 'classify.js must not contain a -D form anywhere');
});

check('a branch name that looks like a flag is refused', () => {
  assert.throws(() => localDeleteCommand('--all'), /refusing/);
  assert.throws(() => remoteDeleteCommand('owner/repo', '--all'), /refusing/);
});

check('an empty branch name is refused', () => {
  assert.throws(() => localDeleteCommand(''), /refusing/);
  assert.throws(() => localDeleteCommand('   '), /refusing/);
});

check('a malformed repo is refused before any API call is built', () => {
  assert.throws(() => remoteDeleteCommand('not-a-repo', 'x'), /refusing/);
  assert.throws(() => remoteDeleteCommand('a/b/c', 'x'), /refusing/);
});

check('remote delete targets the exact ref', () => {
  assert.deepStrictEqual(remoteDeleteCommand('sarahcallmesmadds/plugins', 'old'),
    ['gh', 'api', '-X', 'DELETE', 'repos/sarahcallmesmadds/plugins/git/refs/heads/old']);
});

// ------------------------------------------------ the actual command ----
//
// Driving the CLI as a subprocess, because every real bug so far has been in a
// printing path that unit tests never executed.

process.stdout.write('the command itself\n');

const snapshot = {
  where: 'sarahcallmesmadds/example',
  branches: [
    { name: 'main', lastCommitDate: d(0), aheadBy: 0, isDefault: true },
    { name: 'merged-in-march', lastCommitDate: d(144), aheadBy: 0, isDefault: false },
    { name: 'private-workshop-page', lastCommitDate: d(99), aheadBy: 3, isDefault: false },
    { name: 'cannot-compare', lastCommitDate: d(50), aheadBy: null, isDefault: false },
  ],
};
const fixture = path.join(os.tmpdir(), `stale-branches-fixture-${process.pid}.json`);
fs.writeFileSync(fixture, JSON.stringify(snapshot));

function runCli(args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
}

check('text output names the safe branch and no other', () => {
  const out = runCli(['--input', fixture, '--now', '2026-07-27']);
  assert.ok(/Safe to delete \(1\)/.test(out), `expected one safe branch:\n${out}`);
  assert.ok(/merged-in-march/.test(out), 'the merged branch should be listed as safe');
  const safeSection = out.split('Keep (')[0];
  assert.ok(!/private-workshop-page/.test(safeSection), 'a branch with work must never appear under safe');
  assert.ok(!/cannot-compare/.test(safeSection), 'an uncomparable branch must never appear under safe');
});

check('the reason for keeping each branch is spelled out, not left blank', () => {
  const out = runCli(['--input', fixture, '--now', '2026-07-27']);
  assert.ok(/private-workshop-page.*3 commits not in the default branch/.test(out),
    `expected the commit count in the reason:\n${out}`);
  assert.ok(/cannot-compare.*could not work out whether it is merged/.test(out),
    `expected the unknown case to explain itself:\n${out}`);
  // The bug that shipped in guardrails: a reason rendering as the word undefined.
  assert.ok(!/undefined/.test(out), `output must never contain the word undefined:\n${out}`);
});

check('the default branch is never printed in either list', () => {
  const out = runCli(['--input', fixture, '--now', '2026-07-27']);
  assert.ok(!/^\s+main\s/m.test(out), `main must not be listed:\n${out}`);
});

check('ages are printed in days, and pluralised', () => {
  const out = runCli(['--input', fixture, '--now', '2026-07-27']);
  assert.ok(/144 days old/.test(out), `expected an age in days:\n${out}`);
  assert.ok(!/1 days old/.test(out), 'must not say "1 days old"');
});

check('--json emits parseable output with the same split', () => {
  const out = runCli(['--input', fixture, '--json', '--now', '2026-07-27']);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.safe.length, 1);
  assert.strictEqual(parsed.safe[0].name, 'merged-in-march');
  assert.strictEqual(parsed.keep.length, 3);
});

check('outside a repo with no --repo, it explains rather than reporting nothing', () => {
  let stderr = '';
  try {
    execFileSync('node', [CLI], { cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    stderr = e.stderr || '';
  }
  assert.ok(/Not inside a git repository/.test(stderr),
    `expected a clear message, got:\n${stderr}`);
  // Reporting "0 stale branches" when it never looked is the failure mode here.
  assert.ok(!/Safe to delete \(0\)/.test(stderr), 'must not imply it looked and found nothing');
});

fs.unlinkSync(fixture);

process.stdout.write(failures === 0 ? '\nAll stale-branch tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
