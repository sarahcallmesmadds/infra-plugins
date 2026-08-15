#!/usr/bin/env node
// Regression tests for the /built-check evidence window.
//
// Run: node tests/built-check.test.js
//
// /built-check is prose rather than code, so there is no function to call. What
// can be tested is the shell it tells the model to run, and the behaviour of
// the tools underneath it. Both are pinned here, because the bug this covers
// lived exactly in the gap between them: the instruction looked right, git did
// something else, and the result was indistinguishable from a clean answer.
//
// The fault: Step 2 built the cutoff as a bare `%Y-%m-%d` and Step 3a passed it
// to `git log --since=`. Given a date with no time, git fills in the CURRENT
// CLOCK TIME rather than midnight, so every commit made earlier that day was
// dropped. For an item created today the git half of the evidence was empty
// every single run, and /built-check reported "no sign of it" on work that had
// been committed hours before.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL = path.join(
  __dirname, '..', 'plugins', 'build-loop', 'skills', 'built-check', 'SKILL.md'
);
const text = fs.readFileSync(SKILL, 'utf8');

let failed = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

// --- what the skill tells the model to run --------------------------------

check('the cutoff is built with an explicit time, not a bare date', () => {
  const dateCalls = text.match(/date -u [^\n`]*%Y-%m-%d[^\n`]*/g) || [];
  assert.ok(dateCalls.length > 0, 'no date command found in the skill at all');
  for (const call of dateCalls) {
    assert.ok(
      /%Y-%m-%d[ T]00:00:00/.test(call),
      `cutoff is built as a bare date, which git reads as the current time of day: ${call}`
    );
  }
});

check('the cutoff says which zone it is in', () => {
  // The other half of the same fault. A timestamp with no zone is read by git
  // as local time, and this cutoff is computed with `date -u`. On a UTC-4
  // machine that starts the window four hours late, further east it starts
  // early, and either way the count looks plausible.
  const dateCalls = text.match(/date -u [^\n`]*%Y-%m-%d[^\n`]*/g) || [];
  for (const call of dateCalls) {
    assert.ok(
      /%Y-%m-%dT00:00:00Z|\+0000/.test(call),
      `cutoff carries no timezone, so git reads a UTC value as local: ${call}`
    );
  }
});

check('git really does read an unzoned timestamp as local time', () => {
  // The reason the Z is needed, measured rather than asserted.
  //
  // The claim is that the same digits mean a different instant depending on
  // whether a zone is given. It is tempting to test that by checking the
  // unzoned form finds fewer commits, and that only holds west of UTC. East of
  // it the unzoned form resolves EARLIER and finds more, so a direction-based
  // assertion fails on correct code in half the world.
  //
  // Writing `D` for the cutoff digits read as UTC and `off` for
  // getTimezoneOffset() in minutes, positive west of UTC, git resolves the
  // unzoned form to `D + off`. So a commit placed halfway between `D` and
  // `D + off` falls inside exactly one of the two windows, whichever side of
  // UTC the machine is on. Which one flips with the sign; that they differ
  // does not, and that is the actual claim.
  const off = new Date().getTimezoneOffset();
  if (Math.abs(off) < 2) {
    console.log('        (skipped, this machine is within two minutes of UTC so the'
      + ' two forms mean the same instant)');
    return;
  }

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'built-check-tz-'));
  const cutoffUtc = new Date(Date.now() - 12 * 3600 * 1000);
  const commitAt = new Date(cutoffUtc.getTime() + (off / 2) * 60 * 1000);
  const stamp = commitAt.toISOString().replace(/\.\d+Z$/, 'Z');

  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '-A');
  git('commit', '-m', 'halfway between the two readings of one cutoff');

  const count = (since) =>
    execFileSync('git', ['-C', repo, 'log', `--since=${since}`, '--oneline'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length;

  const zoned = cutoffUtc.toISOString().replace(/\.\d+Z$/, 'Z');
  const unzoned = zoned.replace('T', ' ').replace('Z', '');

  assert.notStrictEqual(
    count(zoned), count(unzoned),
    'the same digits with and without a zone selected the same commits, so git now '
    + 'reads an unzoned timestamp as UTC. The Z is no longer load-bearing and the '
    + 'explanation in built-check SKILL.md is out of date.'
  );

  // And the direction, which is what makes it a hazard rather than a curiosity.
  if (off > 0) {
    assert.strictEqual(count(zoned), 1, 'west of UTC the zoned window should hold the commit');
    assert.strictEqual(count(unzoned), 0, 'west of UTC the unzoned window starts late and should miss it');
  } else {
    assert.strictEqual(count(zoned), 0, 'east of UTC the zoned window starts after the commit');
    assert.strictEqual(count(unzoned), 1, 'east of UTC the unzoned window starts early and picks it up');
  }

  fs.rmSync(repo, { recursive: true, force: true });
});

check('both date implementations are still covered', () => {
  // BSD and macOS take -v, GNU and Linux take -d. Losing either one fails the
  // same silent way the bare date did.
  assert.ok(/date -u -v-/.test(text), 'the BSD/macOS -v form is gone');
  assert.ok(/date -u -d /.test(text), 'the GNU/Linux -d form is gone');
});

check('an empty git window is reported rather than folded into the verdicts', () => {
  // Every way this step fails ends at "no commits", which reads exactly like a
  // correct result. Saying the log came back empty is the only thing that
  // separates "nothing was built" from "nothing was looked at".
  assert.ok(
    /git log returned nothing/i.test(text),
    'nothing tells the user when the window came back completely empty'
  );
});

// --- and the behaviour underneath it --------------------------------------

check('git reads a bare date as the current time of day, not midnight', () => {
  // The reason the fix is needed. If git ever changes this, this test fails and
  // the comment above stops being true, which is worth knowing either way.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'built-check-repo-'));
  const today = new Date().toISOString().slice(0, 10);
  // One second past midnight today. Anything but a midnight-anchored window
  // misses it, unless the suite is run in the first second of the day.
  const stamp = `${today}T00:00:01`;

  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });

  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '-A');
  git('commit', '-m', 'committed just after midnight today');

  const count = (since) =>
    execFileSync('git', ['-C', repo, 'log', `--since=${since}`, '--oneline'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length;

  const withMidnight = count(`${today} 00:00:00`);
  assert.strictEqual(withMidnight, 1, 'a midnight-anchored window missed a commit made today');

  // Skip the negative half if the suite genuinely is running at midnight, since
  // then the bare form and the midnight form mean the same thing.
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    console.log('        (skipped the bare-date half, it is currently midnight)');
  } else {
    assert.strictEqual(
      count(today), 0,
      'git now treats a bare date as midnight. The fix is no longer needed and the '
      + 'explanation in built-check SKILL.md is out of date.'
    );
  }

  fs.rmSync(repo, { recursive: true, force: true });
});

// --- searched, versus looked at and not found -----------------------------
//
// Run on 2026-08-14, /built-check reported "no sign of it" for all 12 open
// items. Seven of those were never searched: five name a repository that is not
// checked out on this machine and two record no destination at all. The output
// had no slot for "there was nowhere to look", so an unsearched item printed in
// the same list, in the same words, as one that was searched and genuinely is
// not built. Those two findings call for opposite responses.

check('there is a fourth verdict for an item nothing could look for', () => {
  assert.ok(
    /\*\*not searched\*\*/.test(text),
    'the verdict table has no row for an item no configured root covers'
  );
});

check('the skill asks roots.js rather than deciding it in prose', () => {
  assert.ok(
    /roots\.js["'\s]+covers/.test(text),
    'nothing calls roots.js covers, so the rule is re-derived by reading on every run'
  );
});

check('found evidence outranks the unsearched verdict', () => {
  // A destination goes stale when plans change, so an item can name a
  // repository nobody has checked out and still turn up in a configured root.
  // Without this, real evidence is thrown away in favour of a field nobody
  // updated.
  assert.ok(
    /never (move|downgrade) it to "not searched"|Evidence beats 3d/i.test(text),
    'nothing says that evidence found on disk or in the log wins over 3d'
  );
});

check('an all-unsearched run does not read as an all-clean run', () => {
  // The exact 2026-08-14 output: a flat "no sign that any of them have been
  // built" for a list that was more than half unsearchable. Both numbers have
  // to appear, or the sentence is the bug.
  assert.ok(
    /could not be searched/.test(text) && /The other \{Q\} were searched/.test(text),
    'the every-item-fails path still collapses "not searched" into "not built"'
  );
});

check('an unsearched item cannot be closed by number', () => {
  assert.ok(
    /never numbered and never closeable/i.test(text),
    'nothing stops the user closing an item that was never looked for'
  );
});

check('Step 7 names the repository that would have to be configured', () => {
  assert.ok(
    /not a configured root, so they were not searched/.test(text)
    && /build-loop\.config\.json/.test(text),
    'the report does not say which repository is missing or where to add it'
  );
});

check('every count in the report has its own placeholder', () => {
  // Review round 1. {P} meant "files that failed to parse", and three new lines
  // reused it for the not-searched total, the unreachable-destination count and
  // the no-destination count. These are literal templates filled in by reading
  // them, so a symbol standing for four quantities prints one of them where
  // another was meant, with nothing to catch it.
  const notes = text.match(/^- `(?:Note: )?\{[A-Z]\}[^`]*`$/gm) || [];
  assert.ok(notes.length >= 4, `expected the four counted notes, found ${notes.length}`);
  const letters = notes.map((n) => n.match(/\{([A-Z])\}/)[1]);
  assert.strictEqual(
    new Set(letters).size, letters.length,
    `two notes share a placeholder: ${letters.join(', ')}`
  );
  assert.ok(/\{F\} files failed to parse/.test(text), 'the parse-failure count lost its own letter');
});

check('a root that has moved is kept apart from one nobody configured', () => {
  // Different remedies. One wants a path repaired, the other a root added, and
  // sending somebody to add a root they already configured points them at the
  // one thing that is not wrong.
  assert.ok(/root-missing/.test(text), 'the skill does not handle the root-missing answer');
  assert.ok(
    /fix the path rather than adding one/i.test(text),
    'nothing tells the reader the remedy differs from the not-covered case'
  );
});

console.log(`\n14 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
