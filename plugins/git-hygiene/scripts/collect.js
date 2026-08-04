// Gathers branch facts, either from a local checkout or from GitHub.
//
// Both paths produce the same shape so `classify.js` never needs to know where
// the data came from. The important fields are `aheadBy` and `merged`, and
// every path that cannot determine either one says so rather than guessing:
// `aheadBy` becomes null, `merged` stays false.
//
// `merged` exists because `aheadBy` cannot see a squash merge. The two paths
// answer it differently, since only one of them can reach GitHub. Locally it is
// a tree comparison; remotely it is the merged pull request list.

'use strict';

const { execFileSync } = require('child_process');

// Every child process gets a time limit and a buffer limit.
//
// execFileSync blocks the event loop for as long as the child runs, so a
// setTimeout in the caller cannot fire while it is running. A timer wrapped
// around a series of these calls therefore bounds nothing. The bound has to be
// on the child itself, which is what the `timeout` option does.
const PER_COMMAND_TIMEOUT_MS = 5000;
const MAX_BUFFER = 8 * 1024 * 1024;

function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PER_COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  }, opts || {})).trim();
}

function tryRun(cmd, args, opts) {
  try {
    return run(cmd, args, opts);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- local ----

function isGitRepo(cwd) {
  return tryRun('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']) === 'true';
}

// opts.deadline is an epoch milliseconds value. Counting commits costs one git
// call per branch, so on a repository with hundreds of branches the total is
// unbounded even when each individual call is fast. A caller that has to finish
// inside a budget, the session-start hook being the one that matters, passes a
// deadline and gets `truncated: true` rather than a wrong answer late.
//
// Branches not reached keep `aheadBy: null`, which classify.js treats as
// unmerged. So a truncated run under-reports what is safe and never over-
// reports it.
//
// A branch that ancestry calls unmerged costs a second call, the tree
// comparison below. The deadline is still checked once per branch and still
// bounds the loop; the effect of the extra call is that a run under pressure
// truncates a little earlier, which errs towards keeping.
function localBranches(cwd, opts) {
  const deadline = (opts && opts.deadline) || null;
  let truncated = false;
  const current = tryRun('git', ['-C', cwd, 'branch', '--show-current']) || '';

  // Prefer the remote's idea of the default branch, then fall back to whatever
  // exists. Assuming "main" outright is how a repo on "master" ends up with its
  // trunk in the deletable list.
  let def = tryRun('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (def) def = def.replace(/^origin\//, '');
  if (!def) {
    for (const candidate of ['main', 'master']) {
      if (tryRun('git', ['-C', cwd, 'rev-parse', '--verify', candidate])) { def = candidate; break; }
    }
  }
  if (!def) return { defaultBranch: null, branches: [] };

  const listed = tryRun('git', ['-C', cwd, 'for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/']);
  if (!listed) return { defaultBranch: def, branches: [] };

  // The default branch's own tree, read once. A branch whose merge into `def`
  // produces this exact tree adds nothing `def` does not already have. If this
  // cannot be read the comparison is simply not attempted, and every branch
  // falls back to ancestry alone.
  const defTree = tryRun('git', ['-C', cwd, 'rev-parse', `${def}^{tree}`]);

  const branches = listed.split('\n').filter(Boolean).map((line) => {
    const [name, date] = line.split('\t');
    let aheadBy = null;
    let merged = false;
    let mergedVia = null;
    if (name === def) {
      aheadBy = 0;
    } else if (deadline !== null && Date.now() >= deadline) {
      // Out of time. Leave aheadBy null so this branch is kept, not offered.
      truncated = true;
    } else {
      // `rev-list --count def..name` is the number of commits on `name` that
      // are not reachable from `def`. That is exactly the question being asked.
      const n = tryRun('git', ['-C', cwd, 'rev-list', '--count', `${def}..${name}`]);
      if (n !== null && /^\d+$/.test(n)) aheadBy = parseInt(n, 10);

      // Ancestry says nothing about a squash merge, which rewrites the branch
      // into one new commit and leaves the originals unreachable. So ask the
      // question that survives it: does merging this branch into `def` change
      // `def` at all? An identical resulting tree means it does not.
      //
      // Only worth asking when ancestry already said "unmerged". A conflicting
      // merge exits non-zero, `tryRun` returns null, and the branch is kept.
      // Not knowing is never rounded up into permission to delete.
      if (aheadBy !== null && aheadBy > 0 && defTree) {
        const t = tryRun('git', ['-C', cwd, 'merge-tree', '--write-tree', def, name]);
        if (t !== null && t.split('\n')[0] === defTree) {
          merged = true;
          mergedVia = 'already in the default branch';
        }
      }
    }
    return {
      name,
      lastCommitDate: date,
      aheadBy,
      merged,
      mergedVia,
      isDefault: name === def,
      isCurrent: name === current,
      hasOpenPR: false,
      remote: false,
    };
  });

  return { defaultBranch: def, branches, truncated };
}

// --------------------------------------------------------------- remote ----

function ghJSON(args) {
  const out = tryRun('gh', args);
  if (out === null) return null;
  try { return JSON.parse(out); } catch (_) { return null; }
}

// Splits `gh --paginate --jq` scalar output into a list.
//
// Do NOT ask jq for `[.[].name]` alongside --paginate. The filter is applied to
// each page separately, so a repository with more than one page emits several
// complete JSON arrays back to back: `["a","b"]["c","d"]`. That is not a JSON
// document, JSON.parse throws, and the natural `|| []` fallback turns a repo
// full of branches into an empty list. The tool then says there is nothing to
// clean up, which is the worst possible failure for something whose whole job
// is noticing things you forgot about.
//
// Asking for scalars instead (`.[].name`) gives one value per line, and pages
// concatenate into more lines rather than into invalid JSON.
function toLines(out) {
  if (out === null || out === undefined) return null;
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function ghLines(args) {
  return toLines(tryRun('gh', args));
}

function remoteBranches(repo) {
  const meta = ghJSON(['api', `repos/${repo}`]);
  if (!meta || !meta.default_branch) return { defaultBranch: null, branches: [], error: `cannot read repos/${repo}` };
  const def = meta.default_branch;

  const names = ghLines(['api', `repos/${repo}/branches?per_page=100`, '--paginate', '--jq', '.[].name']);

  // A failed listing is not an empty listing. Returning [] here would report a
  // clean repository, which reads as good news and is unfalsifiable from the
  // output. Same principle as a null aheadBy in classify.js: not knowing is
  // never rounded down to nothing.
  if (names === null) {
    return { defaultBranch: def, branches: [], error: `could not list branches for ${repo}` };
  }

  // One list call rather than one lookup per branch. A branch with an open PR
  // is kept whatever its merge state, and asking per branch would be dozens of
  // API calls for a fact one call already answers.
  const prs = ghLines(['api', `repos/${repo}/pulls?state=open&per_page=100`, '--paginate', '--jq', '.[].head.ref']);

  // An unreadable PR list is also not an empty one. Treating it as empty drops
  // the open-PR protection, so a merged branch with review still on it would be
  // offered as safe. Fail into "assume every branch might have one" instead.
  const prsUnknown = prs === null;
  const openPR = new Set(prs || []);

  // Merged pull requests, this path's answer to the question the local path
  // settles with a tree comparison. A squash merge closes the pull request as
  // merged while leaving the branch's own commits unreachable, so this is the
  // only signal here that survives it. The number comes back too, because
  // "merged in #51" is checkable and a bare "merged" is not.
  //
  // Unreadable is not empty here either, but it fails the other way round from
  // the open-PR list above: with no merged list, no branch gains the second
  // signal and every one falls back to ancestry. That keeps too much rather
  // than deleting too much, which is the direction this plugin errs in
  // everywhere.
  const mergedLines = ghLines(['api', `repos/${repo}/pulls?state=closed&per_page=100`, '--paginate',
    '--jq', '.[] | select(.merged_at != null) | "\\(.head.ref)\\t\\(.number)"']);

  // First merged PR wins. A branch name reused across several PRs is reported
  // by whichever merged first, which is enough to establish that the name's
  // work reached the default branch at least once. The per-branch tree state is
  // still what ancestry reports; this only ever adds evidence.
  const mergedPR = new Map();
  for (const line of mergedLines || []) {
    const [ref, num] = line.split('\t');
    if (ref && num && !mergedPR.has(ref)) mergedPR.set(ref, num);
  }

  const branches = names.map((name) => {
    let aheadBy = null;
    let lastCommitDate = null;

    // encodeURIComponent turns `feature/x` into `feature%2Fx`. Both the compare
    // and commits endpoints accept that form and resolve it to the same ref as
    // a literal slash, verified against a real slash-named branch. Encoding is
    // kept because it is also what stops a name containing `?`, `#` or `..`
    // from changing which endpoint is being called.
    const commit = ghJSON(['api', `repos/${repo}/commits/${encodeURIComponent(name)}`, '--jq', '{d: .commit.committer.date}']);
    if (commit && commit.d) lastCommitDate = commit.d;

    if (name === def) {
      aheadBy = 0;
    } else {
      const cmp = ghJSON(['api', `repos/${repo}/compare/${encodeURIComponent(def)}...${encodeURIComponent(name)}`, '--jq', '{a: .ahead_by}']);
      // A failed or unparseable comparison stays null. See classify.js: null is
      // treated as "has unmerged work", never as zero.
      if (cmp && typeof cmp.a === 'number') aheadBy = cmp.a;
    }

    const mergedNum = mergedPR.get(name);

    return {
      name,
      lastCommitDate,
      aheadBy,
      merged: mergedNum !== undefined,
      mergedVia: mergedNum === undefined ? null : `merged in #${mergedNum}`,
      isDefault: name === def,
      isCurrent: false,
      // When the PR list could not be read, every branch is treated as though
      // it might have one open. That keeps everything rather than offering a
      // branch whose review is still running.
      hasOpenPR: prsUnknown ? true : openPR.has(name),
      remote: true,
    };
  });

  return { defaultBranch: def, branches, prsUnknown };
}

module.exports = { isGitRepo, localBranches, remoteBranches, tryRun, ghJSON, ghLines, toLines };
