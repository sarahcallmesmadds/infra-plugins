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

// SessionStart fires for more than starting a session. `resume` continues a
// conversation that already exists and `compact` happens in the middle of one,
// so speaking on either re-injects the same notice into a session that has
// already had it. `startup` and `clear` are the two that genuinely begin a
// fresh context, which is what "once at the start of a session" means.
//
// An absent source is treated as a start, so this still behaves when invoked by
// hand or by a runtime that does not send the field.
const START_SOURCES = ['startup', 'clear'];

function main(event, deadline) {
  const cwd = (event && event.cwd) || process.cwd();

  const source = event && event.source;
  if (source && !START_SOURCES.includes(source)) return;

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

  // Merged AND old. This is the one place `staleAfterDays` decides anything.
  //
  // A branch merged ten minutes ago is safe to delete and is not worth a line
  // at the top of your next session; you were there when it merged. One from
  // March is exactly what this is for. Filtering on age here is also why the
  // setting exists at all: /stale-branches deliberately shows every branch
  // whatever its age, because when you ask directly you want the whole answer.
  const { safe } = classify(branches, {}, Date.now());
  const worthMentioning = safe.filter((b) => b.stale);
  if (worthMentioning.length < MIN_TO_MENTION) return;

  const names = worthMentioning.slice(0, 5).map((b) => b.name).join(', ');
  const more = worthMentioning.length > 5 ? `, and ${worthMentioning.length - 5} more` : '';

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        `${worthMentioning.length} branches in this repository have been sitting fully merged `
        + `into ${defaultBranch} for a while, and can be deleted without losing anything: `
        + `${names}${more}. `
        + 'Run /stale-branches to review and clean them up. It shows every branch, including '
        + 'recently merged ones and any still holding unmerged commits, which this count leaves out.',
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
