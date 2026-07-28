// What was being worked on recently, that no live process will tell you about.
//
// ---------------------------------------------------------------------------
// Why this exists alongside the live session check.
//
// `sessions.js` reads the process table, so it answers "is somebody editing
// this right now". That is the right question and it is not the only one. A
// window closed ten minutes ago leaves no process and leaves its uncommitted
// work sitting in the tree, and the next session will happily edit the same
// files with no idea anything is there.
//
// The original hook this ports from was written after exactly that: on
// 2026-04-25 one window was committing to a repository while another was
// editing files in it, discovered by accident mid-session.
//
// The two checks cover different failures and neither subsumes the other:
//
//   live process   somebody is in here now
//   git activity   somebody was in here, and left something behind
//
// ---------------------------------------------------------------------------
// The one thing the original got wrong, which is the whole reason to port it.
//
// It held a hardcoded list of six repository paths: ~/gtm, ~/revops-app,
// ~/Projects/hq and three more. Every one of them was a path on a machine that
// is not this machine. On any other machine the hook checked six directories
// that do not exist, found nothing, said nothing, and looked exactly like a
// hook reporting all clear.
//
// A list of paths written by hand is a list that goes stale, and the failure is
// silent in the reassuring direction. So this discovers instead, and reports
// what it looked at, so "nothing found" can be told apart from "nowhere looked".

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Per git call. `git status --porcelain` on an ordinary repository is a few
// milliseconds, so this is not a budget, it is a bound on something having gone
// wrong: a network filesystem, an index lock, a repository mid-gc. Anything
// that takes longer than this is not going to be worth waiting for at session
// start.
const GIT_TIMEOUT_MS = 400;

const DEFAULTS = {
  // How far back counts as recent. Long enough to span a morning and an
  // afternoon at the same desk.
  recentHours: 6,

  // Directories to look inside for repositories. `~` is expanded.
  roots: ['~/Projects'],

  // How deep below each root to look. Two covers ~/Projects/<repo> and
  // ~/Projects/<group>/<repo>, which is how both machines here are laid out.
  depth: 2,

  // Never scan more than this many repositories, whatever discovery finds.
  //
  // Each one costs up to three git calls, and this runs in front of the first
  // prompt of every session. Twelve is enough to cover the repositories anybody
  // is realistically moving between in a day, and small enough that the worst
  // case is still bounded by the deadline rather than by this number.
  maxRepos: 12,

  // Uncommitted files before it is worth mentioning. One stray file is noise;
  // several mean somebody was in the middle of something.
  minChanges: 1,
};

function expand(p, home = os.homedir()) {
  return String(p).replace(/^~(?=$|\/)/, home);
}

function git(repo, args, exec = execFileSync) {
  try {
    return exec('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (_) {
    return null;
  }
}

function isRepo(dir) {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory()
      || fs.statSync(path.join(dir, '.git')).isFile();
  } catch (_) {
    return false;
  }
}

// Find repositories under the configured roots.
//
// Returns `{ repos, complete }`. `complete` is false when the cap or the
// deadline cut the walk short, and a caller must not present a quiet result
// from an incomplete walk as an all-clear. Same contract as the session scan,
// for the same reason, and it has been got wrong there twice.
function discover(opts = {}) {
  const { home = os.homedir(), deadline, extra = [] } = opts;

  // Written out rather than spread, and that is the point.
  //
  // `{ ...DEFAULTS, roots, depth, maxRepos }` looks like it falls back to the
  // defaults and does the opposite: shorthand always sets the key, so an
  // omitted argument arrives as `undefined` and overwrites the default with it.
  // `discover({ roots })` therefore ran with `depth: undefined`, and since
  // `undefined < 0` and `undefined === 0` are both false while `undefined - 1`
  // is NaN, the walk had no depth limit at all. `maxRepos: undefined` removed
  // the cap in the same breath, and `slice(0, undefined)` returned everything.
  //
  // So a function advertising a bounded walk performed an unbounded one, on
  // exactly the call shape its own tests used. The production path passed
  // concrete values and was never affected, which is why nothing showed it.
  const cfg = {
    roots: opts.roots === undefined ? DEFAULTS.roots : opts.roots,
    depth: opts.depth === undefined ? DEFAULTS.depth : opts.depth,
    maxRepos: opts.maxRepos === undefined ? DEFAULTS.maxRepos : opts.maxRepos,
  };
  const found = [];
  const seen = new Set();
  let complete = true;

  const add = (dir) => {
    const real = path.resolve(dir);
    if (seen.has(real)) return;
    seen.add(real);
    if (isRepo(real)) found.push(real);
  };

  // Whatever the caller already knows about goes in first, so the current
  // repository is never missed because it happens to live outside every root.
  for (const dir of extra) if (dir) add(dir);

  const walk = (dir, left) => {
    if (left < 0) return;
    if (found.length >= cfg.maxRepos) { complete = false; return; }
    if (deadline != null && Date.now() >= deadline) { complete = false; return; }

    add(dir);
    if (left === 0) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), left - 1);
    }
  };

  for (const root of (cfg.roots || [])) walk(expand(root, home), cfg.depth);

  return { repos: found.slice(0, cfg.maxRepos), complete };
}

// Uncommitted files and recent commits in one repository.
// The deadline is checked between the git calls, not only between repositories.
//
// Checking only between repositories bounds the loop and not the work: three
// calls each capped at their own timeout can start just under the deadline and
// run well past it together. Every call here is preceded by a check, so the
// overrun is one call rather than all of them.
function inspect(repo, { recentHours = DEFAULTS.recentHours, exec = execFileSync, deadline } = {}) {
  const expired = () => deadline != null && Date.now() >= deadline;

  const branch = expired() ? null : (git(repo, ['branch', '--show-current'], exec) || '').trim() || null;

  const status = expired() ? null : git(repo, ['status', '--porcelain'], exec);
  // null means the command failed, which is not the same as a clean tree. Left
  // as null so the caller can tell them apart rather than reporting a repo we
  // could not read as tidy.
  const changed = status == null
    ? null
    : status.split('\n').filter((l) => l.trim()).length;

  const log = expired() ? null : git(repo, [
    'log', `--since=${recentHours}.hours.ago`, '--pretty=format:%h|%ar|%s', '-10',
  ], exec);
  const commits = log == null ? null : log.split('\n').filter(Boolean).map((line) => {
    const [hash, when, ...rest] = line.split('|');
    return { hash, when, subject: rest.join('|') };
  });

  return {
    repo,
    name: path.basename(repo),
    branch,
    changed,
    commits,
    readable: status != null || log != null,
  };
}

// Repositories worth mentioning, newest activity first.
function scan({
  cwd, config = {}, home = os.homedir(), deadline, exec = execFileSync,
} = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { repos, complete } = discover({
    roots: cfg.roots,
    depth: cfg.depth,
    maxRepos: cfg.maxRepos,
    home,
    deadline,
    extra: cwd ? [findRepoRoot(cwd)] : [],
  });

  const rows = [];
  let scanned = true;
  for (const repo of repos) {
    if (deadline != null && Date.now() >= deadline) { scanned = false; break; }
    rows.push(inspect(repo, { recentHours: cfg.recentHours, exec, deadline }));
  }

  const notable = rows.filter((r) => (r.changed != null && r.changed >= cfg.minChanges)
    || (r.commits != null && r.commits.length > 0));

  return { repos: rows, notable, complete: complete && scanned };
}

// The repository containing `dir`, or null.
function findRepoRoot(dir) {
  let current = path.resolve(dir);
  const root = path.parse(current).root;
  for (let i = 0; i < 20; i += 1) {
    if (isRepo(current)) return current;
    const parent = path.dirname(current);
    if (parent === current || current === root) break;
    current = parent;
  }
  return null;
}

module.exports = { DEFAULTS, expand, isRepo, discover, inspect, scan, findRepoRoot };
