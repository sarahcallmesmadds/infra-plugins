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

// The one call that walks pages proportional to the repository's history rather
// than to its branch count, so it gets its own longer limit. Even filtered to
// pull requests targeting the default branch, a long-lived repository has a lot
// of them. Timing out is safe (every branch falls back to ancestry and is kept)
// but it silently disables the merge signal on exactly the large repositories
// that need it, so the limit is set where that is unlikely rather than where it
// matches the other calls.
const MERGED_PR_TIMEOUT_MS = 20000;

// The only call in the local path that leaves the machine. Short, because what
// it produces is a caveat rather than a fact anything depends on: every branch
// is classified exactly the same way whether this answers or not. A run that
// stalls waiting for it has already cost more than the caveat is worth.
const REMOTE_PROBE_TIMEOUT_MS = 3000;

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

// `merge-tree --write-tree` arrived in git 2.38. Older installations, Ubuntu
// 22.04 LTS among them, exit non-zero on it, and `tryRun` turns that into null,
// which is indistinguishable here from "this branch really does have work". The
// result was that on those machines every squash-merged branch was reported as
// unmerged with nothing saying the question had never been asked.
//
// Probed once per run rather than assumed. Merging a ref into itself is trivial
// and cheap on any version that has the form at all, so the probe answers
// exactly the question, whether this git can be asked.
//
// Probed against the default branch and not against HEAD. HEAD can be unborn in
// a repository that is otherwise fine, right after `git checkout --orphan`, and
// then the probe fails for a reason that has nothing to do with the version and
// the run reports a modern git as too old. The default branch is a ref this
// caller has already resolved.
function supportsWriteTree(cwd, ref) {
  return tryRun('git', ['-C', cwd, 'merge-tree', '--write-tree', ref, ref]) !== null;
}

// Whether `origin/<def>` still matches the branch it is a copy of.
//
// `origin/main` is not the remote. It is a ref this checkout last wrote during a
// fetch, and everything below compares against it as though it were current. A
// pull request merging between that fetch and this run is invisible here: the
// comparison correctly finds those commits absent from the snapshot it was
// given, the branches come back under Keep with a real-looking commit count, and
// nothing printed says the question was asked of old data.
//
// That is not hypothetical. A run at 19:15 compared against a 16:47 fetch and
// reported seven branches as holding work, all seven of which had squash merged
// in between. The same tool with `--repo`, which asks GitHub live, cleared all
// seven and named the pull request for each.
//
// Compared by commit rather than by tree, because the question is whether this
// copy is current, and two different commits sharing a tree still mean a fetch
// has been missed.
//
// Failure is silence, in every direction. No remote configured, no network, no
// `ls-remote` on the path, an unparseable line: the answer is false, no note is
// printed, and nothing else about the run changes.
function remoteMoved(cwd, def, cachedSha) {
  if (!cachedSha) return false;
  const out = tryRun('git', ['-C', cwd, 'ls-remote', '--heads', 'origin', def],
    { timeout: REMOTE_PROBE_TIMEOUT_MS });
  if (!out) return false;
  const sha = out.split('\n')[0].split('\t')[0];
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
  return sha !== cachedSha;
}

// opts.deadline is an epoch milliseconds value. A caller that has to finish
// inside a budget, the session-start hook being the one that matters, passes a
// deadline and gets `truncated: true` rather than a wrong answer late.
//
// Branches not reached keep `aheadBy: null`, which classify.js treats as
// unmerged. So a truncated run under-reports what is safe and never over-
// reports it.
//
// What costs time here is starting git, not running it. Every child process is
// about 9 ms of spawn on a warm machine, and the git work inside it is close to
// free: the whole branch listing, ahead counts included, measures at 10 ms for
// 61 branches. So the number of calls is the only thing worth optimising, and
// the deadline exists to bound the one call that cannot be batched away.
//
// Ancestry for every branch now comes back with the listing, in one call. What
// remains per-branch is the tree comparison below, asked only of branches that
// ancestry already called unmerged. The deadline is checked immediately before
// each of those, so the loop stays bounded and a run under pressure keeps
// rather than offers.
//
// opts.only restricts the work to a single named branch, for the re-check that
// runs immediately before a delete. Same facts, same rules, one branch: without
// it, deleting twenty branches rescans the whole repository twenty times.
function localBranches(cwd, opts) {
  const deadline = (opts && opts.deadline) || null;
  const only = (opts && opts.only) || null;
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

  // `unreadable` rather than an empty list, because a caller asking about one
  // branch cannot otherwise tell "looked, and it is gone" from "could not
  // look". Both mean do not delete; only one of them means the branch is gone,
  // and saying the wrong one invites someone to assume the work was already
  // tidied away.
  //
  // The ahead count rides along on this listing rather than costing a
  // `rev-list` per branch. `%(ahead-behind:)` arrived in git 2.41, and an older
  // git rejects the whole format with "unknown field name" rather than leaving
  // the field empty, so a null here is asked again without it and the loop pays
  // the per-branch cost as before. Probed by asking, the same way the
  // `merge-tree` support above is, because a version number read off `git
  // --version` is a different question from whether this git accepts the form.
  const FIELDS = '%(refname:short)%09%(committerdate:iso-strict)';
  let listed = tryRun('git', ['-C', cwd, 'for-each-ref', `--format=${FIELDS}%09%(ahead-behind:${def})`, 'refs/heads/']);
  const listedHasAhead = listed !== null;
  if (!listedHasAhead) {
    listed = tryRun('git', ['-C', cwd, 'for-each-ref', `--format=${FIELDS}`, 'refs/heads/']);
  }
  if (listed === null) return { defaultBranch: def, branches: [], unreadable: true };
  if (!listed) return { defaultBranch: def, branches: [] };

  // The default branch's own tree, read once. A branch whose merge into `def`
  // produces this exact tree adds nothing `def` does not already have. If this
  // cannot be read the comparison is simply not attempted, and every branch
  // falls back to ancestry alone.
  const defTree = tryRun('git', ['-C', cwd, 'rev-parse', `${def}^{tree}`]);

  // And the remote-tracking copy, when it exists and has moved on from the
  // local one. `def` above is a local branch name, stripped of its `origin/`
  // prefix, so the comparison would otherwise run against whatever this
  // checkout last pulled. Immediately after a pull request merges, the local
  // default branch is behind by exactly the merge you are asking about, and
  // that is precisely when someone runs this.
  //
  // Merged into either one is real evidence: both mean the work exists
  // somewhere that is not this branch. Skipped when the two agree, which is the
  // steady state, so it costs nothing in the common case.
  const remoteDef = `origin/${def}`;
  const remoteDefSha = tryRun('git', ['-C', cwd, 'rev-parse', remoteDef]);
  const remoteDefTree = tryRun('git', ['-C', cwd, 'rev-parse', `${remoteDef}^{tree}`]);
  const compareAgainst = [{ ref: def, tree: defTree, label: 'already in the default branch' }];
  if (remoteDefTree && remoteDefTree !== defTree) {
    compareAgainst.push({ ref: remoteDef, tree: remoteDefTree, label: `already in ${remoteDef}` });
  }

  const rows = listed.split('\n').filter(Boolean)
    .filter((line) => only === null || line.split('\t')[0] === only);

  // Asked once, not once per branch. When this git cannot answer, the loop
  // below does not pretend to have asked: `mergeCheckUnavailable` comes back
  // and the caller says so.
  //
  // Only asked when there is something to compare against. With no readable
  // default tree the comparison cannot run either way, and reporting that as a
  // git version problem would send someone to upgrade a git that is fine.
  const versionOk = defTree ? supportsWriteTree(cwd, def) : null;
  const canCompare = !!defTree && versionOk === true;

  // Asked for the listing and not for `only`, the re-check that runs immediately
  // before each delete. Two reasons, and either one is enough.
  //
  // A twenty branch cleanup calls this path twenty times, and a network round
  // trip per branch is the cost this function's `only` parameter exists to
  // avoid in the first place.
  //
  // More importantly it cannot change that path's answer safely or otherwise. A
  // stale copy of the remote makes branches look less merged than they are,
  // never more, so its only effect is keeping something that could have gone.
  // The re-check exists to catch the opposite: work appearing on a branch
  // already cleared. Staleness cannot cause that.
  //
  // A deadline means the caller is the session hook, which prints one line and
  // has a budget measured against it. Advisory prose it will not print is not
  // worth spending that budget on.
  const remoteStale = (only === null && deadline === null)
    ? remoteMoved(cwd, def, remoteDefSha)
    : false;

  const branches = rows.map((line) => {
    const [name, date, aheadBehind] = line.split('\t');
    let aheadBy = null;
    let merged = false;
    let mergedVia = null;
    if (name === def) {
      aheadBy = 0;
    } else {
      // The number of commits on `name` that are not reachable from `def`.
      // `%(ahead-behind:)` prints it as "<ahead> <behind>"; the fall back asks
      // `rev-list` the same question one branch at a time.
      if (listedHasAhead) {
        const n = (aheadBehind || '').split(' ')[0];
        if (/^\d+$/.test(n)) aheadBy = parseInt(n, 10);
      } else if (deadline !== null && Date.now() >= deadline) {
        // Out of time. Leave aheadBy null so this branch is kept, not offered.
        truncated = true;
      } else {
        const n = tryRun('git', ['-C', cwd, 'rev-list', '--count', `${def}..${name}`]);
        if (n !== null && /^\d+$/.test(n)) aheadBy = parseInt(n, 10);
      }

      // Ancestry says nothing about a squash merge, which rewrites the branch
      // into one new commit and leaves the originals unreachable. So ask the
      // question that survives it: does merging this branch into `def` change
      // `def` at all? An identical resulting tree means it does not.
      //
      // Only worth asking when ancestry already said "unmerged". A conflicting
      // merge exits non-zero, `tryRun` returns null, and the branch is kept.
      // Not knowing is never rounded up into permission to delete.
      if (aheadBy !== null && aheadBy > 0 && canCompare) {
        if (deadline !== null && Date.now() >= deadline) {
          // Out of time for the one call that is still per-branch. `merged`
          // stays false, so this branch is kept rather than offered, and the
          // run says it was cut short.
          truncated = true;
        } else {
          for (const target of compareAgainst) {
            if (!target.tree) continue;
            const t = tryRun('git', ['-C', cwd, 'merge-tree', '--write-tree', target.ref, name]);
            if (t !== null && t.split('\n')[0] === target.tree) {
              merged = true;
              mergedVia = target.label;
              break;
            }
          }
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

  // Specifically "this git is too old", not "the comparison did not run". The
  // note the caller prints tells someone to check their git version, and that
  // is only the right advice for one of those.
  return { defaultBranch: def, branches, truncated, remoteStale, mergeCheckUnavailable: versionOk === false };
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

function ghLines(args, opts) {
  return toLines(tryRun('gh', args, opts));
}

// The HTTP status, specifically, and not just success or failure.
//
// `gh api` exits non-zero on any 4xx, so `tryRun` collapses "this branch is
// gone" and "your token expired" into the same null. Those are different facts
// and only one of them is about the branch. execFileSync puts the response on
// the error when the child exits non-zero, so the status is readable there;
// `--include` is what puts the status line in it.
//
// Returns null when even that cannot be determined, which is its own answer:
// nothing was learned.
function ghStatus(args) {
  const withHeaders = args.concat(['--silent', '--include']);
  try {
    run('gh', withHeaders);
    return 200;
  } catch (e) {
    const text = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`;
    const m = text.match(/HTTP\/[\d.]+\s+(\d{3})/);
    return m ? parseInt(m[1], 10) : null;
  }
}

function remoteBranches(repo) {
  const meta = ghJSON(['api', `repos/${repo}`]);
  if (!meta || !meta.default_branch) return { defaultBranch: null, branches: [], error: `cannot read repos/${repo}` };
  const def = meta.default_branch;

  // Name and current tip together, because merge evidence has to be checkable
  // against the branch as it stands now. A merged pull request says something
  // about the commit it merged and nothing about anything pushed since.
  const nameLines = ghLines(['api', `repos/${repo}/branches?per_page=100`, '--paginate', '--jq', '.[] | "\\(.name)\\t\\(.commit.sha)"']);

  // A failed listing is not an empty listing. Returning [] here would report a
  // clean repository, which reads as good news and is unfalsifiable from the
  // output. Same principle as a null aheadBy in classify.js: not knowing is
  // never rounded down to nothing.
  if (nameLines === null) {
    return { defaultBranch: def, branches: [], error: `could not list branches for ${repo}` };
  }

  const names = [];
  const tipSha = new Map();
  for (const line of nameLines) {
    const [name, sha] = line.split('\t');
    if (!name) continue;
    names.push(name);
    if (sha) tipSha.set(name, sha);
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
  // Two filters, and neither is optional:
  //
  // `base=<def>` because `merged_at` only says the pull request merged, not
  // where it merged TO. Stacked work merging `feature-b` into `feature-a` sets
  // `merged_at` on a pull request that never put anything in the default
  // branch, and counting it would offer `feature-b` for deletion while its
  // commits exist nowhere else.
  //
  // Keyed on `head.sha` rather than `head.ref` because a branch name outlives
  // the commit that merged under it. Someone who reuses a branch after its
  // pull request merged has a ref whose name matches a merged pull request and
  // whose tip is new unmerged work. Matching the name alone would offer that
  // branch for deletion, and remote deletion has no second opinion the way the
  // local `-d` does. The evidence has to be about the commit the branch points
  // at now, which is what the local path gets for free by computing its
  // comparison live.
  //
  // Unreadable is not empty here either, but it fails the other way round from
  // the open-PR list above: with no merged list, no branch gains the second
  // signal and every one falls back to ancestry. That keeps too much rather
  // than deleting too much, which is the direction this plugin errs in
  // everywhere.
  const mergedLines = ghLines(['api',
    `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(def)}&per_page=100`, '--paginate',
    '--jq', '.[] | select(.merged_at != null) | "\\(.head.sha)\\t\\(.number)"'],
  { timeout: MERGED_PR_TIMEOUT_MS });

  // Lowest number wins where a commit merged more than once, which happens when
  // a pull request is reopened against the same head or the same commit is
  // taken by two pull requests. Any of them establishes the same fact; the
  // first is the one a reader can find.
  const mergedBySha = new Map();
  for (const line of mergedLines || []) {
    const [sha, num] = line.split('\t');
    if (!sha || !num) continue;
    const existing = mergedBySha.get(sha);
    if (existing === undefined || parseInt(num, 10) < parseInt(existing, 10)) mergedBySha.set(sha, num);
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

    // Only when the branch still points at the commit that merged. A branch
    // whose tip we could not read gains no evidence at all, same rule as
    // everywhere else here.
    const tip = tipSha.get(name);
    const mergedNum = tip === undefined ? undefined : mergedBySha.get(tip);

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

// One branch, for the re-check immediately before a delete.
//
// Not `remoteBranches` filtered afterwards. That version lists every branch,
// then walks every closed pull request against the default branch, and doing it
// once per branch being deleted turns a twenty-branch cleanup into twenty full
// scans and twenty paginations. The listing needs the whole picture; this does
// not.
//
// Four calls, fixed, whatever the size of the repository. The merge evidence
// comes from `commits/{sha}/pulls`, which asks the question directly: which
// pull requests have this exact commit as their head. That is the same pair of
// conditions the listing applies, merged and into the default branch, asked of
// one commit instead of filtered out of all of them.
function remoteBranch(repo, name) {
  const meta = ghJSON(['api', `repos/${repo}`]);
  if (!meta || !meta.default_branch) return { defaultBranch: null, branch: null, error: `cannot read repos/${repo}` };
  const def = meta.default_branch;

  // A 404 means gone since the listing. Expired auth, a rate limit, a network
  // failure or unparseable output all also come back as null from `ghJSON`, and
  // they are not the same thing. Both stop the delete; only one of them means
  // the branch is gone, and telling someone mid-cleanup that a branch has
  // vanished invites them to assume the work went with it.
  const head = ghJSON(['api', `repos/${repo}/branches/${encodeURIComponent(name)}`,
    '--jq', '{sha: .commit.sha, d: .commit.commit.committer.date}']);
  if (!head || !head.sha) {
    const gone = ghStatus(['api', `repos/${repo}/branches/${encodeURIComponent(name)}`]) === 404;
    return { defaultBranch: def, branch: null, missing: gone, unreadable: !gone };
  }

  let aheadBy = null;
  if (name === def) {
    aheadBy = 0;
  } else {
    const cmp = ghJSON(['api', `repos/${repo}/compare/${encodeURIComponent(def)}...${encodeURIComponent(name)}`, '--jq', '{a: .ahead_by}']);
    if (cmp && typeof cmp.a === 'number') aheadBy = cmp.a;
  }

  // Every pull request whose head is this exact commit. Unreadable stays
  // unreadable: no evidence either way, so hasOpenPR fails safe into true and
  // merged fails safe into false, the same directions the listing uses.
  //
  // GitHub documents this endpoint as returning "the merged pull request that
  // introduced the commit", and, "if the commit is not present in the default
  // branch, will only return open pull requests". A squash-merged branch tip is
  // exactly a commit not present in the default branch, so on that reading this
  // would find nothing and disagree with the listing.
  //
  // Checked against a real one rather than trusted either way. Branch
  // feat/consistency-lint in sarahcallmesmadds/plugins, squash merged as #56:
  // `git merge-base --is-ancestor <tip> origin/main` fails, confirming the tip
  // is genuinely unreachable from the default branch, and this endpoint still
  // returns #56 as merged into main with a matching head sha. The caveat
  // describes commits inside a pull request, not the head commit the pull
  // request was opened from, which is the only one asked about here.
  //
  // If that ever changes, the fallback is the same `pulls?state=closed&base=`
  // query the listing uses, at the pagination cost this function avoids.
  //
  // `commits/{sha}/pulls` returns pull requests that CONTAIN the commit, not
  // only those whose head it is, so `head.sha` is compared here explicitly. The
  // looser reading would be safe on its own (a commit contained in a pull
  // request merged into the default branch did reach the default branch) but it
  // would let this clear a branch the listing kept, and the two disagreeing is
  // the exact failure `--verify` exists to remove. Paginated for the same
  // reason: an unpaginated page cap would truncate evidence and produce a
  // different answer from the listing rather than the same one.
  const pulls = ghLines(['api', `repos/${repo}/commits/${head.sha}/pulls`, '--paginate',
    '--jq', '.[] | "\\(.number)\\t\\(.base.ref)\\t\\(.head.sha)\\t\\(.state)\\t\\(.merged_at != null)"']);

  let hasOpenPR = true;
  let mergedNum;
  if (pulls !== null) {
    const rows = pulls.map((l) => l.split('\t')).filter((r) => r.length === 5);
    hasOpenPR = rows.some((r) => r[3] === 'open' && r[2] === head.sha);
    const mergedIntoDefault = rows
      .filter((r) => r[4] === 'true' && r[1] === def && r[2] === head.sha)
      .map((r) => parseInt(r[0], 10))
      .filter((n) => !Number.isNaN(n));
    if (mergedIntoDefault.length) mergedNum = Math.min(...mergedIntoDefault);
  }

  return {
    defaultBranch: def,
    branch: {
      name,
      lastCommitDate: head.d || null,
      aheadBy,
      merged: mergedNum !== undefined,
      mergedVia: mergedNum === undefined ? null : `merged in #${mergedNum}`,
      isDefault: name === def,
      isCurrent: false,
      hasOpenPR,
      remote: true,
    },
  };
}

module.exports = { isGitRepo, localBranches, remoteBranches, remoteBranch, tryRun, ghJSON, ghLines, toLines };
