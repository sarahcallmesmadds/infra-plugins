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

// Whether this git can do `merge-tree --write-tree`, which arrived in 2.38 and
// is the only way to tell a squash merge from unmerged work. Probed once, for
// real, in a throwaway repository, because that is the same standard the
// product code holds itself to: collect.js probes rather than parsing
// `git --version`, and a test that guessed differently would disagree with the
// thing it is testing.
const WRITE_TREE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-probe-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g('add', '.'); g('commit', '-qm', 'base');
    g('merge-tree', '--write-tree', 'HEAD', 'HEAD');
    return true;
  } catch (_) {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

let failures = 0;
let skipped = 0;

// `check(name, fn)` as before. `check(name, fn, { needs: 'write-tree' })` skips
// when this git cannot do the thing the check is about.
//
// Skipping rather than failing, because those are different facts and only one
// of them is about the code. Four checks here turn on *detecting* a squash
// merge, which needs `merge-tree --write-tree`. On an older git they failed,
// and a reviewer seeing `41 suites, 1 failed` reasonably goes looking for a
// regression that is not there. It happened three times in one afternoon on a
// pull request that touched a different plugin entirely.
//
// Four, and not the fifth that looks like it belongs. The deadline check builds
// a squash-merged branch too, but `git merge --squash` is ancient; only reading
// the result back needs 2.38. That check probes the capability itself and
// guards its one version-dependent assertion, so it runs correctly everywhere,
// and marking it here would have dropped real coverage of the rule that an
// out-of-time run never offers an unresolved branch for deletion. Building the
// fixture and detecting it are different requirements, and only the second is
// what this flag is for.
//
// The skip line names the version, so the reader can tell in one line whether
// it applies to them.
function check(name, fn, opts = {}) {
  if (opts.needs === 'write-tree' && !WRITE_TREE) {
    skipped += 1;
    process.stdout.write(`  skip ${name}\n       needs git 2.38 for merge-tree --write-tree; this git does not have it\n`);
    return;
  }
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

// Shorthand for the four checks whose subject is squash-merge detection, which
// is precisely what an older git cannot do.
const checkWriteTree = (name, fn) => check(name, fn, { needs: 'write-tree' });

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

  // Both capabilities probed for real rather than read off `git --version`,
  // the same way the write-tree probe further down is. They change what this
  // test is entitled to assert, not just how fast the code runs:
  // `%(ahead-behind:)` needs git 2.41, and without it the ancestry answer costs
  // a call per branch, which is exactly the work an expired deadline skips.
  let listingCarriesAhead = true;
  try {
    execFileSync('git', ['-C', repo, 'for-each-ref', '--format=%(ahead-behind:main)',
      'refs/heads/'], { stdio: 'pipe' });
  } catch (_) { listingCarriesAhead = false; }
  // Asked the way collect.js asks it, argument for argument. A probe that
  // differs even in the flags it passes can answer yes where the real call
  // answers no, and then this test asserts a capability the code did not have.
  let hasWriteTree = true;
  try {
    execFileSync('git', ['-C', repo, 'merge-tree', '--write-tree', 'main', 'main'], { stdio: 'pipe' });
  } catch (_) { hasWriteTree = false; }

  const collect = require(path.join(ROOT, 'scripts', 'collect.js'));
  const r = collect.localBranches(repo, { deadline: Date.now() - 1 });
  const by = (n) => r.branches.find((b) => b.name === n);
  const { safe } = classify(r.branches, {}, Date.now());

  // True on any git. Skipping the per-branch work is the whole point of the
  // deadline, and a branch that only a skipped call could have cleared must
  // come back uncleared.
  assert.strictEqual(r.truncated, true, 'an expired deadline must be reported, not hidden');
  assert.strictEqual(by('squashed').merged, false,
    'the tree comparison ran after the deadline had passed');

  // The safety property, and the reason any of this is acceptable: an
  // unfinished run under-reports what is safe and never over-reports it.
  // `squashed` really is deletable, and is deliberately not offered here.
  assert.ok(!safe.some((b) => b.name === 'squashed' || b.name === 'unmerged'),
    'a branch that a skipped call would have judged must not be offered as safe');

  if (listingCarriesAhead) {
    // Ancestry rides along on the branch listing and costs no extra call, so
    // withholding it buys no time. Reporting a fact already in hand is not the
    // same as doing work the deadline forbade.
    assert.strictEqual(by('pointer').aheadBy, 0, 'a free ancestry answer should still be given');
    assert.strictEqual(by('unmerged').aheadBy, 1, 'a free ancestry answer should still be given');
    assert.deepStrictEqual(safe.map((b) => b.name), ['pointer'],
      'a truncated run must offer everything it fully resolved, and nothing else');
  } else {
    // On an older git the same answer costs a call per branch, so the deadline
    // skips it and the run offers nothing. Slower, still never wrong.
    assert.strictEqual(by('pointer').aheadBy, null,
      'without the batched listing the count is per-branch work the deadline forbids');
    assert.deepStrictEqual(safe.map((b) => b.name), [],
      'nothing was resolved, so nothing may be offered');
  }

  // And with time to work, the branch it withheld is found.
  const full = collect.localBranches(repo, {});
  assert.strictEqual(full.truncated, false, 'no pressure, no truncation');
  if (hasWriteTree) {
    assert.strictEqual(full.branches.find((b) => b.name === 'squashed').merged, true,
      'the squash merge should be detected when there is time to look');
  }

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

checkWriteTree('a squash-merged branch is safe to delete, an unmerged one is not', () => {
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
checkWriteTree('a branch merged into origin/main is cleared even when local main is behind', () => {
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
checkWriteTree('--verify clears a squash-merged branch and asks for the delete that works', () => {
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
checkWriteTree('the delete command is the last line of verify output, whatever else is printed', () => {
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

check('the skip count rides in the final line, where run-all can see it', () => {
  // Pinned on the source rather than the output, because the summary is written
  // after every check has run and nothing here can observe it. The failure this
  // guards against is not a wrong count, it is a correct count printed where
  // the aggregate runner never looks.
  const self = fs.readFileSync(__filename, 'utf8');
  const summary = self.slice(self.lastIndexOf('All stale-branch tests passed'));
  assert.ok(/\$\{skipNote\}/.test(summary),
    'the pass line no longer carries the skip count, so a full run cannot tell a '
    + 'complete pass from one that skipped half the squash-merge coverage');

  // The coupling is real and worth failing on. If run-all stops taking the last
  // line, this whole arrangement needs revisiting rather than silently drifting.
  const runAll = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
  assert.ok(/\.pop\(\)/.test(runAll),
    'run-all no longer summarises a suite by its last line, which is the only '
    + 'reason the skip count has to live there');
});

// ------------------------------------- a copy of the remote is not the remote ----
//
// Every comparison in the local path runs against `origin/<def>`, which a fetch
// wrote at some point in the past. When the real branch has moved since, work
// that has merged is still absent from the copy, so the branches holding it come
// back under Keep with an ordinary looking commit count. The classification is
// right about what it was given. The output is wrong about what it means.
//
// Built against a real bare repository rather than a stub, because the failure
// is specifically about the gap between a remote-tracking ref and the thing it
// tracks, and a stub cannot have that gap.
function withOriginAndSquashMerge(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-origin-'));
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'work');
  const g = (at, ...a) => execFileSync('git', ['-C', at, ...a], { encoding: 'utf8', stdio: 'pipe' });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', remote, local], { stdio: 'pipe' });
  g(local, 'config', 'user.email', 'test@example.com');
  g(local, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(local, 'f.txt'), 'base\n');
  g(local, 'add', '.'); g(local, 'commit', '-qm', 'base');
  g(local, 'push', '-q', 'origin', 'main');

  // A branch with real work, pushed so the remote has it too.
  g(local, 'checkout', '-qb', 'feature');
  fs.appendFileSync(path.join(local, 'f.txt'), 'work\n');
  g(local, 'commit', '-qam', 'work');
  g(local, 'push', '-q', 'origin', 'feature');
  g(local, 'checkout', '-q', 'main');

  // Now squash it into main through a second clone, so the remote moves and the
  // first checkout's `origin/main` does not. This is the shape of someone else
  // merging your pull request, or of you merging it in the browser.
  const other = path.join(dir, 'other');
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
  g(other, 'config', 'user.email', 'test@example.com');
  g(other, 'config', 'user.name', 'test');
  g(other, 'merge', '-q', '--squash', 'origin/feature');
  g(other, 'commit', '-qm', 'feature (#1)');
  g(other, 'push', '-q', 'origin', 'main');

  try {
    return fn({ dir, local, remote, g });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('a remote that has moved since the last fetch is reported, not hidden', () => {
  withOriginAndSquashMerge(({ local }) => {
    const r = collect.localBranches(local);
    assert.strictEqual(r.remoteStale, true,
      'the copy is behind the branch it tracks, and that has to reach the caller');

    // And the branch really does look unmerged from here, which is why the note
    // matters. Without this the test could pass on a run where nothing was
    // misreported anyway.
    const feature = r.branches.find((b) => b.name === 'feature');
    assert.strictEqual(feature.merged, false,
      'the whole point is that the merge is invisible against a stale copy');
    assert.ok(feature.aheadBy > 0, 'so it carries a commit count like unmerged work does');

    const out = execFileSync('node', [CLI, '--cwd', local], { encoding: 'utf8' });
    assert.ok(/the remote has moved past it/.test(out), 'the note must be printed, not just returned');
    assert.ok(/git fetch` and try again/.test(out), 'and must say what to do about it');
    assert.ok(out.indexOf('feature') > out.indexOf('Keep'),
      'with the branch it explains still listed under Keep');
  });
});

check('a fetched copy prints no note, and the branch is cleared', () => {
  withOriginAndSquashMerge(({ local, g }) => {
    g(local, 'fetch', '-q', 'origin');
    const r = collect.localBranches(local);
    assert.strictEqual(r.remoteStale, false, 'up to date is up to date');

    const out = execFileSync('node', [CLI, '--cwd', local], { encoding: 'utf8' });
    assert.ok(!/the remote has moved past it/.test(out), 'no caveat when there is nothing to caveat');

    // Only meaningful on a git that can see a squash merge at all. Elsewhere the
    // branch stays in Keep for a reason this test is not about.
    if (WRITE_TREE) {
      const feature = r.branches.find((b) => b.name === 'feature');
      assert.strictEqual(feature.merged, true,
        'and once fetched, the merge the note warned about is visible');
    }
  });
});

// Both skips are about cost rather than correctness, and both are safe because
// a stale copy can only hold a branch back from deletion.
check('the probe is skipped for the pre-delete re-check and under a deadline', () => {
  withOriginAndSquashMerge(({ local }) => {
    assert.strictEqual(collect.localBranches(local, { only: 'feature' }).remoteStale, false,
      'one network round trip per branch is what `only` exists to avoid');
    assert.strictEqual(collect.localBranches(local, { deadline: Date.now() + 60000 }).remoteStale, false,
      'a caller under a budget does not print this note and should not pay for it');
  });
});

// `ls-remote <pattern>` matches the tail of a ref, not the whole of it, so a
// bare `main` also matches `refs/heads/foo/main`. Output is sorted by ref name,
// which puts the nested one first, so reading the first line took an unrelated
// branch's commit and reported a current copy as stale on every single run.
//
// A warning that can never be cleared by doing what it asks is worse than no
// warning, because the next real one gets ignored with it.
check('a branch whose last segment matches the default does not fake staleness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-match-'));
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'work');
  const g = (at, ...a) => execFileSync('git', ['-C', at, ...a], { encoding: 'utf8', stdio: 'pipe' });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', remote, local], { stdio: 'pipe' });
  g(local, 'config', 'user.email', 'test@example.com');
  g(local, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(local, 'f.txt'), 'base\n');
  g(local, 'add', '.'); g(local, 'commit', '-qm', 'base');
  g(local, 'push', '-q', 'origin', 'main');

  // A branch called `foo/main`, at a different commit from `main`, pushed. The
  // differing commit is the point: matching it would look exactly like the
  // remote having moved.
  g(local, 'checkout', '-qb', 'foo/main');
  fs.appendFileSync(path.join(local, 'f.txt'), 'unrelated\n');
  g(local, 'commit', '-qam', 'unrelated work on a confusingly named branch');
  g(local, 'push', '-q', 'origin', 'foo/main');
  g(local, 'checkout', '-q', 'main');
  g(local, 'fetch', '-q', 'origin');

  // Sorted first, which is why taking line one was wrong.
  const listing = g(local, 'ls-remote', '--heads', 'origin', 'main');
  assert.ok(/refs\/heads\/foo\/main/.test(listing),
    'the bare pattern must still match both, or this test is not exercising the bug');
  assert.ok(listing.indexOf('refs/heads/foo/main') < listing.indexOf('refs/heads/main\n'),
    'and the unrelated one must sort first, which is what made it the one read');

  assert.strictEqual(collect.localBranches(local).remoteStale, false,
    'the copy of main is current, whatever else on the remote ends in "main"');
  const out = execFileSync('node', [CLI, '--cwd', local], { encoding: 'utf8' });
  assert.ok(!/the remote has moved past it/.test(out), 'so no note, on this run or any other');

  fs.rmSync(dir, { recursive: true, force: true });
});

// A caller parsing the JSON was getting the same answer as the text output with
// the reasons to distrust it stripped off.
check('--json carries the caveats, present whether or not they are set', () => {
  withOriginAndSquashMerge(({ local, g }) => {
    const stale = JSON.parse(execFileSync('node', [CLI, '--cwd', local, '--json'], { encoding: 'utf8' }));
    assert.strictEqual(stale.remoteStale, true, 'the caveat has to survive the format');
    assert.strictEqual(typeof stale.mergeCheckUnavailable, 'boolean');
    assert.strictEqual(typeof stale.mergedPRCheckUnavailable, 'boolean');

    g(local, 'fetch', '-q', 'origin');
    const fresh = JSON.parse(execFileSync('node', [CLI, '--cwd', local, '--json'], { encoding: 'utf8' }));
    assert.strictEqual(fresh.remoteStale, false,
      'and must be present as false rather than absent, which is what an older '
      + 'version without the key looks like');
    assert.ok(Object.prototype.hasOwnProperty.call(fresh, 'remoteStale'));
    assert.ok(Object.prototype.hasOwnProperty.call(fresh, 'mergedPRCheckUnavailable'),
      'the newest caveat is subject to the same rule as the two before it');
  });
});

// The probe's contract is that failure is silent. Prompting is the one failure
// that is not: it stops the run and waits, with only the timeout bounding it.
//
// Source assertions, matching how the rest of the credential path is pinned in
// this file: reaching it for real needs a remote that demands authentication,
// and a suite that depends on the network fails for reasons that are not about
// the code.
//
// The behaviour behind each line below was checked by hand against real git
// before it was written, because `GIT_TERMINAL_PROMPT=0` closes one route and
// reads as though it closed all of them. With an askpass helper configured and
// credential helpers off, the helper was invoked twice despite that variable
// being set. With `GIT_ASKPASS` and `SSH_ASKPASS` removed and `core.askPass`
// emptied, the same command failed immediately with "terminal prompts
// disabled". The first version of this shipped believing the one variable was
// enough.
check('the remote probe closes every interactive route', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'collect.js'), 'utf8');
  const fn = src.slice(src.indexOf('function remoteMoved'), src.indexOf('function localBranches'));
  assert.ok(/GIT_TERMINAL_PROMPT: '0'/.test(fn), "git's own terminal prompt");
  assert.ok(/delete env\.GIT_ASKPASS/.test(fn) && /delete env\.SSH_ASKPASS/.test(fn),
    'the askpass helpers, which GIT_TERMINAL_PROMPT does not cover');
  assert.ok(/'core\.askPass='/.test(fn), 'the config form of the same thing');
  assert.ok(/credential\.interactive=false/.test(fn), 'and the credential manager window');
  assert.ok(/refs\/heads\//.test(fn), 'the ref must be matched fully qualified');

  // The inherited value has to be extended rather than replaced or preserved.
  // Keeping it verbatim gave exactly the people who set GIT_SSH_COMMAND an ssh
  // that could still ask for a passphrase.
  assert.ok(/\$\{process\.env\.GIT_SSH_COMMAND \|\| 'ssh'\} -o BatchMode=yes/.test(fn),
    'BatchMode must be appended to any inherited GIT_SSH_COMMAND, not only used as a default');
  assert.ok(!/GIT_SSH_COMMAND: process\.env\.GIT_SSH_COMMAND \|\|/.test(fn),
    'and the old form, which handed a custom command through untouched, must be gone');
});

// A checkout with an origin but no `refs/remotes/origin/<def>`: single-branch
// clones, shallow clones, pruned remote refs. The comparison falls back to the
// local branch, which can be arbitrarily far behind, so skipping the probe here
// reproduces the silent stale answer this release exists to remove.
check('staleness is still reported when there is no remote-tracking ref', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-tracking-'));
  const remote = path.join(dir, 'remote.git');
  const local = path.join(dir, 'work');
  const g = (at, ...a) => execFileSync('git', ['-C', at, ...a], { encoding: 'utf8', stdio: 'pipe' });

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
  execFileSync('git', ['clone', '-q', remote, local], { stdio: 'pipe' });
  g(local, 'config', 'user.email', 'test@example.com');
  g(local, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(local, 'f.txt'), 'base\n');
  g(local, 'add', '.'); g(local, 'commit', '-qm', 'base');
  g(local, 'push', '-q', 'origin', 'main');
  g(local, 'branch', 'feature');

  // Move the remote on, through a second clone, then delete every
  // remote-tracking ref this checkout has.
  const other = path.join(dir, 'other');
  execFileSync('git', ['clone', '-q', remote, other], { stdio: 'pipe' });
  g(other, 'config', 'user.email', 'test@example.com');
  g(other, 'config', 'user.name', 'test');
  fs.appendFileSync(path.join(other, 'f.txt'), 'more\n');
  g(other, 'commit', '-qam', 'more'); g(other, 'push', '-q', 'origin', 'main');
  for (const ref of g(local, 'for-each-ref', '--format=%(refname)', 'refs/remotes/').split('\n').filter(Boolean)) {
    g(local, 'update-ref', '-d', ref.trim());
  }
  assert.strictEqual(g(local, 'for-each-ref', '--format=%(refname)', 'refs/remotes/').trim(), '',
    'the fixture must really have no remote-tracking refs, or it tests nothing');

  const r = collect.localBranches(local);
  assert.strictEqual(r.remoteStale, true, 'the local branch is behind the remote and that has to be said');
  assert.strictEqual(r.remoteStaleRef, 'main',
    'and the note must name the ref actually compared against, which is not origin/main here');

  const out = execFileSync('node', [CLI, '--cwd', local], { encoding: 'utf8' });
  assert.ok(/compared against `main`/.test(out), 'the printed note must name it too');
  assert.ok(!/origin\/main/.test(out), 'and must not name a ref this checkout does not have');

  fs.rmSync(dir, { recursive: true, force: true });
});

// A repository with no origin at all is the ordinary case for local-only work,
// and it must not produce a warning about a remote that does not exist.
check('no remote means no note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-origin-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('branch', 'other');

  const r = collect.localBranches(dir);
  assert.strictEqual(r.remoteStale, false, 'nothing to be out of date with');
  const out = execFileSync('node', [CLI, '--cwd', dir], { encoding: 'utf8' });
  assert.ok(!/the remote has moved past it/.test(out), 'and nothing said about one');

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- merged pull requests in the local path --------------------------------
//
// The defect these pin: for one repository, `--repo` cleared seven branches by
// number while the local run kept the same seven as work in progress, and on
// 2026-08-11 a listing cleared a branch as "merged in #96" and the check that
// runs immediately before the delete refused the same branch seconds later.
// Neither answer was unsafe on its own. Having two was, because somebody
// watching that happen cannot tell which one is wrong, and the reading that
// fits, that the branch gained work in between, is the one thing that had not
// happened.
//
// `gh` is stubbed rather than called. These tests describe how an answer is
// used, not whether GitHub is reachable, and a test that needs the network to
// pass fails for reasons that have nothing to do with the code.

// The URL forms git actually writes, and what each one means for whether a
// missing merged-PR list is worth reporting.
check('an origin URL is read for its host and repository, in every form git writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-origin-url-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });

  const cases = [
    ['git@github.com:owner/name.git', 'github.com', 'owner/name'],
    ['git@github.com:owner/name', 'github.com', 'owner/name'],
    ['https://github.com/owner/name.git', 'github.com', 'owner/name'],
    ['https://github.com/owner/name', 'github.com', 'owner/name'],
    ['https://user@github.com/owner/name.git', 'github.com', 'owner/name'],
    ['ssh://git@github.com/owner/name.git', 'github.com', 'owner/name'],
    ['ssh://git@github.com:22/owner/name.git', 'github.com', 'owner/name'],
    // Not GitHub, and it matters: a repository with no pull requests to miss
    // must not be told that its merged pull requests could not be read.
    ['git@gitlab.com:owner/name.git', 'gitlab.com', 'owner/name'],
  ];
  g('remote', 'add', 'origin', 'https://example.com/a/b');
  for (const [url, host, repo] of cases) {
    g('remote', 'set-url', 'origin', url);
    const got = collect.originRepo(dir);
    assert.ok(got, `${url}: parsed to nothing`);
    assert.strictEqual(got.host, host, `${url}: wrong host`);
    assert.strictEqual(got.repo, repo, `${url}: wrong repository`);
  }

  // A local path is a legitimate origin and is not a repository slug. Reading
  // one as `owner/name` would send a pull request query at a made-up name.
  g('remote', 'set-url', 'origin', dir);
  const local = collect.originRepo(dir);
  assert.ok(local === null || !/^github\.com$/i.test(local.host),
    'a filesystem path must not be read as a GitHub repository');

  fs.rmSync(dir, { recursive: true, force: true });
});

// The three shapes of gh call the code makes, answered the way GitHub would.
//
// Written out per query rather than as one catch-all, because the listing and
// the pre-delete re-check deliberately ask different questions and a stub that
// answers both identically cannot tell them apart. The first version of these
// tests did exactly that, and it went on passing when the re-check moved to the
// single-commit query, which is the one thing they existed to notice.
//
// `printf` rather than `echo`, because `echo "\t"` prints a backslash and a t
// on some shells, and the fields here are tab separated.
const GH_MERGED = [
  // The re-check: pull requests containing one commit.
  // number, base ref, head sha, state, merged.
  '  *commits/*/pulls*) printf \'96\\tmain\\t%s\\tclosed\\ttrue\\n\' "$MERGED_SHA" ;;',
  // The listing: every closed pull request against the default branch.
  '  *state=closed*) printf \'%s\\t96\\n\' "$MERGED_SHA" ;;',
  // Open pull requests. None, unless a test says otherwise.
  '  *state=open*) : ;;',
  '  *) exit 1 ;;',
].join('\n');

// Builds a checkout whose branch tip is a known sha, with `origin` pointing at
// github.com so the merged-PR path is reachable, and a stubbed `gh` on PATH.
// `stub` receives the arguments as one string and returns what gh should print,
// or null to make it exit non-zero, which is how an unreadable list is spelled.
function withStubbedGh(stub, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-merged-pr-'));
  const repo = path.join(dir, 'work');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', stdio: 'pipe' });

  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');

  // A branch carrying work that main does not have, so ancestry reports it as
  // unmerged and the tree comparison cannot clear it either. That is the state
  // a squash-merged branch is in once main has moved on, and the only thing
  // that can clear it is the merged pull request.
  g('checkout', '-qb', 'feature');
  fs.appendFileSync(path.join(repo, 'f.txt'), 'work\n');
  g('commit', '-qam', 'work');
  g('checkout', '-q', 'main');
  fs.appendFileSync(path.join(repo, 'f.txt'), 'something else entirely\n');
  g('commit', '-qam', 'unrelated');
  const tip = g('rev-parse', 'feature').trim();

  g('remote', 'add', 'origin', 'https://github.com/example/repo.git');

  const script = `#!/bin/sh\ncase "$*" in\n${stub}\nesac\n`;
  fs.writeFileSync(path.join(bin, 'gh'), script);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  try {
    return fn({ repo, tip, dir, g });
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `only` is the pre-delete re-check, and it is the path that refused a branch
// the listing had just cleared. Both paths ask now, which is what makes the two
// answers the same answer.
checkWriteTree('the pre-delete check clears a branch its listing cleared', () => {
  withStubbedGh(
    GH_MERGED,
    ({ repo, tip }) => {
      process.env.MERGED_SHA = tip;
      try {
        const r = collect.localBranches(repo, { only: 'feature' });
        const feature = r.branches.find((b) => b.name === 'feature');
        assert.ok(feature, 'the branch asked about was not returned');
        assert.strictEqual(feature.merged, true,
          'a merged pull request whose head is this tip is evidence the re-check has to see');
        assert.strictEqual(feature.mergedVia, 'merged in #96',
          'and it reads the same as the remote path, so the two can be seen to agree');
      } finally {
        delete process.env.MERGED_SHA;
      }
    }
  );
});

// The safety property that keying on the tip buys. A branch reused after its
// pull request merged has a name matching a merged pull request and a tip that
// is new work, and clearing it on the name would delete that work.
checkWriteTree('a branch reused after its pull request merged is not cleared', () => {
  withStubbedGh(
    GH_MERGED,
    ({ repo, tip, g }) => {
      // The pull request merged at this tip, so both halves below run against
      // one unchanging piece of evidence and only the branch moves.
      process.env.MERGED_SHA = tip;
      try {
        // Cleared while the branch still points at the merged commit. Asserted
        // here rather than taken from the test above, so that the pair is what
        // fails if the keying is ever loosened to the branch name: on a name
        // both halves would clear, and only having both in one test shows that.
        const before = collect.localBranches(repo, { only: 'feature' })
          .branches.find((b) => b.name === 'feature');
        assert.strictEqual(before.merged, true,
          'the branch is at the merged commit, so the evidence applies');

        g('checkout', '-q', 'feature');
        fs.appendFileSync(path.join(repo, 'f.txt'), 'later, unmerged work\n');
        g('commit', '-qam', 'more');
        g('checkout', '-q', 'main');

        const after = collect.localBranches(repo, { only: 'feature' })
          .branches.find((b) => b.name === 'feature');
        assert.strictEqual(after.merged, false,
          'the evidence is about a commit this branch no longer points at');
      } finally {
        delete process.env.MERGED_SHA;
      }
    }
  );
});

// Unreadable is not empty. Nothing gains evidence, and the run says so rather
// than presenting a Keep list that looks settled.
checkWriteTree('an unreadable merged pull request list is reported, not assumed empty', () => {
  withStubbedGh('  *) exit 1 ;;', ({ repo }) => {
    const r = collect.localBranches(repo, { only: 'feature' });
    const feature = r.branches.find((b) => b.name === 'feature');
    assert.strictEqual(feature.merged, false, 'no list means no evidence, never a clearance');
    assert.strictEqual(r.mergedPRCheckUnavailable, true,
      'and the caller has to be told the answer is partial');
  });
});

// The mirror of it, and the reason the flag is conditioned on the host. A
// repository that pushes nowhere near GitHub has no pull requests to miss, so
// reporting a gap would be inventing one.
// The re-check asks about one commit, not about every closed pull request.
//
// The paginated walk is right for a listing, which asks once and answers for
// every branch, and wrong for the check that runs once per delete: twenty
// branches would repeat it twenty times, and a walk that exceeds its limit
// returns null, so a branch the listing just cleared gets refused. That is the
// contradiction this release removes, arriving as a timeout instead.
checkWriteTree('the pre-delete check asks about one commit, not the whole history', () => {
  withStubbedGh(
    // Records what was asked, and refuses the paginated form outright so that
    // using it fails loudly here rather than merely being slower in the field.
    [
      '  *commits/*/pulls*) printf \'96\\tmain\\t%s\\tclosed\\ttrue\\n\' "$MERGED_SHA" ;;',
      '  *state=closed*) echo "PAGINATED" >> "$GH_CALLS"; exit 1 ;;',
      '  *state=open*) : ;;',
      '  *) exit 1 ;;',
    ].join('\n'),
    ({ repo, tip, dir }) => {
      const calls = path.join(dir, 'calls.log');
      process.env.MERGED_SHA = tip;
      process.env.GH_CALLS = calls;
      try {
        const r = collect.localBranches(repo, { only: 'feature' });
        const feature = r.branches.find((b) => b.name === 'feature');
        assert.strictEqual(feature.merged, true,
          'the single-commit query has to be enough on its own');
        assert.strictEqual(feature.mergedVia, 'merged in #96');
        assert.ok(!fs.existsSync(calls),
          'the re-check must not walk every closed pull request');
      } finally {
        delete process.env.MERGED_SHA;
        delete process.env.GH_CALLS;
      }
    }
  );
});

// Parity on the other protection. This path hardcoded `false` because it had no
// way to ask, which was defensible while it asked GitHub nothing at all. Once
// it clears branches on GitHub evidence and calls the two paths one answer, a
// branch whose review is still running would be kept by `--repo` and offered
// locally, which is the same drift in a new place.
checkWriteTree('a branch with an open pull request is not offered locally either', () => {
  withStubbedGh(
    [
      '  *state=open*) echo "feature" ;;',
      '  *state=closed*) printf \'%s\\t96\\n\' "$MERGED_SHA" ;;',
      '  *commits/*/pulls*) printf \'96\\tmain\\t%s\\topen\\tfalse\\n\' "$MERGED_SHA" ;;',
      '  *) exit 1 ;;',
    ].join('\n'),
    ({ repo, tip }) => {
      process.env.MERGED_SHA = tip;
      try {
        const listed = collect.localBranches(repo)
          .branches.find((b) => b.name === 'feature');
        assert.strictEqual(listed.hasOpenPR, true,
          'an open pull request has to reach the classifier from a local run too');
      } finally {
        delete process.env.MERGED_SHA;
      }
    }
  );
});

// Kept for the right reason, not merely kept.
//
// A branch whose pull requests could not be read carries `hasOpenPR: true` so
// that it stays, which is correct. Printing that as "it has an open pull
// request" is not: it states a fact nobody established, and it sends someone
// looking for a review that may not exist. Found by running the degraded path
// rather than reported, and it is a defect this round introduced, because the
// local path had no open-PR evidence to fail at until this change gave it some.
checkWriteTree('a branch kept because nobody could look says so, and does not invent a review', () => {
  withStubbedGh('  *) exit 1 ;;', ({ repo }) => {
    const b = collect.localBranches(repo).branches.find((x) => x.name === 'feature');
    assert.strictEqual(b.hasOpenPR, true, 'it still has to be kept');
    assert.strictEqual(b.openPRUnknown, true, 'and the reason has to say why');

    const out = execFileSync('node', [CLI, '--cwd', repo], { encoding: 'utf8' });
    assert.ok(/pull requests could not be read/.test(out),
      'the printed reason has to name the uncertainty');
    assert.ok(!/it has an open pull request/.test(out),
      'and must not assert a review that was never confirmed');
  });
});

// The mirror. A real open pull request still reads as one, so the test above
// cannot be satisfied by a run that has stopped detecting them at all.
checkWriteTree('a branch with a pull request genuinely open still says exactly that', () => {
  withStubbedGh(
    [
      '  *state=open*) echo "feature" ;;',
      '  *state=closed*) : ;;',
      '  *commits/*/pulls*) : ;;',
      '  *) exit 1 ;;',
    ].join('\n'),
    ({ repo }) => {
      const b = collect.localBranches(repo).branches.find((x) => x.name === 'feature');
      assert.strictEqual(b.hasOpenPR, true);
      assert.strictEqual(b.openPRUnknown, false, 'this one was actually checked');

      const out = execFileSync('node', [CLI, '--cwd', repo], { encoding: 'utf8' });
      assert.ok(/it has an open pull request/.test(out));
      assert.ok(!/pull requests could not be read/.test(out));
    }
  );
});

// Unreadable is not empty, on the path that reports it to a reader who asked by
// name. The local path carried this from the start and the remote one did not,
// which made the note the local path prints wrong at the moment it mattered.
check('a direct repository check reports an unreadable merged list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-remote-caveat-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // Answers the repository and branch queries, refuses the merged list. That is
  // the shape of an expired token against a repository that is still readable.
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *pulls*) exit 1 ;;',
    '  *repos/*/branches*) printf \'feature\\tdeadbeef\\n\' ;;',
    '  *repos/*/commits/*) echo \'{"d":"2026-07-01T00:00:00Z"}\' ;;',
    '  *repos/*/compare/*) echo \'{"a":3}\' ;;',
    '  *repos/*) echo \'{"default_branch":"main"}\' ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'gh'), 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prevPath}`;
  try {
    const r = collect.remoteBranches('example/repo');
    assert.strictEqual(r.mergedPRCheckUnavailable, true,
      'the remote path has to report a merged list it could not read');
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('a repository with no GitHub origin reports no gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-no-origin-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  g('add', '.'); g('commit', '-qm', 'base');
  g('branch', 'other');

  const r = collect.localBranches(dir);
  assert.strictEqual(r.mergedPRCheckUnavailable, false,
    'no GitHub origin means nothing was missed');
  const out = execFileSync('node', [CLI, '--cwd', dir], { encoding: 'utf8' });
  assert.ok(!/merged pull requests for this repository could not be read/.test(out),
    'and nothing is said about it');

  fs.rmSync(dir, { recursive: true, force: true });
});

fs.unlinkSync(fixture);

// The skip count goes INSIDE the last line, and that is the whole point rather
// than a formatting preference. run-all.js shows one line per suite, and it
// takes the last non-empty one (tests/run-all.js:41). A count printed above
// that line is invisible to every full run, which is the only way most people
// see this suite.
//
// The first version of this printed the count on its own line, directly above a
// pass message that then read identically to a complete run. It carried a
// comment saying a summary that reads identically to a full run hides what was
// skipped, and it produced exactly that summary. Saying it and doing it are two
// different edits.
const skipNote = skipped > 0
  ? ` (${skipped} skipped: this git lacks merge-tree --write-tree, which arrived in 2.38,`
    + ' so squash-merge evidence went untested)'
  : '';
process.stdout.write(failures === 0
  ? `\nAll stale-branch tests passed${skipNote}.\n`
  : `\n${failures} test(s) failed${skipNote}.\n`);
process.exit(failures === 0 ? 0 : 1);
