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
  // The reason the Z is needed, measured rather than asserted. If git ever
  // changes this, the explanation in the skill stops being true and we find
  // out here instead of from a wrong answer.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'built-check-tz-'));
  const stamp = new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git('add', '-A');
  git('commit', '-m', 'two hours ago');

  const count = (since) =>
    execFileSync('git', ['-C', repo, 'log', `--since=${since}`, '--oneline'], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).length;

  // One hour before the commit, expressed three ways.
  const t = new Date(Date.now() - 3 * 3600 * 1000);
  const iso = t.toISOString().replace(/\.\d+Z$/, 'Z');
  const bareUtc = iso.replace('T', ' ').replace('Z', '');

  assert.strictEqual(count(iso), 1, 'a zoned UTC cutoff did not find a commit inside the window');

  const offsetMinutes = t.getTimezoneOffset();
  if (offsetMinutes === 0) {
    console.log('        (skipped the unzoned half, this machine runs on UTC)');
  } else {
    assert.notStrictEqual(
      count(bareUtc), 1,
      'git now reads an unzoned timestamp as UTC. The Z is no longer load-bearing '
      + 'and the explanation in built-check SKILL.md is out of date.'
    );
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

console.log(`\n6 checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
