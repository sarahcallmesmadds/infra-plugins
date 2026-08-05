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

// ------------------------------------------------------- gh pagination ----
//
// `gh api --paginate --jq '[.[].name]'` applies the filter to each page
// separately, so a repository with more than one page emits several complete
// JSON arrays back to back. That is not parseable, and the natural `|| []`
// fallback turns a repo full of branches into "nothing to clean up". A silent
// false negative in a tool whose only job is noticing forgotten things.

process.stdout.write('gh pagination\n');

const collect = require(path.join(ROOT, 'scripts', 'collect.js'));

check('multi-page scalar output splits into every value, not the first page only', () => {
  // What `--jq '.[].name'` gives back across three pages.
  const out = ['a', 'b', 'c'].join('\n') + '\n' + ['d', 'e'].join('\n');
  assert.deepStrictEqual(collect.toLines(out), ['a', 'b', 'c', 'd', 'e']);
});

check('blank lines and stray whitespace between pages are dropped', () => {
  assert.deepStrictEqual(collect.toLines('a\n\n  b  \n\n\nc\n'), ['a', 'b', 'c']);
});

check('a failed command stays null and never becomes an empty list', () => {
  // This is the distinction the bug turned on. [] means "looked, found none".
  // null means "could not look". Collapsing the second into the first reports a
  // clean repository that was never actually read.
  assert.strictEqual(collect.toLines(null), null);
  assert.notDeepStrictEqual(collect.toLines(null), []);
});

check('no --paginate call wraps its jq filter in an array', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  const paginated = src.split('\n').filter((l) => l.includes("'--paginate'"));
  assert.ok(paginated.length > 0, 'expected at least one paginated call to check');
  for (const line of paginated) {
    assert.ok(!/\[\s*\.\[\]/.test(line),
      `a --paginate call must request scalars, not an array, or pages concatenate into invalid JSON:\n  ${line.trim()}`);
  }
});

check('branch and PR listings both ask for a full page size', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/branches\?per_page=100/.test(src), 'branch listing should request 100 per page');
  assert.ok(/pulls\?state=open&per_page=100/.test(src), 'PR listing should request 100 per page');
});

check('an unreadable PR list keeps every branch rather than dropping the protection', () => {
  // If the PR list cannot be read and is treated as empty, a merged branch with
  // review still running would be offered as safe. It must fail the other way.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/prsUnknown \? true : openPR\.has\(name\)/.test(src),
    'hasOpenPR must default to true when the PR list could not be read');
});

// --------------------------------------------------------- time bounds ----
//
// Counting commits is one blocking child process per branch. execFileSync holds
// the event loop for the whole of each one, so a setTimeout wrapped around the
// loop can never fire and bounds nothing. Measured on a 200-branch repository:
// 4145 ms against a promised 4000 ms cap, on empty local commits.

process.stdout.write('time bounds\n');

check('every child process is given a timeout', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/timeout: PER_COMMAND_TIMEOUT_MS/.test(src),
    'run() must pass a timeout to execFileSync, or one stuck git call hangs forever');
  assert.ok(/maxBuffer/.test(src), 'run() should bound output size too');
});

check('a deadline already past skips the work that costs, and reports it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-deadline-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t',
    '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git('commit', '-q', '--allow-empty', '-m', 'base');

  // Three shapes, because the deadline means something different to each one.
  // `pointer` needs no per-branch call at all; `unmerged` and `squashed` both
  // need the tree comparison, and only one of them would survive it.
  git('branch', 'pointer', 'main');
  git('checkout', '-qb', 'squashed', 'main');
  fs.writeFileSync(path.join(repo, 's.txt'), 'one\n');
  git('add', '-A'); git('commit', '-qm', 's1');
  fs.writeFileSync(path.join(repo, 's.txt'), 'one\ntwo\n');
  git('add', '-A'); git('commit', '-qm', 's2');
  git('checkout', '-qb', 'unmerged', 'main');
  fs.writeFileSync(path.join(repo, 'w.txt'), 'work\n');
  git('add', '-A'); git('commit', '-qm', 'work');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--squash', 'squashed');
  git('commit', '-qm', 'squash squashed');

  const collect = require(path.join(ROOT, 'scripts', 'collect.js'));
  const r = collect.localBranches(repo, { deadline: Date.now() - 1 });
  const by = (n) => r.branches.find((b) => b.name === n);

  assert.strictEqual(r.truncated, true, 'an expired deadline must be reported, not hidden');

  // Skipping the tree comparison is the whole point of the deadline. A branch
  // that only a tree comparison could clear must come back uncleared.
  assert.strictEqual(by('squashed').merged, false,
    'the tree comparison ran after the deadline had passed');

  // Ancestry rides along on the branch listing and costs no extra call, so
  // withholding it buys no time. Reporting a fact that was already in hand is
  // not the same as doing work the deadline forbade.
  assert.strictEqual(by('pointer').aheadBy, 0, 'a free ancestry answer should still be given');
  assert.strictEqual(by('unmerged').aheadBy, 1, 'a free ancestry answer should still be given');

  // The safety property, unchanged and the reason any of this is acceptable:
  // an unfinished run under-reports what is safe and never over-reports it.
  // `squashed` really is deletable and is deliberately not offered here.
  const { safe } = classify(r.branches, {}, Date.now());
  assert.deepStrictEqual(safe.map((b) => b.name), ['pointer'],
    'a truncated run must offer only what it fully resolved');

  // And with time to work, the branch it withheld is found.
  const full = collect.localBranches(repo, {});
  assert.strictEqual(full.truncated, false, 'no pressure, no truncation');
  assert.strictEqual(full.branches.find((b) => b.name === 'squashed').merged, true,
    'the squash merge should be detected when there is time to look');

  fs.rmSync(repo, { recursive: true, force: true });
});

check('no deadline means no truncation, and counting still happens', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-nodeadline-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-q', '--allow-empty', '-m', 'base'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'branch', 'merged', 'main'], { stdio: 'ignore' });

  const collect = require(path.join(ROOT, 'scripts', 'collect.js'));
  const r = collect.localBranches(repo);

  assert.strictEqual(r.truncated, false);
  const merged = r.branches.find((b) => b.name === 'merged');
  assert.strictEqual(merged.aheadBy, 0, 'a branch level with main has zero commits ahead');

  fs.rmSync(repo, { recursive: true, force: true });
});

check('the hook says nothing at all rather than reporting a partial count', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'session-notice.js'), 'utf8');
  assert.ok(/if \(truncated\) return;/.test(src),
    'a truncated count must produce silence, since a one-line notice cannot carry the caveat');
  assert.ok(/started \+ BUDGET_MS/.test(src),
    'the deadline must be measured from process start, so a slow stdin wait cannot extend the work');
});

// ------------------------------------------- what staleAfterDays governs ----
//
// It decides one thing: whether the session notice bothers mentioning a merged
// branch. It must never filter the command's own listing, and must never make
// anything deletable. A knob documented as doing something it does not do is a
// trap, and a cleanup command that silently hides rows is worse than one that
// shows too many.

process.stdout.write('what staleAfterDays governs\n');

check('a recently merged branch is safe but not stale', () => {
  const r = classify([{ name: 'just-merged', lastCommitDate: d(1), aheadBy: 0, isDefault: false }], {}, NOW);
  assert.strictEqual(r.all[0].safeToDelete, true);
  assert.strictEqual(r.all[0].stale, false, 'one day old is not stale at the default threshold');
});

check('raising the threshold never changes what is safe', () => {
  const branch = { name: 'merged-old', lastCommitDate: d(140), aheadBy: 0, isDefault: false };
  const tight = classify([branch], { staleAfterDays: 1 }, NOW);
  const loose = classify([branch], { staleAfterDays: 9999 }, NOW);
  assert.strictEqual(tight.safe.length, 1);
  assert.strictEqual(loose.safe.length, 1, 'age must not gate deletability at any threshold');
  assert.strictEqual(tight.all[0].stale, true);
  assert.strictEqual(loose.all[0].stale, false);
});

check('the listing shows recently merged branches, whatever the threshold', () => {
  const snap = {
    where: 'example/repo',
    branches: [
      { name: 'main', lastCommitDate: d(0), aheadBy: 0, isDefault: true },
      { name: 'merged-yesterday', lastCommitDate: d(1), aheadBy: 0, isDefault: false },
    ],
  };
  const f = path.join(os.tmpdir(), `stale-filter-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify(snap));
  const out = execFileSync('node', [CLI, '--input', f, '--now', '2026-07-27', '--stale-after', '365'], { encoding: 'utf8' });
  assert.ok(/Safe to delete \(1\)/.test(out),
    `a branch merged yesterday must still be listed and offered:\n${out}`);
  assert.ok(/merged-yesterday/.test(out));
  fs.unlinkSync(f);
});

check('the session notice ignores merged branches that are not yet stale', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'session-notice.js'), 'utf8');
  assert.ok(/safe\.filter\(\(b\) => b\.stale\)/.test(src),
    'the notice must filter on stale, or it nags about branches merged minutes ago');
});

check('the notice only speaks when a session actually starts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'session-notice.js'), 'utf8');
  assert.ok(/START_SOURCES/.test(src) && /'startup'/.test(src) && /'clear'/.test(src),
    'resume and compact happen inside a session that already had the notice');
  assert.ok(/if \(source && !START_SOURCES\.includes\(source\)\) return;/.test(src),
    'an absent source should still be treated as a start');
});

check('the notice stays silent on resume and on compact', () => {
  const HOOK = path.join(ROOT, 'hooks', 'session-notice.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-source-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'ignore' });
  g('commit', '-q', '--allow-empty', '-m', 'base');
  for (const b of ['x', 'y', 'z']) {
    g('checkout', '-qb', `m-${b}`); g('commit', '-q', '--allow-empty', '-m', b);
    g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', `m-${b}`, '-m', `merge ${b}`);
  }
  const fire = (source) => execFileSync('node', [HOOK], {
    input: JSON.stringify({ cwd: repo, source }), encoding: 'utf8',
  });
  assert.strictEqual(fire('resume').trim(), '', 'resume must not re-inject the notice');
  assert.strictEqual(fire('compact').trim(), '', 'compact happens mid-session');
  fs.rmSync(repo, { recursive: true, force: true });
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

// ------------------------------------------------------- squash merges ----
//
// A squash merge rewrites a branch into one new commit on the default branch,
// so the branch's own commits never become ancestors and `aheadBy` stays above
// zero for good. In a repository that squash-merges every pull request that
// made the plugin unable to clear a single branch: six merged branches, four of
// them with merged pull requests, all reported as "N commits not in the default
// branch". Reported 2026-08-04.
//
// Driven against a real repository rather than a fixture, because the thing
// under test is what git reports, and a fixture would only record what we
// already believe it reports.

check('a squash-merged branch is safe to delete, an unmerged one is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squash-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'line1\n');
  g('add', '.');
  g('commit', '-qm', 'base');

  // Three commits, the shape a squash collapses into one.
  g('checkout', '-qb', 'feature');
  for (const line of ['line2', 'line3', 'line4']) {
    fs.appendFileSync(path.join(dir, 'f.txt'), `${line}\n`);
    g('commit', '-qam', `part ${line}`);
  }

  g('checkout', '-q', 'main');
  g('merge', '-q', '--squash', 'feature');
  g('commit', '-qm', 'feature (#42)');

  // The default branch moves on afterwards, so the two trees are not equal by
  // accident. Without this the test would pass for the wrong reason.
  fs.writeFileSync(path.join(dir, 'g.txt'), 'unrelated\n');
  g('add', '.');
  g('commit', '-qm', 'later work on main');

  // A branch holding work that genuinely is not in main.
  g('checkout', '-qb', 'real-work', 'main');
  fs.writeFileSync(path.join(dir, 'h.txt'), 'not in main\n');
  g('add', '.');
  g('commit', '-qm', 'real unmerged work');
  g('checkout', '-q', 'main');

  const r = collect.localBranches(dir);
  const byName = Object.fromEntries(r.branches.map((b) => [b.name, b]));

  // If this ever stops holding, the squash is no longer being simulated and
  // everything below passes without proving anything.
  assert.ok(byName.feature.aheadBy > 0,
    `a squash merge must still leave aheadBy above zero, got ${byName.feature.aheadBy}`);

  assert.strictEqual(byName.feature.merged, true, 'squash-merged branch should carry merge evidence');
  assert.strictEqual(byName['real-work'].merged, false, 'a branch with unmerged work must not');

  const out = classify(r.branches, {}, Date.now());
  const safe = out.safe.map((b) => b.name);
  const keep = out.keep.map((b) => b.name);

  assert.ok(safe.includes('feature'),
    `squash-merged branch should be safe, got safe=${safe} keep=${keep}`);
  assert.ok(keep.includes('real-work'), 'unmerged work must be kept');
  assert.ok(!safe.includes('real-work'), 'unmerged work must never be offered for deletion');

  fs.rmSync(dir, { recursive: true, force: true });
});

// The guard on the new signal. `merged` answers "is this work already in the
// default branch"; it does not answer "did we manage to look". An unknown
// aheadBy means we did not look, and that must still keep.
check('merge evidence never rescues an unknown aheadBy', () => {
  const out = classify([
    { name: 'x', lastCommitDate: d(1), aheadBy: null, merged: true, mergedVia: 'merged in #1',
      isDefault: false, isCurrent: false, hasOpenPR: false },
  ], {}, NOW);
  assert.strictEqual(out.safe.length, 0, 'unknown ancestry plus a merge signal is still one fact missing');
  assert.ok(out.keep[0].keepReasons.includes('merge-state-unknown'));
});

// The local default branch is a local ref, and right after a pull request
// merges it is behind by exactly the merge being asked about. Comparing only
// against it kept branches that were genuinely merged, and only --repo cleared
// them. Found while verifying the fix above, in a separate session.
check('a branch merged into origin/main is cleared even when local main is behind', () => {
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'work-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);

  const g = (...args) => execFileSync('git', ['-C', work, ...args], { encoding: 'utf8', stdio: 'pipe' });
  // stdio piped because cloning an empty bare repository warns, and a warning
  // in the middle of passing test output reads as a failure.
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');

  fs.writeFileSync(path.join(work, 'f.txt'), 'base\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('push', '-q', '-u', 'origin', 'main');

  g('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(work, 'new.txt'), 'work\n');
  g('add', '.');
  g('commit', '-qm', 'the work');

  // Squash-merge it and publish, exactly as merging a pull request would.
  g('checkout', '-q', 'main');
  g('merge', '-q', '--squash', 'feature');
  g('commit', '-qm', 'feature (#7)');
  g('push', '-q', 'origin', 'main');

  // Then put the local default branch back where it was. This is the state of
  // any checkout that has not pulled since the merge, which is the normal one.
  g('reset', '-q', '--hard', 'HEAD~1');

  const localTip = g('rev-parse', 'main').trim();
  const remoteTip = g('rev-parse', 'origin/main').trim();
  assert.notStrictEqual(localTip, remoteTip, 'local main must be behind origin/main, or this test proves nothing');

  const r = collect.localBranches(work);
  const feature = r.branches.find((b) => b.name === 'feature');

  assert.ok(feature.aheadBy > 0, 'the branch must still look unmerged by ancestry');
  assert.strictEqual(feature.merged, true, 'a branch merged into origin/main should carry merge evidence');
  assert.ok(/origin\/main/.test(feature.mergedVia || ''),
    `the reason should name which ref carried it, got ${JSON.stringify(feature.mergedVia)}`);

  const out = classify(r.branches, {}, Date.now());
  assert.ok(out.safe.map((b) => b.name).includes('feature'),
    'a branch merged upstream is safe even when this checkout has not pulled');

  fs.rmSync(origin, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

// ------------------------------------------------ the re-check before delete ----
//
// The listing and the check that runs immediately before deleting have to ask
// the same question. They did not: the skill re-read an ancestry count, which a
// squash merge never brings to zero, so every branch the merge signal cleared
// was offered, approved, then refused with a message saying something had
// landed in between. Nothing had.
check('--verify clears a squash-merged branch and asks for the delete that works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  g('checkout', '-qb', 'squashed');
  fs.appendFileSync(path.join(dir, 'f.txt'), 'work\n');
  g('commit', '-qam', 'the work');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--squash', 'squashed');
  g('commit', '-qm', 'squashed (#9)');

  g('checkout', '-qb', 'unmerged', 'main');
  fs.writeFileSync(path.join(dir, 'h.txt'), 'not in main\n');
  g('add', '.'); g('commit', '-qm', 'real work');
  g('checkout', '-q', 'main');

  const verify = (name) => {
    try {
      return { code: 0, out: execFileSync('node', [CLI, '--cwd', dir, '--verify', name], { encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  // git itself must refuse this branch, or the -D below is unnecessary and the
  // test is not exercising the thing it was written for.
  let refused = false;
  try { g('branch', '-d', 'squashed'); } catch (_) { refused = true; }
  assert.ok(refused, 'git branch -d must refuse a squash-merged branch, or this test proves nothing');

  const ok = verify('squashed');
  assert.strictEqual(ok.code, 0, `a squash-merged branch must still verify, got:\n${ok.out}`);
  assert.ok(/needs-force:/.test(ok.out),
    `-d is going to refuse this, and saying so is what stops it being reported as a disagreement:\n${ok.out}`);
  assert.ok(/git branch -d squashed/.test(ok.out),
    `the printed command stays -d; forcing is the user's call, not this tool's:\n${ok.out}`);
  assert.ok(!/git branch -D/.test(ok.out), 'nothing here composes -D on the user\'s behalf');

  const no = verify('unmerged');
  assert.strictEqual(no.code, 3, 'a branch with unmerged work must not verify');
  assert.ok(!/git branch/.test(no.out), 'a refused branch must not be handed a delete command');

  const gone = verify('never-existed');
  assert.strictEqual(gone.code, 3, 'a branch that is not there must not verify');

  fs.rmSync(dir, { recursive: true, force: true });
});

// The needs-force line is advice to a human, never a command. The existing
// guard above already pins that classify.js contains no -D; this pins that the
// new verify path did not become a way around it.
check('verify never composes a force delete, whatever the evidence', () => {
  const cliSrc = fs.readFileSync(CLI, 'utf8');
  assert.ok(!/'-D'|"-D"|branch -D/.test(cliSrc),
    'cli.js must not build a -D command either, or the guard just moved file');
});

// The skill's commands run in the user's repository, which has no scripts/
// directory of ours. A relative path exits with a module error, which is
// neither 0 nor 3, so the documented branching has nothing to match and an
// approved cleanup silently deletes nothing.
check('every command in the skill names the plugin root, not a relative path', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'stale-branches', 'SKILL.md'), 'utf8');
  const calls = skill.split('\n').filter((l) => /^\s*node\s/.test(l));
  assert.ok(calls.length > 0, 'expected some node invocations to check');
  for (const line of calls) {
    assert.ok(/CLAUDE_PLUGIN_ROOT/.test(line),
      `a relative path cannot resolve from the user's own repository:\n  ${line.trim()}`);
  }
});

// Re-checking twenty branches must not rescan the repository twenty times.
check('the single-branch re-check collects one branch, not all of them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'only-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');
  for (const b of ['one', 'two', 'three', 'four']) g('branch', b, 'main');

  const all = collect.localBranches(dir);
  assert.ok(all.branches.length >= 5, 'the full listing should still see every branch');

  const one = collect.localBranches(dir, { only: 'three' });
  assert.strictEqual(one.branches.length, 1, 'the re-check should collect only the branch it was asked about');
  assert.strictEqual(one.branches[0].name, 'three');

  // Same facts, not a cheaper approximation of them.
  const fromAll = all.branches.find((b) => b.name === 'three');
  assert.strictEqual(one.branches[0].aheadBy, fromAll.aheadBy);
  assert.strictEqual(one.branches[0].merged, fromAll.merged);

  fs.rmSync(dir, { recursive: true, force: true });
});

check('a remote re-check asks about one commit rather than paginating every closed pull request', () => {
  assert.strictEqual(typeof collect.remoteBranch, 'function',
    'a single-branch remote collector must exist, or --verify falls back to the full scan');
  const src = fs.readFileSync(CLI, 'utf8');
  assert.ok(/opts\.verify\s*\?\s*collect\.remoteBranch/.test(src),
    '--verify must use the single-branch collector, not filter the full listing afterwards');
  const collectSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/commits\/\$\{head\.sha\}\/pulls/.test(collectSrc),
    'merge evidence for one branch comes from the pull requests on its head commit');
});

// `merge-tree --write-tree` needs git 2.38. On older git it exits non-zero,
// tryRun returns null, and every squash-merged branch silently stays in Keep,
// which is the exact problem this work exists to fix, reported as a clean run.
check('an old git is reported rather than silently doing nothing', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/supportsWriteTree/.test(src),
    'the comparison must be probed, not assumed, or an old git looks like a clean result');
  assert.ok(/mergeCheckUnavailable/.test(src),
    'and the answer has to reach the caller, or nothing can say the check was skipped');

  const cliSrc = fs.readFileSync(CLI, 'utf8');
  assert.ok(/mergeCheckUnavailable/.test(cliSrc),
    'the command must say the comparison was unavailable rather than print a shorter list');
  assert.ok(/2\.38/.test(cliSrc),
    'and name the version, so the reader can tell whether it applies to them');
});

// The probe itself, driven for real. Passes on any git; on 2.38 and newer it
// also proves the probe does not report a capable git as incapable.
check('the write-tree probe agrees with what this git can actually do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  let real = true;
  try { g('merge-tree', '--write-tree', 'HEAD', 'HEAD'); } catch (_) { real = false; }

  const r = collect.localBranches(dir);
  assert.strictEqual(r.mergeCheckUnavailable, !real,
    'the reported capability must match what git actually does here');

  fs.rmSync(dir, { recursive: true, force: true });
});

// "Gone" and "could not look" are different facts and only one of them is
// about the branch. Telling someone mid-cleanup that a branch vanished invites
// them to assume the work went with it.
check('a lookup that failed is not reported as a branch that vanished', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/unreadable/.test(src), 'an unreadable listing must be distinguishable from an empty one');
  const cliSrc = fs.readFileSync(CLI, 'utf8');
  assert.ok(/lookup && lookup\.unreadable/.test(cliSrc),
    'verify must branch on it, or every failure reads as "not in this repository any more"');
  assert.ok(/nothing is known either way/.test(cliSrc),
    'and say plainly that nothing was learned');
});

// The force group is the one running without git's own reachability check, and
// the user's approval covers the group rather than each branch, so the verdict
// is arbitrarily old by the time -D runs.
check('the force path re-checks each branch immediately before deleting it', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'stale-branches', 'SKILL.md'), 'utf8');
  const section = skill.slice(skill.indexOf('needs-force:'));
  const verifyAt = section.indexOf('--verify');
  const forceAt = section.indexOf('branch -D');
  assert.ok(verifyAt !== -1, 'the force path must re-verify');
  assert.ok(verifyAt < forceAt,
    'the re-check has to come before the force delete, not after the group was approved');
  assert.ok(/one at a time/.test(section),
    'and one branch at a time, so a change part way through cannot reach a branch already cleared');
});

// The number of explanation lines varies: a branch cleared by merge evidence
// gets a needs-force line, one cleared by ancestry does not. A caller counting
// from the top runs prose as a shell command.
check('the delete command is the last line of verify output, whatever else is printed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastline-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  // Cleared by ancestry: no needs-force line.
  g('branch', 'plain', 'main');

  // Cleared by merge evidence: gets one.
  g('checkout', '-qb', 'squashed');
  fs.appendFileSync(path.join(dir, 'f.txt'), 'work\n');
  g('commit', '-qam', 'work');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--squash', 'squashed');
  g('commit', '-qm', 'squashed (#3)');

  for (const name of ['plain', 'squashed']) {
    const out = execFileSync('node', [CLI, '--cwd', dir, '--verify', name], { encoding: 'utf8' });
    const lines = out.split('\n').filter(Boolean);
    assert.ok(/^git branch -d /.test(lines[lines.length - 1]),
      `the last line must be the command for ${name}, got:\n${out}`);
  }

  // And the two really do print a different number of lines, or this proves nothing.
  const a = execFileSync('node', [CLI, '--cwd', dir, '--verify', 'plain'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  const b = execFileSync('node', [CLI, '--cwd', dir, '--verify', 'squashed'], { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  assert.notStrictEqual(a, b, 'the line count must vary, which is why counting from the top is wrong');

  // The skill must say so rather than naming a line number.
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'stale-branches', 'SKILL.md'), 'utf8');
  assert.ok(/last line/.test(skill), 'the skill must point at the last line');
  assert.ok(!/command on the second/.test(skill), 'and must not tell the reader to take the second line');

  fs.rmSync(dir, { recursive: true, force: true });
});

// HEAD can be unborn in a repository that is otherwise fine. Probing it made a
// modern git report itself as too old and switched the detection off entirely.
check('an unborn HEAD does not make a modern git look too old', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  g('checkout', '-qb', 'squashed');
  fs.appendFileSync(path.join(dir, 'f.txt'), 'work\n');
  g('commit', '-qam', 'work');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--squash', 'squashed');
  g('commit', '-qm', 'squashed (#3)');

  // Now sit on a branch with no commits, which is a normal thing to do.
  g('checkout', '-q', '--orphan', 'brand-new');

  let modern = true;
  try { g('merge-tree', '--write-tree', 'main', 'main'); } catch (_) { modern = false; }

  const r = collect.localBranches(dir);
  if (modern) {
    assert.strictEqual(r.mergeCheckUnavailable, false,
      'an unborn HEAD is not a git version problem and must not be reported as one');
    const squashed = r.branches.find((b) => b.name === 'squashed');
    assert.strictEqual(squashed.merged, true,
      'and the detection must still run for every other branch');
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------- what the remote path counts ----
//
// Both of these were live bugs in the first version of the squash-merge fix,
// caught in review before it merged. Neither is reachable from the local path,
// whose evidence is computed live against the branch's current tip, and both
// end with a branch being offered for deletion while its commits exist nowhere
// else. Source assertions rather than behavioural ones, matching how the rest
// of the gh path is pinned here, because reaching it needs a live API.

check('a merged pull request only counts when it merged into the default branch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('state=closed'));
  assert.ok(line, 'expected a closed-PR query to check');
  assert.ok(/base=/.test(line),
    'merged_at says a pull request merged, not where it merged to. Without a base filter, '
    + `stacked work merged into another branch counts as reaching the default branch:\n  ${line.trim()}`);
});

check('merge evidence is keyed on the merged commit, not the branch name', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  assert.ok(/head\.sha/.test(src),
    'a branch name outlives the commit that merged under it, so reusing a branch after its '
    + 'pull request merged would read as merged while holding new work');
  assert.ok(/tipSha/.test(src),
    'the branch tip has to be collected for the evidence to be checked against it');
  assert.ok(!/mergedBySha\.get\(name\)/.test(src),
    'looking the evidence up by branch name is the bug these two tests exist for');
});

// The rendered header is a claim about why a branch is safe, and it stopped
// being true once squash merges counted. Nothing bound the sample output to the
// code, so it went stale silently the first time round.
check('the README sample output matches what the command actually prints', () => {
  const cliSrc = fs.readFileSync(CLI, 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

  const m = cliSrc.match(/Safe to delete \(\$\{safe\.length\}\)(.*?)`\);/);
  assert.ok(m, 'expected to find the safe-list header in cli.js');
  const phrase = m[1].replace(/^[^A-Za-z]+/, '').replace(/:\s*$/, '').trim();
  assert.ok(phrase.length > 0, 'expected a readable phrase in the safe-list header');

  assert.ok(readme.includes(phrase),
    `README shows a safe-list header the command no longer prints. Expected to find:\n  ${phrase}`);
});

fs.unlinkSync(fixture);

process.stdout.write(failures === 0 ? '\nAll stale-branch tests passed.\n' : `\n${failures} test(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
