#!/usr/bin/env node
// SessionStart notice: mentions merged-and-undeleted branches once, quietly.
//
// Deliberately narrow. It counts ONLY branches in the current checkout whose
// commits are all already in the default branch, which is the set that can be
// removed without losing anything. It never mentions branches holding work,
// because a notice you cannot safely act on is just noise at the top of every
// session, and noise at the top of every session gets the plugin uninstalled.
//
// It also never blocks, never asks, and stays silent unless there is something
// worth saying. Any error at all exits 0 without output.

'use strict';

const path = require('path');

const TIMEOUT_MS = 4000;
const MIN_TO_MENTION = 3;

function main(event) {
  const cwd = (event && event.cwd) || process.cwd();

  const collect = require(path.join(__dirname, '..', 'scripts', 'collect.js'));
  const { classify } = require(path.join(__dirname, '..', 'scripts', 'classify.js'));

  if (!collect.isGitRepo(cwd)) return;

  const { defaultBranch, branches } = collect.localBranches(cwd);
  if (!defaultBranch || !branches.length) return;

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

// A hook that hangs is worse than a hook that says nothing, and counting
// commits on a repository with many branches is not instant.
const timer = setTimeout(() => process.exit(0), TIMEOUT_MS);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buffer += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    main(buffer ? JSON.parse(buffer) : {});
  } catch (_) {
    // Never surface a bug in a convenience notice as a broken session start.
  }
  process.exit(0);
});
