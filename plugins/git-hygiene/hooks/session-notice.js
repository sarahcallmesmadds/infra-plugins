#!/usr/bin/env node
// SessionStart notice: mentions merged-and-undeleted branches once, quietly.
//
// Deliberately narrow. It counts ONLY branches in the current checkout whose
// commits are all already in the default branch, which is the set that can be
// removed without losing anything. It never mentions branches holding work,
// because a notice you cannot safely act on is just noise at the top of every
// session, and noise at the top of every session gets the plugin uninstalled.
//
// It never blocks, never asks, and stays silent unless there is something worth
// saying. Any error at all exits 0 without output.
//
// ---------------------------------------------------------------------------
// On time limits, which is the part that was wrong before.
//
// The obvious shape is a setTimeout wrapped around the work. It does not work
// here, and it is worth writing down why, because it looks like it does.
//
// Counting commits costs one `git rev-list` per branch, run through
// execFileSync. execFileSync blocks the event loop for as long as the child
// runs, so a setTimeout callback cannot fire while any of that is happening. A
// timer around the work is not a bound on the work. It is a bound on the idle
// time before the work, which was never the risk.
//
// Two real bounds replace it:
//   1. Every child process gets its own `timeout`, in collect.js. That stops
//      one stuck git call hanging forever.
//   2. A wall-clock deadline is handed to localBranches, which checks it
//      between branches and stops counting once it passes.
//
// Measured before the fix: 4145 ms on a 200-branch repository, against a
// promised 4000 ms bound, and that was empty local commits. Real ones are
// slower.
'use strict';

const path = require('path');

// The whole hook, from stdin to output. Session start is not the moment to be
// thorough, and anything near a second is already too long to spend on a
// convenience notice.
const BUDGET_MS = 1500;
const STDIN_WAIT_MS = 1000;
const MIN_TO_MENTION = 3;

function main(event, deadline) {
  const cwd = (event && event.cwd) || process.cwd();

  const collect = require(path.join(__dirname, '..', 'scripts', 'collect.js'));
  const { classify } = require(path.join(__dirname, '..', 'scripts', 'classify.js'));

  if (!collect.isGitRepo(cwd)) return;

  const { defaultBranch, branches, truncated } = collect.localBranches(cwd, { deadline });
  if (!defaultBranch || !branches.length) return;

  // A partial count is worse than no notice. "3 branches are merged" when the
  // real number is 40 is a statement someone will act on, and it is wrong.
  // There is nothing in a one-line notice that could carry the caveat. Silence
  // is honest, and /stale-branches gives the full answer with no time limit.
  if (truncated) return;

  const { safe } = classify(branches, {}, Date.now());
  if (safe.length < MIN_TO_MENTION) return;

  const names = safe.slice(0, 5).map((b) => b.name).join(', ');
  const more = safe.length > 5 ? `, and ${safe.length - 5} more` : '';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `${safe.length} branches in this repository are fully merged into ${defaultBranch} `
        + `and can be deleted without losing anything: ${names}${more}. `
        + 'Run /stale-branches to review and clean them up. '
        + 'This count excludes branches that still hold unmerged commits.',
    },
  }));
}

const started = Date.now();

// This timer covers only the wait for stdin, which is the one genuinely idle
// part of this file and therefore the one part a timer can actually interrupt.
const stdinTimer = setTimeout(() => process.exit(0), STDIN_WAIT_MS);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buffer += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(stdinTimer);
  try {
    // Whatever the stdin wait consumed comes out of the same budget, so a slow
    // start cannot buy the work extra time.
    main(buffer ? JSON.parse(buffer) : {}, started + BUDGET_MS);
  } catch (_) {
    // Never surface a bug in a convenience notice as a broken session start.
  }
  process.exit(0);
});
