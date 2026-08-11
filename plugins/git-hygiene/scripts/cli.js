#!/usr/bin/env node
// The command behind /stale-branches.
//
// Usage:
//   cli.js                        classify branches in the current checkout
//   cli.js --repo owner/name      classify branches on GitHub instead
//   cli.js --json                 machine-readable output
//   cli.js --input file.json      classify a saved snapshot (used by the tests)
//   cli.js --stale-after 60       age in days at which a branch is marked stale
//   cli.js --now 2026-07-27       fix "today", so output is reproducible
//   cli.js --verify branch        re-check one branch immediately before deleting
//
// --verify exits 0 only when that branch is still safe, and prints the delete
// command to use for it. It exists because the check that runs before a delete
// must be the same check that produced the listing. The skill used to re-read
// an ancestry count in prose, which a squash merge never satisfies, so every
// branch the merge signal cleared was then refused at the last step and the
// user was told something had landed in between. Nothing had.
//
// --stale-after sets the `stale` flag in --json output and nothing else. It does
// NOT filter what is listed and it does NOT affect what is safe to delete. Every
// branch is always listed with its age, because a cleanup command that silently
// hides branches is how a repository comes to look tidier than it is. The flag
// exists because the session hook uses the same threshold to decide what is
// worth mentioning at startup.
//
// This file is what the skill runs and what the tests run. Every bug the
// plugin has shipped so far lived in a printing path that no test executed,
// so the tests drive this, not the functions underneath it.

'use strict';

const fs = require('fs');
const path = require('path');
const { classify, DEFAULTS, KEEP, localDeleteCommand, remoteDeleteCommand } = require(path.join(__dirname, 'classify.js'));
const collect = require(path.join(__dirname, 'collect.js'));

function parseArgs(argv) {
  const out = { json: false, repo: null, input: null, staleAfter: DEFAULTS.staleAfterDays, now: null, cwd: process.cwd(), verify: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--stale-after') out.staleAfter = parseInt(argv[++i], 10);
    else if (a === '--now') out.now = argv[++i];
    else if (a === '--verify') out.verify = argv[++i];
  }
  if (!Number.isFinite(out.staleAfter) || out.staleAfter < 0) out.staleAfter = DEFAULTS.staleAfterDays;
  return out;
}

const KEEP_TEXT = {
  [KEEP.DEFAULT_BRANCH]: 'this is the default branch',
  [KEEP.PROTECTED]: 'protected branch',
  [KEEP.CURRENT]: 'you have it checked out',
  [KEEP.OPEN_PR]: 'it has an open pull request',
  [KEEP.UNMERGED]: null, // filled in per branch, it needs the count
  [KEEP.UNKNOWN]: 'could not work out whether it is merged, so treating it as unmerged',
};

function reasonText(b) {
  return b.keepReasons
    .map((r) => (r === KEEP.UNMERGED
      ? `${b.aheadBy} commit${b.aheadBy === 1 ? '' : 's'} not in the default branch`
      : KEEP_TEXT[r]))
    .filter(Boolean)
    .join(', ');
}

function age(b) {
  if (b.ageDays === null) return 'age unknown';
  if (b.ageDays === 0) return 'today';
  if (b.ageDays === 1) return '1 day old';
  return `${b.ageDays} days old`;
}

function render(result, where, lookup) {
  const lines = [];
  const safe = result.safe.slice().sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
  const keep = result.keep
    .filter((b) => !b.keepReasons.includes(KEEP.DEFAULT_BRANCH))
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));

  if (safe.length === 0 && keep.length === 0) {
    lines.push(`No branches besides the default one in ${where}. Nothing to clean up.`);
    return lines.join('\n');
  }

  lines.push(`${where}: ${safe.length + keep.length} branches besides the default one.`);
  lines.push('');

  if (safe.length) {
    lines.push(`Safe to delete (${safe.length}) — the default branch already has this work:`);
    for (const b of safe) {
      lines.push(`  ${b.name}  (${age(b)}${b.mergedVia ? `, ${b.mergedVia}` : ''})`);
    }
  } else {
    lines.push('Safe to delete (0).');
  }
  lines.push('');

  // The comparison ran against a ref the remote has since moved past, so
  // anything merged in between is sitting in Keep with a commit count beside it.
  // Said here rather than left implied, because a stale answer and a current one
  // look exactly alike on screen.
  //
  // The ref is named by the lookup rather than assumed to be `origin/<default>`.
  // A single-branch or shallow clone has no remote-tracking ref at all, and the
  // comparison falls back to the local branch there, so naming a ref the reader
  // does not have sends them looking for something that never existed.
  if (lookup && lookup.remoteStale) {
    const ref = lookup.remoteStaleRef || `origin/${lookup.defaultBranch || 'main'}`;
    lines.push('');
    lines.push(`Note: this compared against \`${ref}\`, and the remote has moved past it since`);
    lines.push('it was last updated. Anything merged in between is listed under Keep with a');
    lines.push('commit count, which is what an unmerged branch looks like too.');
    lines.push('Run `git fetch` and try again for a current answer.');
  }

  // Said out loud rather than left to look like a clean result. Without the
  // comparison, a squash-merged branch is indistinguishable here from one
  // holding real work, and every one of them lands in Keep.
  if (lookup && lookup.mergeCheckUnavailable) {
    lines.push('');
    lines.push('Note: this git cannot run `merge-tree --write-tree`, which needs 2.38 or newer,');
    lines.push('so squash-merged branches could not be detected and are listed under Keep.');
    lines.push('Nothing here is wrong, but the list may be longer than it needs to be.');
    lines.push('`--repo owner/name` uses merged pull requests instead and does not need it.');
  }

  // The origin is on GitHub and its merged pull requests could not be read, so
  // the run is missing the one piece of evidence that survives a squash merge
  // into a default branch that has since moved on. Said plainly, because the
  // alternative is a Keep list that looks settled and is not: this is the exact
  // shape of the answer that disagreed with `--repo` for the same repository.
  if (lookup && lookup.mergedPRCheckUnavailable) {
    lines.push('');
    lines.push('Note: the merged pull requests for this repository could not be read, so a');
    lines.push('branch squash-merged before the default branch moved on may be listed under');
    lines.push('Keep. Check `gh auth status`, then try again. `--repo owner/name` asks GitHub');
    lines.push('directly and will say so if it cannot reach it.');
  }

  if (keep.length) {
    lines.push(`Keep (${keep.length}) — deleting these would lose work:`);
    for (const b of keep) lines.push(`  ${b.name}  (${age(b)}) — ${reasonText(b)}`);
  } else {
    lines.push('Keep (0).');
  }

  return lines.join('\n');
}

// Re-check one branch and print the command that should delete it.
//
// Exit 0 means still safe, and stdout carries the reason followed by the exact
// command. The caller runs what this decided rather than composing its own,
// which is the whole point: a re-check that asks a different question from the
// listing will disagree with it, and the disagreement gets reported to the user
// as though something changed.
//
// Exit 3 means do not delete. A branch that has disappeared since the listing
// lands here too, because something the caller cannot find is not something it
// should be deleting.
function verifyOne(result, name, repo, lookup) {
  const b = result.all.find((x) => x.name === name);
  if (!b) {
    // "Gone" and "could not look" both stop the delete, and only one of them
    // is a fact about the branch. Reporting the wrong one during a cleanup
    // reads as "already tidied", which is how someone stops looking for work
    // that is still there.
    if (lookup && lookup.unreadable) {
      process.stderr.write(`Could not check ${name}, so it was not deleted. `
        + 'This is not the same as the branch being gone: nothing could be read, '
        + 'so nothing is known either way.\n');
      return 3;
    }
    process.stderr.write(`${name} is not in this repository any more. Nothing to delete.\n`);
    return 3;
  }
  if (!b.safeToDelete) {
    process.stderr.write(`${name} is no longer safe to delete: ${reasonText(b)}. Nothing deleted.\n`);
    return 3;
  }

  process.stdout.write(`${b.name} is safe to delete: ${b.mergedVia || 'every commit is already in the default branch'}\n`);

  // A branch cleared by merge evidence rather than by ancestry will be refused
  // by `git branch -d`, every time, because git asks only whether the commits
  // are reachable and a squash merge rewrites them. Saying so here is the
  // difference between an expected refusal and one reported to the user as
  // though something changed underneath them.
  //
  // The command printed below is still `-d`. Forcing past a refusal is the
  // user's decision and the skill asks for it; nothing in this tool composes
  // `-D` on their behalf.
  if (!repo && b.merged) {
    process.stdout.write('needs-force: git branch -d will refuse this. It only checks whether the '
      + 'commits are reachable from the default branch, and a squash merge rewrites them, so the '
      + 'refusal is expected rather than a disagreement.\n');
  }

  const cmd = repo ? remoteDeleteCommand(repo, b.name) : localDeleteCommand(b.name);
  process.stdout.write(`${cmd.join(' ')}\n`);
  return 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = opts.now ? Date.parse(opts.now) : Date.now();

  let branches;
  let where;
  let lookup = null;

  if (opts.input) {
    const snapshot = JSON.parse(fs.readFileSync(opts.input, 'utf8'));
    branches = snapshot.branches;
    where = snapshot.where || opts.input;
  } else if (opts.repo) {
    // --verify asks about one branch, so it collects one branch. The full
    // listing walks every closed pull request in the repository, and running
    // that once per branch being deleted is the difference between four API
    // calls and a full pagination per deletion.
    const r = opts.verify
      ? collect.remoteBranch(opts.repo, opts.verify)
      : collect.remoteBranches(opts.repo);
    if (r.error || !r.defaultBranch) {
      process.stderr.write(`Could not read ${opts.repo} from GitHub. Is gh logged in, and does the repo exist?\n`);
      process.exit(2);
    }
    branches = opts.verify ? (r.branch ? [r.branch] : []) : r.branches;
    lookup = r;
    where = opts.repo;
  } else {
    if (!collect.isGitRepo(opts.cwd)) {
      process.stderr.write('Not inside a git repository. Pass --repo owner/name to check a repository on GitHub instead.\n');
      process.exit(2);
    }
    const r = collect.localBranches(opts.cwd, opts.verify ? { only: opts.verify } : undefined);
    if (!r.defaultBranch) {
      process.stderr.write('Could not work out the default branch, so nothing can be compared against it. Nothing was classified.\n');
      process.exit(2);
    }
    branches = r.branches;
    lookup = r;
    where = opts.cwd;
  }

  const result = classify(branches, { staleAfterDays: opts.staleAfter }, now);

  if (opts.verify) {
    process.exit(verifyOne(result, opts.verify, opts.repo, lookup));
  }

  if (opts.json) {
    // The caveats ride along, because the text output carries them and a caller
    // parsing this one otherwise gets the same answer with the reasons to
    // distrust it stripped off. `--json --cwd .` against a checkout that has not
    // fetched is exactly the case this release exists to stop being silent.
    //
    // All of them are always present, never omitted when false. A key that
    // appears only when something is wrong cannot be told apart from an older
    // version that never had it, and a consumer reading `undefined` as "fine"
    // is the failure being fixed rather than a new one.
    process.stdout.write(JSON.stringify({
      where,
      remoteStale: !!(lookup && lookup.remoteStale),
      remoteStaleRef: (lookup && lookup.remoteStaleRef) || null,
      mergeCheckUnavailable: !!(lookup && lookup.mergeCheckUnavailable),
      mergedPRCheckUnavailable: !!(lookup && lookup.mergedPRCheckUnavailable),
      safe: result.safe,
      keep: result.keep,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(render(result, where, lookup) + '\n');
  }
}

if (require.main === module) main();

module.exports = { parseArgs, render, reasonText, age };
