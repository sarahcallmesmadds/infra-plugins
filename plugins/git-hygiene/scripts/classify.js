// Decides which branches are safe to delete and which are not.
//
// The whole plugin turns on one distinction: a branch being OLD and a branch
// being MERGED are unrelated. Age is why you notice a branch. Merge state is
// the only thing that decides whether deleting it loses work. A tool that
// conflates the two eats months of unpushed work and reports success.
//
// So: only positive evidence of a merge can put a branch in the safe list, and
// anything uncertain fails into the unsafe list. There is deliberately no
// option to override that, because the override is the bug.
//
// There are two kinds of positive evidence, and `merged` is the second one.
// `aheadBy` reads ancestry, which a squash merge never creates: the branch is
// rewritten into one new commit on the default branch, so its own commits stay
// unreachable and `aheadBy` stays above zero permanently. In a repository that
// squash-merges every pull request, ancestry alone can never clear a branch.
// `merged` carries the other kind: a merged pull request, or a tree comparison
// showing the branch adds nothing the default branch does not already have.
//
// This is not the override the paragraph above rules out. `merged` is positive
// evidence, not a way to ignore the absence of it. A branch with no merge
// evidence and `aheadBy` above zero is still kept, and an `aheadBy` we could
// not determine is still kept whatever `merged` says.

'use strict';

const DEFAULTS = {
  // Never offered for deletion, whatever their merge state.
  protectedBranches: ['main', 'master', 'develop', 'release'],

  // How long a merged branch sits before the session notice will mention it.
  //
  // This is the ONLY thing this setting decides. It does not make anything
  // deletable, and it does not filter what /stale-branches lists. Every branch
  // is always shown with its age, because a cleanup command that hides rows is
  // worse than one that shows too many.
  staleAfterDays: 30,
};

// Reasons a branch is not safe to delete. Kept as codes so the skill can
// explain each one in the user's own terms rather than parsing prose.
const KEEP = {
  DEFAULT_BRANCH: 'default-branch',
  PROTECTED: 'protected',
  UNMERGED: 'unmerged',
  UNKNOWN: 'merge-state-unknown',
  OPEN_PR: 'open-pr',
  CURRENT: 'checked-out',
};

function daysBetween(thenISO, nowMs) {
  const then = Date.parse(thenISO);
  if (Number.isNaN(then)) return null;
  return Math.floor((nowMs - then) / 86400000);
}

// branch: {
//   name, lastCommitDate (ISO), aheadBy (int|null), isDefault, isCurrent,
//   hasOpenPR (bool), merged (bool), mergedVia (string|null), remote (bool)
// }
//
// `merged` is positive evidence that the work is already in the default branch
// by some route ancestry cannot see. `mergedVia` is the human-readable reason,
// carried through so the caller can say WHICH route rather than asserting a
// merge with nothing to check it against.
//
// `now` is passed in rather than read from the clock so the tests are not
// time-dependent and so a caller can classify a snapshot taken earlier.
function classifyBranch(branch, config, now) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const ageDays = daysBetween(branch.lastCommitDate, now);
  const out = {
    name: branch.name,
    remote: !!branch.remote,
    ageDays,
    stale: ageDays !== null && ageDays >= cfg.staleAfterDays,
    aheadBy: branch.aheadBy,
    merged: !!branch.merged,
    mergedVia: branch.mergedVia || null,
    safeToDelete: false,
    keepReasons: [],
  };

  if (branch.isDefault) out.keepReasons.push(KEEP.DEFAULT_BRANCH);
  if (cfg.protectedBranches.includes(branch.name)) out.keepReasons.push(KEEP.PROTECTED);
  if (branch.isCurrent) out.keepReasons.push(KEEP.CURRENT);
  if (branch.hasOpenPR) out.keepReasons.push(KEEP.OPEN_PR);

  // The order matters. `null` means we could not work out the merge state,
  // which is not the same as zero and must never be treated as zero. A missing
  // comparison is the exact circumstance in which a wrong answer is expensive.
  //
  // `merged` is checked only against a non-zero `aheadBy`, never against a null
  // one. Unknown ancestry plus a merge signal is still one fact missing, and
  // this is the branch of the code where a wrong answer costs work.
  if (branch.aheadBy === null || branch.aheadBy === undefined) {
    out.keepReasons.push(KEEP.UNKNOWN);
  } else if (branch.aheadBy > 0 && !out.merged) {
    out.keepReasons.push(KEEP.UNMERGED);
  }

  out.safeToDelete = out.keepReasons.length === 0;
  return out;
}

function classify(branches, config, now) {
  const nowMs = now === undefined ? Date.now() : now;
  const all = branches.map((b) => classifyBranch(b, config, nowMs));
  return {
    safe: all.filter((b) => b.safeToDelete),
    keep: all.filter((b) => !b.safeToDelete),
    all,
  };
}

// The delete command for a LOCAL branch.
//
// `-d` refuses to delete a branch holding commits that are not merged, so git
// itself is a second opinion on top of our classification, and it is the
// default here for that reason.
//
// That second opinion is ancestry-based, so it shares the exact blind spot the
// `merged` signal exists to cover: it refuses a squash-merged branch every
// time, however certain we are. Leaving `-d` as the only option meant every
// branch the new signal cleared was listed as safe, approved by the user, and
// then refused at the last step with a message saying git disagreed. Nothing
// disagreed. Git was answering a question it cannot answer for that branch.
//
// This file still never produces `-D`, and there is no argument that makes it.
// The refusal is real and it is the user's to override, not ours to route
// around: `cli.js --verify` reports that the refusal is expected and says why,
// and the skill asks before forcing anything. A module that hands back `-D`
// removes a decision from a person who should be making it.
function localDeleteCommand(name) {
  if (typeof name !== 'string' || name.trim() === '' || name.startsWith('-')) {
    throw new Error(`refusing to build a delete command for branch name: ${JSON.stringify(name)}`);
  }
  return ['git', 'branch', '-d', name];
}

// The delete call for a REMOTE branch, via the GitHub API.
//
// This one has no second opinion. The API deletes whatever ref you name,
// merged or not, so every safety check has to have happened before this point.
// It is a separate function from the local one for exactly that reason: the
// two have different risk and should not look interchangeable at a call site.
function remoteDeleteCommand(repo, name) {
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`refusing to build a delete call for repo: ${JSON.stringify(repo)}`);
  }
  if (typeof name !== 'string' || name.trim() === '' || name.startsWith('-')) {
    throw new Error(`refusing to build a delete call for branch name: ${JSON.stringify(name)}`);
  }
  return ['gh', 'api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${name}`];
}

module.exports = {
  DEFAULTS,
  KEEP,
  classify,
  classifyBranch,
  localDeleteCommand,
  remoteDeleteCommand,
};
