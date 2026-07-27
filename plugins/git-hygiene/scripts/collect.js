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

function remoteBranches(repo) {
  const meta = ghJSON(['api', `repos/${repo}`]);
  if (!meta || !meta.default_branch) return { defaultBranch: null, branches: [], error: `cannot read repos/${repo}` };
  const def = meta.default_branch;

  const names = ghJSON(['api', `repos/${repo}/branches`, '--paginate', '--jq', '[.[].name]']) || [];

  // One list call rather than one lookup per branch. A branch with an open PR
  // is kept whatever its merge state, and asking per branch would be dozens of
  // API calls for a fact one call already answers.
  const prs = ghJSON(['api', `repos/${repo}/pulls?state=open&per_page=100`, '--paginate', '--jq', '[.[].head.ref]']) || [];
  const openPR = new Set(prs);

  const branches = names.map((name) => {
    let aheadBy = null;
    let lastCommitDate = null;

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
      hasOpenPR: openPR.has(name),
      remote: true,
    };
  });

  return { defaultBranch: def, branches };
}

module.exports = { isGitRepo, localBranches, remoteBranches, tryRun, ghJSON };
