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

// ------------------------------------------------------- moved projects ----
//
// The bug: /pickup could not find a handoff after its repo directory moved.
// searchPaths covered only ~/Projects/<slug>, and the index held the same stale
// path, so both missed together. It reported "no match", which is the same thing
// it says when no handoff was ever written, so the failure looked like an
// absence rather than a move.

function writeConfig(home, value) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'session.config.json'), JSON.stringify(value));
}

check('the default is the single root that used to be hardcoded', () => {
  const home = tmpHome();
  assert.deepStrictEqual(handoffs.projectRoots(home), [path.join(home, 'Projects')]);
});

check('a handoff under a second configured root is found by name', () => {
  const home = tmpHome();
  writeConfig(home, { projectRoots: ['~/Projects', '~/src'] });
  const repo = path.join(home, 'src', 'moved-app');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'HANDOFF.md'), '# Session Handoff\n');
  const found = handoffs.findHandoff('moved-app', home);
  assert.ok(found, 'a repo under a configured root must be reachable without an index entry');
  assert.strictEqual(found.path, path.join(repo, 'HANDOFF.md'));
});

check('a miss names the recorded path instead of only the guesses', () => {
  const home = tmpHome();
  const repo = path.join(home, 'Projects', 'plugins');
  const { target } = roundTrip(repo, home);
  fs.rmSync(repo, { recursive: true });
  const out = cli(['find', target.slug, '--json'], home);
  assert.strictEqual(out.match, null, 'a stale entry must still degrade to not found');
  assert.ok(out.stale, 'the recorded path is the one fact worth reporting on a miss');
  assert.strictEqual(out.stale.path, target.path);
});

check('a moved project reads as unreachable, not as a deleted handoff', () => {
  // Its whole directory went with it, so entryState cannot tell this from an
  // unmounted volume and the message must not claim the handoff was deleted.
  const home = tmpHome();
  const repo = path.join(home, 'Projects', 'gone-away');
  const { target } = roundTrip(repo, home);
  fs.rmSync(repo, { recursive: true });
  assert.strictEqual(handoffs.staleRecord(target.slug, home).state, 'unreachable');
});

check('a deleted handoff in a surviving directory reads as gone', () => {
  const home = tmpHome();
  const repo = path.join(home, 'Projects', 'still-here');
  const { target } = roundTrip(repo, home);
  fs.rmSync(target.path);
  assert.strictEqual(handoffs.staleRecord(target.slug, home).state, 'gone');
});

check('a slug that was never recorded reports no stale path', () => {
  const home = tmpHome();
  assert.strictEqual(handoffs.staleRecord('never-existed', home), null);
  assert.strictEqual(cli(['find', 'never-existed', '--json'], home).stale, null);
});

check('a handoff that is present reports no stale path', () => {
  const home = tmpHome();
  const repo = path.join(home, 'Projects', 'present');
  const { target } = roundTrip(repo, home);
  assert.strictEqual(handoffs.staleRecord(target.slug, home), null);
});

check('unusable roots are dropped and an empty list falls back', () => {
  // Searching nowhere finds nothing, which is indistinguishable from the bug
  // this section exists for, so an empty list must never be honoured.
  const home = tmpHome();
  writeConfig(home, { projectRoots: [null, '', 42, '  ', '~/src'] });
  assert.deepStrictEqual(handoffs.projectRoots(home), [path.join(home, 'src')]);
  writeConfig(home, { projectRoots: [] });
  assert.deepStrictEqual(handoffs.projectRoots(home), [path.join(home, 'Projects')]);
  writeConfig(home, { projectRoots: 'not-a-list' });
  assert.deepStrictEqual(handoffs.projectRoots(home), [path.join(home, 'Projects')]);
});

check('an absolute root is used as given, not joined onto home', () => {
  const home = tmpHome();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'roots-'));
  writeConfig(home, { projectRoots: [elsewhere] });
  assert.deepStrictEqual(handoffs.projectRoots(home), [elsewhere]);
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

// ------------------------------------------------- forget and the prune ----
//
// `target` added entries and nothing ever removed one, so the index only ever
// grew. Every lookup verifies the file exists, so a stale entry was harmless
// on its own, and clearing a single one meant hand-editing JSON.
//
// The subtle one is the repoint. The sweep moves a document into archived/ and
// used to leave the index pointing at where it had been, which turned an entry
// for a handoff this very command had just archived into a dead entry. Adding
// a prune without following the move would have deleted that entry as rubbish.

const AGE = (file, days) => {
  const t = (Date.now() - days * 86400000) / 1000;
  fs.utimesSync(file, t, t);
};

check('forget drops the entry and leaves the document alone', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'keeper');
  const { target } = roundTrip(repo, home);
  assert.ok(handoffs.readIndex(home).keeper, 'setup: the entry was not recorded');

  const out = cli(['forget', 'keeper', '--json'], home);
  assert.strictEqual(out.removed, true);
  assert.strictEqual(out.fileStillThere, true, 'it should report that the document survives');
  assert.ok(!handoffs.readIndex(home).keeper, 'the entry is still in the index');
  assert.ok(fs.existsSync(target.path), 'forget deleted the handoff, which it must never do');
});

check('forget says so when the document was already gone', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'vanished');
  const { target } = roundTrip(repo, home);
  fs.rmSync(target.path);
  const out = cli(['forget', 'vanished', '--json'], home);
  assert.strictEqual(out.removed, true);
  assert.strictEqual(out.fileStillThere, false);
});

check('forget on an unknown slug changes nothing', () => {
  const home = tmpHome();
  roundTrip(path.join(home, 'code', 'real'), home);
  const before = JSON.stringify(handoffs.readIndex(home));
  const out = cli(['forget', 'never-existed', '--json'], home);
  assert.strictEqual(out.removed, false);
  assert.strictEqual(JSON.stringify(handoffs.readIndex(home)), before, 'the index was rewritten anyway');
});

check('forget with no slug does not empty the index', () => {
  // The shape worth guarding: a missing argument slugifying to "" and matching
  // everything, or being written back as a key.
  const home = tmpHome();
  roundTrip(path.join(home, 'code', 'survivor'), home);
  const out = cli(['forget', '--json'], home);
  assert.strictEqual(out.removed, false);
  assert.ok(handoffs.readIndex(home).survivor, 'a bare forget removed a real entry');
});

check('forget normalises the slug the same way everything else does', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'My.Repo');
  roundTrip(repo, home);
  assert.ok(handoffs.readIndex(home)['my-repo'], 'setup: recorded under an unexpected key');
  const out = cli(['forget', 'My.Repo', '--json'], home);
  assert.strictEqual(out.removed, true, 'the name a person would type did not match the stored key');
});

check('forget prints which of the two things happened', () => {
  // Whether the document survived decides whether anything was lost, so it has
  // to be in the text rather than left to be inferred from silence.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'printed');
  roundTrip(repo, home);
  const out = cli(['forget', 'printed'], home);
  assert.match(out.raw, /untouched/i, out.raw);
  assert.match(out.raw, /HANDOFF\.md/, out.raw);
});

check('the sweep drops entries whose files are gone', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'deleted-later');
  roundTrip(repo, home);
  fs.rmSync(path.join(repo, 'HANDOFF.md'));

  const out = cli(['archive', '--json'], home);
  assert.deepStrictEqual(out.pruned.map((p) => p.slug), ['deleted-later']);
  assert.ok(!handoffs.readIndex(home)['deleted-later'], 'the dead entry is still there');
});

check('the sweep never drops an entry whose file is present', () => {
  const home = tmpHome();
  roundTrip(path.join(home, 'code', 'alive'), home);
  const out = cli(['archive', '--json'], home);
  assert.deepStrictEqual(out.pruned, []);
  assert.ok(handoffs.readIndex(home).alive, 'the sweep dropped a live entry');
});

check('the sweep follows a document it archives instead of forgetting it', () => {
  // Without the repoint this entry looks exactly like one whose file was
  // deleted, and the prune added in the same change would throw it away.
  const home = tmpHome();
  const t = cli(['target', 'ancient', '--cwd', home, '--json'], home);
  fs.writeFileSync(t.path, 'old');
  AGE(t.path, 60);

  const out = cli(['archive', '--json'], home);
  assert.deepStrictEqual(out.moved, ['ancient']);
  assert.deepStrictEqual(out.pruned, [], 'the entry was pruned rather than followed');
  assert.deepStrictEqual(out.repointed.map((r) => r.slug), ['ancient']);

  const entry = handoffs.readIndex(home).ancient;
  assert.ok(entry, 'the entry was dropped');
  assert.strictEqual(entry.path, path.join(handoffs.archiveRoot(home), 'HANDOFF-ancient.md'));
  assert.strictEqual(entry.kind, 'archived', 'pickup can no longer say it was archived');
  assert.strictEqual(handoffs.findHandoff('ancient', home).kind, 'archived');
});

check('a dry run reports the prune without performing it', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'dry');
  roundTrip(repo, home);
  fs.rmSync(path.join(repo, 'HANDOFF.md'));

  const out = cli(['archive', '--dry-run', '--json'], home);
  assert.deepStrictEqual(out.pruned.map((p) => p.slug), ['dry']);
  assert.ok(handoffs.readIndex(home).dry, 'a dry run edited the index');
});

check('an entry whose directory cannot be read is kept, not pruned', () => {
  // The unmounted volume. Project handoffs live next to their work and work
  // lives on external disks and network shares, where existsSync says false
  // for something that is merely offline. The index holds the one location
  // that cannot be reconstructed, so pruning on that answer loses the ability
  // to find a document that is still perfectly there.
  const home = tmpHome();
  const volume = path.join(home, 'Volumes', 'work');
  const repo = path.join(volume, 'offsite');
  roundTrip(repo, home);
  assert.ok(handoffs.readIndex(home).offsite, 'setup');

  fs.rmSync(volume, { recursive: true, force: true });   // the disk goes away

  const out = cli(['archive', '--json'], home);
  assert.deepStrictEqual(out.pruned, [], 'an offline handoff was pruned');
  assert.deepStrictEqual(out.unreachable.map((u) => u.slug), ['offsite']);
  assert.ok(handoffs.readIndex(home).offsite, 'the only pointer to that handoff was destroyed');
});

check('the entry comes back to life when the volume returns', () => {
  const home = tmpHome();
  const volume = path.join(home, 'Volumes', 'work');
  const repo = path.join(volume, 'offsite');
  const { target } = roundTrip(repo, home);
  const body = fs.readFileSync(target.path, 'utf8');

  fs.rmSync(volume, { recursive: true, force: true });
  cli(['archive', '--json'], home);
  assert.strictEqual(cli(['find', 'offsite', '--json'], home).match, null, 'found while offline');

  fs.mkdirSync(repo, { recursive: true });               // remounted
  fs.writeFileSync(target.path, body);
  const found = cli(['find', 'offsite', '--json'], home);
  assert.ok(found.match, 'the handoff is back but pickup can no longer find it by name');
  assert.strictEqual(found.match.path, target.path);
});

check('a file missing from a directory that is right there is still pruned', () => {
  // The other side of it. Conservatism that never prunes anything would make
  // the sweep pointless, and this is the case that prompted the command.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'really-deleted');
  roundTrip(repo, home);
  fs.rmSync(path.join(repo, 'HANDOFF.md'));              // directory stays

  const out = cli(['archive', '--json'], home);
  assert.deepStrictEqual(out.pruned.map((p) => p.slug), ['really-deleted']);
  assert.deepStrictEqual(out.unreachable, []);
});

check('a dry run previews the repoints as well as the moves', () => {
  // A preview that omits one of the three things the sweep does is not a
  // preview of the sweep.
  const home = tmpHome();
  const t = cli(['target', 'previewed', '--cwd', home, '--json'], home);
  fs.writeFileSync(t.path, 'old');
  AGE(t.path, 60);

  const out = cli(['archive', '--dry-run', '--json'], home);
  assert.deepStrictEqual(out.moved, ['previewed']);
  assert.deepStrictEqual(out.repointed.map((r) => r.slug), ['previewed'], 'the repoint was not previewed');
  assert.strictEqual(handoffs.readIndex(home).previewed.kind, 'central', 'a dry run edited the index');
  assert.ok(fs.existsSync(t.path), 'a dry run moved a file');
});

check('an index that could not be written is not reported as changed', () => {
  // writeIndex swallows its errors on purpose, so it must never be treated as
  // having succeeded. Reporting work that did not reach the disk is the exact
  // shape this plugin keeps catching in itself.
  const home = tmpHome();
  const repo = path.join(home, 'code', 'unwritable');
  roundTrip(repo, home);
  fs.rmSync(path.join(repo, 'HANDOFF.md'));

  const root = handoffs.handoffRoot(home);
  fs.chmodSync(root, 0o500);                             // readable, not writable
  try {
    const out = cli(['archive', '--json'], home);
    assert.deepStrictEqual(out.pruned.map((p) => p.slug), ['unwritable']);
    assert.strictEqual(out.indexWritten, false, 'a failed write was reported as a completed prune');
    assert.ok(handoffs.readIndex(home).unwritable, 'setup: the entry should still be on disk');

    const human = cli(['archive'], home);
    assert.match(human.raw, /could not be written/i, human.raw);
  } finally {
    fs.chmodSync(root, 0o700);
  }
});

check('the sweep says out loud that it touched the index', () => {
  const home = tmpHome();
  const repo = path.join(home, 'code', 'quietly');
  roundTrip(repo, home);
  fs.rmSync(path.join(repo, 'HANDOFF.md'));
  const out = cli(['archive'], home);
  assert.match(out.raw, /Dropped 1 index entry/, out.raw);
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

// ------------------------------------------------ the wrap summary step ----
//
// Wrap reported a handoff it had never written, because Step 4 carried
// "Handoff saved to [path]" as fixed text with nothing checking the file
// first. Step 2 now ends by running `cli.js find`, and Step 4 may only claim
// success when that returned a match.
//
// The first version of that fix left both lines inside the template block and
// put the condition underneath as prose, which is the same shape as the bug:
// the part read first states the good outcome plainly, and the qualification
// arrives afterwards where it is easy to skim. So the template must not
// contain the success lines at all. They live below it, under a stated
// condition, alongside the failure ending.
//
// Source assertions, because the thing being pinned is what the instructions
// say. Whether a model follows them is what the live run is for.

const WRAP = fs.readFileSync(path.join(ROOT, 'skills', 'wrap', 'SKILL.md'), 'utf8');
const STEP_4 = WRAP.slice(WRAP.indexOf('## Step 4: Show the summary'));

check('step 2 ends by checking the file, not the index', () => {
  const step2 = WRAP.slice(WRAP.indexOf('## Step 2: Write the handoff'), WRAP.indexOf('## Step 3'));
  assert.match(step2, /cli\.js find/, 'Step 2 must verify the write landed');
});

check('the summary template does not carry the success lines', () => {
  // The regression: both lines sitting in the block that gets copied.
  const firstBlock = STEP_4.slice(STEP_4.indexOf('```'), STEP_4.indexOf('```', STEP_4.indexOf('```') + 3));
  assert.doesNotMatch(firstBlock, /Handoff saved to/,
    'the saved line must not be inside the template, or it gets printed unconditionally');
  assert.doesNotMatch(firstBlock, /\/pickup \[slug\]/,
    'the pickup line must not be inside the template either');
});

check('the success ending is stated as conditional before it appears', () => {
  const cond = STEP_4.indexOf('returned a match');
  const saved = STEP_4.indexOf('Handoff saved to');
  assert.ok(cond !== -1, 'the match condition should be stated');
  assert.ok(saved !== -1, 'the saved ending should still exist');
  assert.ok(cond < saved, 'the condition must come before the line it governs');
});

check('the failure ending exists and does not offer a pickup slug', () => {
  assert.match(STEP_4, /Handoff was NOT written to/);
  const failing = STEP_4.slice(STEP_4.indexOf('Handoff was NOT written to'));
  assert.match(failing, /Do not print the `\/pickup` line/,
    'a slug pointing at no file sends the next session looking for nothing');
});

// ------------------------------------------------- carrying constraints ----
// Added 2026-08-09, with the defect each one exists to catch.

check('a constraints section at the end of a file is read', () => {
  // The one that shipped broken. The terminator was written `\Z`, which
  // JavaScript has no such assertion for, so it matched a literal Z and the
  // section only ended at the next `## ` heading. Constraints written last in
  // the document, which is where they usually land, read back as none at all,
  // and the command cheerfully reported zero. Every fixture written by hand had
  // a heading afterwards, so the unit tests agreed with it.
  const got = handoffs.constraintsIn('# H\n\n## Constraints still in force\n- only one\n');
  assert.deepStrictEqual(got, ['only one']);
});

check('a retired constraint is not carried forward as a live one', () => {
  const got = handoffs.constraintsIn(
    '## Constraints still in force\n- live one\n- Retired this session: old one, because reasons.\n'
  );
  assert.deepStrictEqual(got, ['live one'],
    'a line recording that a constraint was dropped would otherwise keep it alive for ever');
});

check('a retirement is readable, not only droppable', () => {
  // Dropping the line at parse time and stopping there is what made retirement
  // inert: the document doing the retiring never carries the constraint, so the
  // only place it can be honoured is across documents.
  const got = handoffs.retiredIn(
    '## Constraints still in force\n- live one\n- Retired this session: old one, because reasons.\n'
  );
  assert.deepStrictEqual(got, ['old one, because reasons.']);
});

check('an unfilled template bullet is not a constraint', () => {
  const got = handoffs.constraintsIn(
    '## Constraints still in force\n- [what governs future work, and the handoff it came from]\n'
  );
  assert.deepStrictEqual(got, []);
});

check('the real wrap template placeholder is excluded', () => {
  // Reads the template rather than a copy of it. The fixture above passes
  // against a placeholder written to suit the parser; this fails if the two
  // ever disagree, which is the only way the check is worth having.
  const wrap = fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'session', 'skills', 'wrap', 'SKILL.md'), 'utf8'
  );
  const block = wrap.match(/```markdown\n([\s\S]*?)```/);
  assert.ok(block, 'the handoff template is gone');
  assert.deepStrictEqual(handoffs.constraintsIn(block[1]), [],
    'the template placeholder reads back as a real constraint, so every handoff written from it carries a fake one');
});

check('a constraint written as a markdown link survives', () => {
  // Dropped by the first version, which treated any leading `[` as a
  // placeholder. Naming a document is the single most likely thing a constraint
  // does, and a link is the natural way to write it, so the filter deleted
  // exactly the constraints that mattered most, without a word.
  const got = handoffs.constraintsIn(
    '## Constraints still in force\n- [the design system](docs/design.md) governs anything under site/\n'
  );
  assert.deepStrictEqual(got, ['[the design system](docs/design.md) governs anything under site/']);
});

check('constraints stop at the next heading, including a nested one', () => {
  assert.deepStrictEqual(
    handoffs.constraintsIn('## Constraints still in force\n- mine\n\n## Decisions made\n- not mine\n'),
    ['mine']
  );
  // `^##\s` does not match `### Notes`, because the character after `##` is a
  // `#` rather than whitespace, so a nested subsection did not close the block
  // and its bullets were collected as constraints.
  assert.deepStrictEqual(
    handoffs.constraintsIn('## Constraints still in force\n- mine\n\n### Notes\n- not mine\n'),
    ['mine']
  );
});

check('a worktree shares a scope with its main checkout', () => {
  // The mismatch that hid the AlwaysAllow design system: one handoff recorded
  // the repository, the next recorded a worktree of it, and a path compare said
  // they were unrelated projects.
  //
  // This builds a real linked worktree. The earlier version compared the repo
  // root with a subdirectory of the same checkout, which exercises none of the
  // `--git-common-dir` behaviour the feature rests on, and failed outside a git
  // checkout because both sides fell back to different real paths.
  const { execFileSync } = require('child_process');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
  const repo = path.join(base, 'repo');
  const tree = path.join(base, 'tree');
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    fs.mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 't'], repo);
    fs.writeFileSync(path.join(repo, 'f'), 'x');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'x'], repo);
    git(['worktree', 'add', '-q', tree], repo);

    assert.strictEqual(handoffs.scopeKey(tree), handoffs.scopeKey(repo),
      'a linked worktree must resolve to the same scope as its main checkout');
    assert.notStrictEqual(fs.realpathSync(tree), fs.realpathSync(repo),
      'the two paths must genuinely differ, or this proves nothing');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

check('both handoff header spellings give up the directory', () => {
  assert.strictEqual(handoffs.handoffDir('**Working directory:** /tmp/x'), '/tmp/x');
  assert.strictEqual(handoffs.handoffDir('**Repository:** `/tmp/y`'), '/tmp/y',
    'handoffs written before the current template say Repository, and those are the old ones holding constraints');
});

check('a handoff with no constraints section contributes nothing', () => {
  assert.deepStrictEqual(handoffs.constraintsIn('# H\n\n## Decisions made\n- a\n'), []);
});

// Retirement across documents, which is the only place it can happen and the
// only place it was never tested. The unit check above passes against a broken
// implementation, because it asks the parser a question the parser answers
// correctly while the behaviour the feature promises does not work at all.
function withHandoffs(docs, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-'));
  const dir = path.join(home, '.planning', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  let t = Date.now() - docs.length * 60000;
  for (const [slug, body] of docs) {
    const p = path.join(dir, `HANDOFF-${slug}.md`);
    fs.writeFileSync(p, body);
    t += 60000;                       // written oldest first, so mtime orders them
    fs.utimesSync(p, new Date(t), new Date(t));
  }
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

check('retiring a constraint actually removes it', () => {
  const cwd = path.join(__dirname, '..');
  const scope = `**Working directory:** ${cwd}`;
  withHandoffs([
    ['older', `${scope}\n\n## Constraints still in force\n- Use the glow outline everywhere.\n`],
    ['newer', `${scope}\n\n## Constraints still in force\n- Retired this session: Use the glow outline everywhere, because it distracted.\n`],
  ], (home) => {
    const r = handoffs.carriedConstraints({ cwd, home });
    assert.deepStrictEqual(r.constraints.map((c) => c.text), [],
      'the older handoff still lists it live, so retirement has to suppress across documents or it does nothing');
    assert.deepStrictEqual(r.unmatchedRetirements, [],
      'this retirement matched, so it must not be reported as a typo');
  });
});

check('a retirement that matches nothing is reported, not swallowed', () => {
  const cwd = path.join(__dirname, '..');
  const scope = `**Working directory:** ${cwd}`;
  withHandoffs([
    ['older', `${scope}\n\n## Constraints still in force\n- Use the glow outline everywhere.\n`],
    ['newer', `${scope}\n\n## Constraints still in force\n- Retired this session: use the glo outline everywhere, because typo.\n`],
  ], (home) => {
    const r = handoffs.carriedConstraints({ cwd, home });
    assert.strictEqual(r.constraints.length, 1, 'a mistyped retirement must not remove anything');
    assert.strictEqual(r.unmatchedRetirements.length, 1,
      'a retirement that silently does nothing is the same defect as a constraint that silently vanishes');
  });
});

check('a constraint restated after being retired comes back', () => {
  const cwd = path.join(__dirname, '..');
  const scope = `**Working directory:** ${cwd}`;
  withHandoffs([
    ['a-oldest', `${scope}\n\n## Constraints still in force\n- No production deploys.\n`],
    ['b-middle', `${scope}\n\n## Constraints still in force\n- Retired this session: No production deploys, because launch.\n`],
    ['c-newest', `${scope}\n\n## Constraints still in force\n- No production deploys.\n`],
  ], (home) => {
    const r = handoffs.carriedConstraints({ cwd, home });
    assert.deepStrictEqual(r.constraints.map((c) => c.text), ['No production deploys.'],
      'a constraint put back after being retired is live again; retirement is not permanent');
    assert.strictEqual(r.constraints[0].from, 'c-newest');
  });
});

check('a handoff for another project contributes nothing', () => {
  const cwd = path.join(__dirname, '..');
  withHandoffs([
    ['mine', `**Working directory:** ${cwd}\n\n## Constraints still in force\n- Mine.\n`],
    ['theirs', `**Working directory:** ${os.tmpdir()}\n\n## Constraints still in force\n- Theirs.\n`],
  ], (home) => {
    const r = handoffs.carriedConstraints({ cwd, home });
    assert.deepStrictEqual(r.constraints.map((c) => c.text), ['Mine.']);
  });
});

check('a truncated scan says so', () => {
  const cwd = path.join(__dirname, '..');
  withHandoffs([
    ['one', `**Working directory:** ${cwd}\n\n## Constraints still in force\n- A.\n`],
    ['two', `**Working directory:** ${cwd}\n\n## Constraints still in force\n- B.\n`],
  ], (home) => {
    const r = handoffs.carriedConstraints({ cwd, home, limit: 1 });
    assert.strictEqual(r.truncated, true,
      'a scan that stopped early must say so, or a missing constraint reads as an absent one');
  });
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
