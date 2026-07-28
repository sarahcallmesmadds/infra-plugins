#!/usr/bin/env node
// Regression tests for handoff placement, the archive sweep, the date line and
// the status line version resolver.
//
// Run: node tests/session-handoffs.test.js
//
// Two of these pin bugs that already reached shipped code in this repository,
// one layer along in each case:
//
//   The date line must not be built with toISOString(), which converts to UTC
//   first and therefore reports the wrong calendar day for part of every day.
//   That is the same mistake as handing a bare date to `git log --since=`.
//
//   The status line resolver must prefer the highest version rather than the
//   first one it finds on disk. Superseded version directories are left in
//   place by the plugin manager, so "it exists" and "it is current" are
//   different questions, and only one of them is the one being asked.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const handoffs = require(path.join(ROOT, 'scripts', 'handoffs.js'));
const { todayLine, isoDate, formatOffset } = require(path.join(ROOT, 'scripts', 'today.js'));
const install = require(path.join(ROOT, 'statusline', 'install.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-h-'));

// ------------------------------------------------------------ placement ----

check('a directory with a .git gets its handoff alongside the work', () => {
  const home = tmpHome();
  const repo = path.join(home, 'work', 'thing');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const t = handoffs.writeTarget(repo, 'anything', home);
  assert.strictEqual(t.path, path.join(repo, 'HANDOFF.md'));
  assert.strictEqual(t.kind, 'project');
  assert.strictEqual(t.slug, 'thing', 'the pickup slug is the directory name');
});

check('the home directory never gets a HANDOFF.md dropped in it', () => {
  const home = tmpHome();
  const t = handoffs.writeTarget(home, 'plugin work', home);
  assert.strictEqual(t.kind, 'central');
  assert.ok(!t.path.startsWith(path.join(home, 'HANDOFF')), t.path);
});

check('central handoffs are named by topic, so two do not overwrite each other', () => {
  const home = tmpHome();
  const a = handoffs.writeTarget(home, 'session plugin', home);
  const b = handoffs.writeTarget(home, 'notion cleanup', home);
  assert.notStrictEqual(a.path, b.path);
  assert.match(a.path, /HANDOFF-session-plugin\.md$/);
});

check('a topic with punctuation and case becomes a usable slug', () => {
  assert.strictEqual(handoffs.slugify('Wrap & Pickup: phase 3!'), 'wrap-pickup-phase-3');
});

check('an empty topic still produces a writable path', () => {
  const home = tmpHome();
  const t = handoffs.writeTarget(home, '', home);
  assert.match(t.path, /HANDOFF-session\.md$/);
});

// ----------------------------------------------------------- round trip ----
//
// The bug these exist for: wrap wrote a project handoff next to the work, and
// pickup looked for it only under ~/Projects/<slug>. Anyone whose repositories
// live anywhere else got a wrap that reported success and a pickup that
// reported the handoff did not exist. Both were behaving exactly as written.
//
// The reason it survived a passing suite is the shape of the old tests. One
// asserted where writeTarget puts the file. Another asserted what findHandoff
// locates. Neither ever handed the output of the first to the second, so the
// gap between them was the one thing nothing looked at.
//
// So these drive the CLI end to end, in the order a real wrap does it: ask
// where to write, write there, then look it up by the slug that was printed.

const { spawnSync } = require('child_process');
const CLI = path.join(ROOT, 'scripts', 'cli.js');

function cli(args, home) {
  const run = spawnSync(process.execPath, [CLI, ...args, '--home', home], { encoding: 'utf8' });
  try { return JSON.parse(run.stdout); } catch (_) { return { raw: run.stdout, err: run.stderr }; }
}

function roundTrip(repoPath, home) {
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  const target = cli(['target', 'anything', '--cwd', repoPath, '--json'], home);
  fs.writeFileSync(target.path, '# Session Handoff\n');
  return { target, found: cli(['find', target.slug, '--json'], home) };
}

check('a project outside ~/Projects can be written and then found again', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'elsewhere', 'my-app');
  const { target, found } = roundTrip(repo, home);
  assert.strictEqual(target.path, path.join(repo, 'HANDOFF.md'));
  assert.ok(found.match, `wrap wrote ${target.path} and pickup could not find it`);
  assert.strictEqual(found.match.path, target.path);
});

check('a project at an absolute path far from home round trips', () => {
  const home = tmpHome();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'faraway-'));
  const { target, found } = roundTrip(repo, home);
  assert.ok(found.match, `could not find a handoff at ${target.path}`);
  assert.strictEqual(found.match.path, target.path);
});

check('a directory name with punctuation round trips', () => {
  // writeTarget used to return the raw basename while findHandoff slugified
  // whatever it was given, so `My.Repo` printed a pickup line that then
  // searched for something else entirely.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'My.Repo');
  const { target, found } = roundTrip(repo, home);
  assert.strictEqual(target.slug, 'my-repo');
  assert.ok(found.match, 'the printed slug did not resolve back to the file');
});

check('a central handoff still round trips', () => {
  const home = tmpHome();
  const target = cli(['target', 'session plugin', '--cwd', home, '--json'], home);
  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, '# x');
  const found = cli(['find', target.slug, '--json'], home);
  assert.ok(found.match);
  assert.strictEqual(found.match.kind, 'central');
});

check('a recorded handoff whose file was deleted reports not found', () => {
  // The index is a convenience, never an authority. A stale entry must degrade
  // to "not found" rather than to a confident path that resolves to nothing.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'gone');
  const { target } = roundTrip(repo, home);
  fs.rmSync(target.path);
  assert.strictEqual(cli(['find', target.slug, '--json'], home).match, null);
});

check('a project handoff appears in the menu shown for a bare pickup', () => {
  // Built from the central folder alone, that list showed only the handoffs
  // that were already easy to find by name.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'listed-app');
  roundTrip(repo, home);
  const recent = cli(['recent', '--json'], home);
  assert.ok(recent.handoffs.some((h) => h.slug === 'listed-app'), JSON.stringify(recent));
});

check('recording is skippable, so asking where to write changes nothing', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'unrecorded');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  cli(['target', 'x', '--cwd', repo, '--no-record', '--json'], home);
  assert.deepStrictEqual(handoffs.readIndex(home), {});
});

// --------------------------------------------------------------- lookup ----

check('the central handoff is preferred over the archived copy', () => {
  const home = tmpHome();
  fs.mkdirSync(handoffs.archiveRoot(home), { recursive: true });
  fs.writeFileSync(path.join(handoffs.handoffRoot(home), 'HANDOFF-x.md'), 'live');
  fs.writeFileSync(path.join(handoffs.archiveRoot(home), 'HANDOFF-x.md'), 'old');
  assert.strictEqual(handoffs.findHandoff('x', home).kind, 'central');
});

check('an archived handoff is still found when nothing else matches', () => {
  const home = tmpHome();
  fs.mkdirSync(handoffs.archiveRoot(home), { recursive: true });
  fs.writeFileSync(path.join(handoffs.archiveRoot(home), 'HANDOFF-gone.md'), 'old');
  const found = handoffs.findHandoff('gone', home);
  assert.strictEqual(found.kind, 'archived');
});

check('no match returns null and the tried paths are still available to show', () => {
  const home = tmpHome();
  assert.strictEqual(handoffs.findHandoff('nope', home), null);
  assert.strictEqual(handoffs.searchPaths('nope', home).length, 4);
});

// -------------------------------------------------------------- archive ----

check('handoffs past the threshold are moved, not deleted', () => {
  const home = tmpHome();
  const root = handoffs.handoffRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const old = path.join(root, 'HANDOFF-old.md');
  fs.writeFileSync(old, 'x');
  const longAgo = Date.now() - 60 * 86400000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

  const result = handoffs.archiveStale({ days: 30, home });

  assert.deepStrictEqual(result.moved, ['old']);
  assert.ok(!fs.existsSync(old), 'still in place');
  assert.ok(fs.existsSync(path.join(handoffs.archiveRoot(home), 'HANDOFF-old.md')), 'not in archive');
});

check('a recent handoff is left alone', () => {
  const home = tmpHome();
  const root = handoffs.handoffRoot(home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'HANDOFF-fresh.md'), 'x');
  assert.deepStrictEqual(handoffs.archiveStale({ days: 30, home }).moved, []);
});

check('a dry run reports what it would move and moves nothing', () => {
  const home = tmpHome();
  const root = handoffs.handoffRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const old = path.join(root, 'HANDOFF-old.md');
  fs.writeFileSync(old, 'x');
  const longAgo = Date.now() - 60 * 86400000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

  const result = handoffs.archiveStale({ days: 30, home, dryRun: true });
  assert.deepStrictEqual(result.moved, ['old']);
  assert.ok(fs.existsSync(old), 'a dry run moved a file');
});

check('a missing handoffs directory is reported, not created', () => {
  const home = tmpHome();
  const result = handoffs.archiveStale({ days: 30, home });
  assert.strictEqual(result.skipped, true);
  assert.ok(!fs.existsSync(handoffs.handoffRoot(home)), 'the sweep created a directory');
});

check('files that are not handoffs are never swept', () => {
  const home = tmpHome();
  const root = handoffs.handoffRoot(home);
  fs.mkdirSync(root, { recursive: true });
  const notes = path.join(root, 'my-notes.md');
  fs.writeFileSync(notes, 'x');
  const longAgo = Date.now() - 900 * 86400000;
  fs.utimesSync(notes, longAgo / 1000, longAgo / 1000);
  assert.deepStrictEqual(handoffs.archiveStale({ days: 30, home }).moved, []);
  assert.ok(fs.existsSync(notes));
});

// ---------------------------------------------------------- memory dir ----

check('the memory directory is found via the same slug Claude Code uses', () => {
  // Verified against a captured SessionStart event: cwd
  //   /private/tmp/claude-501/-Users-sarahmadden/3667d77f/scratchpad/capture
  // produced the project directory
  //   -private-tmp-claude-501--Users-sarahmadden-3667d77f-scratchpad-capture
  // including the doubled hyphen where the path itself contained one.
  const home = tmpHome();
  const cwd = '/private/tmp/claude-501/-Users-sarahmadden/abc/scratchpad';
  const slug = '-private-tmp-claude-501--Users-sarahmadden-abc-scratchpad';
  const dir = path.join(home, '.claude', 'projects', slug, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  assert.strictEqual(handoffs.memoryDir(cwd, home), dir);
});

check('a project with no memory directory returns null rather than a path', () => {
  // wrap must not create this. It belongs to the harness.
  const home = tmpHome();
  assert.strictEqual(handoffs.memoryDir('/Users/nobody', home), null);
});

// ------------------------------------------------------------ the date ----

check('the date line reports the local calendar day, not the UTC one', () => {
  // 00:30 on the 28th UTC is still the 27th in New York. toISOString would say
  // the 28th, and every dated file written that evening would be wrong.
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const d = new Date('2026-07-28T00:30:00Z');
    assert.strictEqual(isoDate(d), '2026-07-27');
    assert.match(todayLine(d), /Monday 27 July 2026/);
  } finally {
    process.env.TZ = original;
  }
});

check('the timezone offset carries the sign it is written with, not the one JS returns', () => {
  // getTimezoneOffset is positive west of Greenwich, which is the opposite of
  // how offsets are written. Getting it backwards gives a plausible string that
  // is wrong by twice the offset.
  const original = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.strictEqual(formatOffset(new Date('2026-07-27T12:00:00Z')), '-04:00');
  } finally {
    process.env.TZ = original;
  }
});

check('the date line tells the model not to answer from training data', () => {
  assert.match(todayLine(new Date('2026-07-27T12:00:00Z')), /training data/);
});

// -------------------------------------------------- statusline resolver ----

check('the resolver prefers the newest version, not the first on disk', () => {
  // The plugin manager leaves superseded version directories in place, so a
  // resolver that takes the first match keeps rendering a version that was
  // replaced weeks ago, with nothing to indicate it.
  const home = tmpHome();
  for (const v of ['0.1.0', '0.2.0', '0.10.0']) {
    const dir = path.join(home, '.claude', 'plugins', 'cache', 'smadds', 'session', v, 'statusline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'statusline.js'), '// x');
  }
  const found = install.installedStatuslines(home);
  assert.match(found[0].version, /^0\.10\.0$/, `newest first, got ${found.map((f) => f.version)}`);
});

check('version ordering is numeric, so 0.10 beats 0.9', () => {
  assert.ok(install.compareVersions('0.10.0', '0.9.0') < 0, 'sorts newest first');
  assert.ok(install.compareVersions('1.0.0', '0.99.99') < 0);
});

check('the settings fragment points at the resolver, never at a versioned path', () => {
  const home = tmpHome();
  const fragment = install.settingsFragment(home);
  assert.match(fragment.statusLine.command, /\.claude\/statusline\.js/);
  assert.doesNotMatch(fragment.statusLine.command, /plugins\/cache/);
});

check('installing writes the resolver and reports it, and is idempotent', () => {
  const home = tmpHome();
  const first = install.install({ home });
  assert.strictEqual(first.wrote, true);
  assert.ok(fs.existsSync(first.shimPath));

  const second = install.install({ home });
  assert.strictEqual(second.unchanged, true, 'a second run rewrote an identical file');
});

check('a dry run writes nothing', () => {
  const home = tmpHome();
  const result = install.install({ home, dryRun: true });
  assert.ok(!fs.existsSync(result.shimPath));
});

check('a resolver that finds no plugin says so rather than rendering blank', () => {
  // settings.json pointing here means somebody switched the status line on. A
  // blank line looks exactly like a status line that was never configured, and
  // there is no way to tell the two apart by looking. That is the failure this
  // plugin exists to stop repeating, so the empty case is the one that has to
  // speak.
  const home = tmpHome();
  const { shimPath } = install.install({ home });
  const run = spawnSync(process.execPath, [shimPath], {
    input: '{"model":{"display_name":"Claude"}}', encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  assert.notStrictEqual(run.stdout.trim(), '', 'the resolver rendered nothing at all');
  assert.match(run.stdout, /not found/);
  assert.match(run.stdout, /status-bar/, 'it did not name the fix');
});

check('a resolver with a version installed renders the real line', () => {
  const home = tmpHome();
  const { shimPath } = install.install({ home });
  const v = path.join(home, '.claude', 'plugins', 'cache', 'smadds', 'session', '0.1.0');
  fs.mkdirSync(path.join(v, 'statusline'), { recursive: true });
  fs.mkdirSync(path.join(v, 'scripts'), { recursive: true });
  for (const f of ['config.js', 'mcp-health.js']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(v, 'scripts', f));
  }
  fs.copyFileSync(path.join(ROOT, 'statusline', 'statusline.js'), path.join(v, 'statusline', 'statusline.js'));

  const run = spawnSync(process.execPath, [shimPath], {
    input: '{"model":{"display_name":"Claude 5"},"workspace":{"current_dir":"/tmp/proj"}}',
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  assert.match(run.stdout, /Claude 5/);
  assert.doesNotMatch(run.stdout, /not found/);
});

check('installing with no version on disk yet is reported, not treated as an error', () => {
  // Normal on a first install from a working copy: nothing is in the plugin
  // cache until the marketplace install runs, and the resolver will find it
  // the moment it appears.
  const home = tmpHome();
  assert.deepStrictEqual(install.install({ home }).installedVersions, []);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
