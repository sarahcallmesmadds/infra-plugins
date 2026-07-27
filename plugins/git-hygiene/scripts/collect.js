// Gathers branch facts, either from a local checkout or from GitHub.
//
// Both paths produce the same shape so `classify.js` never needs to know where
// the data came from. The important field is `aheadBy`, and every path that
// cannot determine it sets it to null rather than guessing a number.

'use strict';

const { execFileSync } = require('child_process');

function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }, opts || {})).trim();
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

function localBranches(cwd) {
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

  const branches = listed.split('\n').filter(Boolean).map((line) => {
    const [name, date] = line.split('\t');
    let aheadBy = null;
    if (name !== def) {
      // `rev-list --count def..name` is the number of commits on `name` that
      // are not reachable from `def`. That is exactly the question being asked.
      const n = tryRun('git', ['-C', cwd, 'rev-list', '--count', `${def}..${name}`]);
      if (n !== null && /^\d+$/.test(n)) aheadBy = parseInt(n, 10);
    } else {
      aheadBy = 0;
    }
    return {
      name,
      lastCommitDate: date,
      aheadBy,
      isDefault: name === def,
      isCurrent: name === current,
      hasOpenPR: false,
      remote: false,
    };
  });

  return { defaultBranch: def, branches };
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

    return {
      name,
      lastCommitDate,
      aheadBy,
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
