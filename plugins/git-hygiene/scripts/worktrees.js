#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const collect = require('./collect');
const { loadConfig, contains, expandHome } = require('./worktree-config');

const STATES = Object.freeze({
  PRIMARY: 'primary',
  MISSING: 'missing',
  LOCKED: 'locked',
  DIRTY: 'dirty',
  DETACHED_REVIEW: 'detached-review',
  OPEN: 'open',
  MERGED: 'merged',
  UNIQUE: 'unique',
  UNKNOWN: 'unknown',
});

const REVIEW_LOCATION = /(?:^|\/)(?:\.cache\/devin|\.planning|\.review|\.codex\/\.tmp|Library\/Application Support\/Claude\/local-agent-mode-sessions)(?:\/|$)/;
const MUTATION_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 5000;

function remaining(deadline, fallback = READ_TIMEOUT_MS) {
  if (!deadline) return fallback;
  return Math.max(1, Math.min(fallback, deadline - Date.now()));
}

const ACTIVE_LOCK_REASON = 'git-hygiene: active agent work';

// What a failed command reports: the step, where, and how it ended. Never Git's
// own stderr or the full argument list. Git echoes remote URLs, and a URL can
// carry a token; recognising every credential inside arbitrary text took four
// review rounds and still missed forms, so that text is not printed at all.
// The hint never says to rerun the step: for remove, move or prune that would
// change the repository by hand, past every check this script makes. It
// points at read-only commands instead, or at a caller's own safe command.
function describeFailure(file, args, result, hint) {
  let where = null;
  let rest = args;
  if (file === 'git' && args[0] === '-C') { where = args[1]; rest = args.slice(2); }
  const words = rest.filter((arg) => !arg.startsWith('-'));
  // Only fixed verbs, never an argument that could be user text.
  const step = [file, ...words.slice(0, file === 'gh' || words[0] === 'worktree' ? 2 : 1)].join(' ');
  let how;
  if (result.error && result.error.code === 'ETIMEDOUT') how = 'timed out';
  else if (result.signal) how = `was stopped by ${result.signal}`;
  else if (result.status === null) how = 'did not run';
  else how = `exited ${result.status}`;
  const look = hint || 'git status and git worktree list show the current state';
  return `${step} ${how}${where ? ` in ${where}` : ''}; ${look}`;
}

// The message to show for any caught error. A Node system error (from mkdir,
// rename, stat) carries its own message text, which is not ours to print; it
// is reduced to the call, the code and the path. Errors this file threw are
// already in its own words.
function errorText(error) {
  if (error && error.code && error.syscall) {
    return `${error.syscall} failed with ${error.code}${error.path ? ` at ${error.path}` : ''}`;
  }
  return error && error.message ? error.message : String(error);
}

// Masks URL user-info (https://user:token@host -> https://***@host). Git text
// carries remote URLs in errors, lock reasons and prune output, and all of it
// can reach the conversation, so this runs where text leaves the process (the
// output function and both stderr writes), not at any one source; a source-side
// mask missed lock reasons and prune errors. Greedy up to the last `@` before
// whitespace or `/ ? #`. It errs toward masking: user-info may hold an `@` (an
// email username) or a quote (pa'ss), and every narrower boundary tried left a
// password visible. The cost is that `https://host,bob@x` with no space hides a
// little extra text, never that a credential shows. JSON output is masked value
// by value before serialization, so an escape such as `\n` is never read as
// part of an address.
function redactCredentials(text) {
  // ASCII whitespace only: `\s` also matches a non-breaking space, which is
  // valid inside user-info and stopped the mask short of the `@`.
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^ \t\r\n/?#]*@/gi, '$1***@');
}

function redactValue(value) {
  if (typeof value === 'string') return redactCredentials(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactValue(inner)]));
  }
  return value;
}

function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || READ_TIMEOUT_MS,
    env: options.env || process.env,
  });
  if (result.status !== 0 || result.error) {
    if (options.allowFailure) return null;
    throw new Error(redactCredentials(describeFailure(file, args, result)));
  }
  return (result.stdout || '').trim();
}

function git(repo, args, options = {}) {
  return run('git', ['-C', repo, ...args], options);
}

function canonical(candidate) {
  const resolved = path.resolve(candidate);
  try { return fs.realpathSync.native(resolved); }
  catch (_) { return resolved; }
}

function pathPresence(candidate) {
  try {
    fs.statSync(candidate);
    return { present: true, absenceConfirmed: false, error: null };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { present: false, absenceConfirmed: true, error: null };
    }
    return {
      present: false,
      absenceConfirmed: false,
      error: error && error.code ? error.code : 'unreadable',
    };
  }
}

// Resolve symlinks in the nearest existing ancestor even when the final path
// does not exist yet. Plain realpath cannot protect a prospective destination:
// `Worktrees/<repo> -> /somewhere/else` makes the leaf absent while still
// redirecting every later mkdir and Git write outside the configured root.
function canonicalProspective(candidate) {
  const resolved = path.resolve(candidate);
  const missing = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync.native(existing), ...missing); }
  catch (_) { return resolved; }
}

function commonDir(repo, deadline) {
  const found = git(repo, ['rev-parse', '--git-common-dir'], { timeout: remaining(deadline) });
  return canonical(path.isAbsolute(found) ? found : path.resolve(repo, found));
}

function topLevel(repo, deadline) {
  return canonical(git(repo, ['rev-parse', '--show-toplevel'], { timeout: remaining(deadline) }));
}

function parsePorcelain(output) {
  const records = [];
  let current = null;
  const tokens = output.includes('\0') ? output.split('\0') : output.split('\n');
  for (const raw of tokens) {
    const line = raw.replace(/\n$/, '');
    if (!line) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? true : line.slice(space + 1);
    if (key === 'worktree') {
      if (current) records.push(current);
      current = { path: value };
      continue;
    }
    if (!current) continue;
    if (key === 'branch') current.branch = String(value).replace(/^refs\/heads\//, '');
    else if (key === 'HEAD') current.head = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = value === true ? 'locked' : value;
    else if (key === 'prunable') current.prunable = value === true ? 'prunable' : value;
  }
  if (current) records.push(current);
  return records;
}

function registeredWorktrees(repo, deadline) {
  let out = git(repo, ['worktree', 'list', '--porcelain', '-z'], {
    timeout: remaining(deadline),
    allowFailure: true,
  });
  if (out === null) out = git(repo, ['worktree', 'list', '--porcelain'], { timeout: remaining(deadline) });
  return parsePorcelain(out).map((entry) => ({ ...entry, path: canonical(entry.path) }));
}

// Printed in place of an identity that cannot be shown; carries nothing from the URL.
const UNREADABLE_REMOTE = Object.freeze({ unreadable: true, github: false });

function remoteIdentity(repo, deadline) {
  const url = git(repo, ['remote', 'get-url', 'origin'], {
    timeout: remaining(deadline),
    allowFailure: true,
  });
  if (!url) return null;

  // Local or network is settled first, by Git's own rule: an address with no
  // scheme is a local path unless a colon comes before any slash (on Windows a
  // drive letter is still local). A local remote has no pull requests. A
  // network remote either resolves to a plain host, owner and repository, or
  // is unreadable: never "no pull requests", or cleanup would remove its
  // worktrees without asking GitHub. Every part must be a plain name because
  // the identity is printed; a malformed remote otherwise splits a token into
  // a "host" or "owner" no URL mask recognises.
  let host = null;
  let pathname = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return UNREADABLE_REMOTE; }
    if (parsed.protocol === 'file:') return null;
    host = parsed.hostname;
    pathname = parsed.pathname.replace(/^\//, '');
  } else {
    const colon = url.indexOf(':');
    const slash = url.indexOf('/');
    // Git's has_dos_drive_prefix applies on Windows only (C:repo is local
    // there); on macOS and Linux x:/repo is an ssh host, as Git reads it.
    const drive = process.platform === 'win32' && /^[A-Za-z]:/.test(url);
    if (colon === -1 || (slash !== -1 && slash < colon) || drive) return null;
    const scp = /^(?:[^@]+@)?([^:]+):(.*)$/.exec(url);
    if (!scp) return UNREADABLE_REMOTE;
    host = scp[1];
    pathname = scp[2];
  }
  const plainName = /^[A-Za-z0-9._-]+$/;
  // A trailing DNS dot (github.com.) reaches the same host; without trimming
  // it the GitHub check fails and pull requests are never asked about.
  host = String(host || '').replace(/\.$/, '');
  if (!plainName.test(host)) return UNREADABLE_REMOTE;
  const parts = String(pathname || '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2 || !parts.every((part) => plainName.test(part))) return UNREADABLE_REMOTE;
  return {
    host: String(host).toLowerCase(),
    namespace: parts.slice(0, -1),
    owner: parts[parts.length - 2],
    repository: parts[parts.length - 1],
    github: /(^|\.)github\.com$/i.test(host || ''),
  };
}

// Text a user typed is repeated back only when it looks like a plain name.
// Anything else (spaces, colons, `@`) may be pasted text holding a token, and
// the URL mask only recognises tokens inside URLs, so it is not shown at all.
function shown(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '(empty)';
  return /^[A-Za-z0-9._\/+-]{1,200}$/.test(text) ? text : '(not shown: it is not a plain name)';
}

function safeSegment(value) {
  const source = String(value || '');
  if (!source) throw new Error(`cannot turn ${shown(value)} into a safe path segment`);
  // Percent-encode every byte outside the deliberately small readable set.
  // Lossy replacement makes distinct valid refs such as a+b and a-b collide.
  try {
    const encoded = encodeURIComponent(source)
      .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    if (encoded === '.') return '%2E';
    if (encoded === '..') return '%2E%2E';
    return encoded;
  } catch (_) {
    throw new Error(`cannot turn ${shown(value)} into a safe path segment`);
  }
}

function validateBranch(repo, branch) {
  if (!branch || branch.startsWith('-') || branch.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`refusing unsafe branch name: ${shown(branch)}`);
  }
  const valid = git(repo, ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (valid === null) throw new Error(`refusing invalid branch name: ${shown(branch)}`);
  return branch;
}

function validateBase(repo, base) {
  if (!base || typeof base !== 'string' || base.startsWith('-')) {
    throw new Error(`refusing unsafe base revision: ${shown(base)}`);
  }
  const resolved = git(repo, ['rev-parse', '--verify', `${base}^{commit}`], { allowFailure: true });
  if (resolved === null) throw new Error(`refusing unknown base revision: ${shown(base)}`);
  return base;
}

// The task folder name. Branch slashes become dashes so the destination is
// always exactly <worktreeRoot>/<repo>/<task>, the only depth the
// worktree-location guard accepts. Two branches that flatten to one name (a/b
// and a-b) collide on purpose: creation refuses an existing destination rather
// than inventing a second naming scheme.
function taskName(branch, task) {
  const name = task === undefined ? branch.split('/').join('-') : task;
  // A leading dot is refused too: `.review` or `.cache` would match the
  // review-tool folder pattern, and the finished worktree could never be removed.
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes(path.sep) || name.startsWith('.')) {
    throw new Error(`refusing unsafe task folder name: ${shown(name)}`);
  }
  return safeSegment(name);
}

function destinationFor(repo, branch, config = loadConfig(), task) {
  if (!config.exists || !config.valid) throw new Error('run /git-hygiene:setup before creating or moving worktrees');
  const registered = registeredWorktrees(repo);
  const primary = registered.length ? registered[0].path : topLevel(repo);
  validateBranch(primary, branch);
  const target = path.join(config.worktreeRoot, safeSegment(path.basename(primary)), taskName(branch, task));
  const root = canonicalProspective(config.worktreeRoot);
  const resolvedTarget = canonicalProspective(target);
  if (!contains(root, resolvedTarget) || resolvedTarget === root) {
    throw new Error('the computed worktree path escaped the configured root');
  }
  // Containment alone is not enough: a symlink such as Worktrees/<repo> ->
  // Worktrees makes the physical path one level deep, which the location guard
  // rejects, so the engine would create a worktree the guard calls misplaced.
  if (path.relative(root, resolvedTarget).split(path.sep).length !== 2) {
    throw new Error('the computed worktree path is not exactly <worktreeRoot>/<repo>/<task> once symlinks are resolved');
  }
  // The audit classifies the whole path, so check the whole path here too. A
  // repository folder named `.cache` with task `devin`, or `.review` with any
  // task, passes the task-name check yet lands on the review-tool pattern, and
  // that worktree would be held forever instead of offered for cleanup.
  if (REVIEW_LOCATION.test(resolvedTarget.replace(/\\/g, '/'))) {
    throw new Error(`refusing a destination the audit would treat as a review tool's folder: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function classifyLocation(candidate, config) {
  const here = canonical(candidate);
  // Unconfigured, there is no managed folder. The current-repository audit
  // still has to run then, so a missing root must not reach path functions.
  // Review-tool folders first: a review tool's checkout that happens to sit in
  // the worktree folder must still be held, never offered as ordinary cleanup.
  if (REVIEW_LOCATION.test(here.replace(/\\/g, '/'))) return 'review-tool';
  if (config.worktreeRoot && contains(canonicalProspective(config.worktreeRoot), here)) return 'managed-root';
  if (config.projectRoots.some((root) => contains(root, here))) return 'project-root';
  return 'other';
}

function status(candidate, deadline) {
  const out = git(candidate, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], {
    timeout: remaining(deadline),
    allowFailure: true,
  });
  if (out === null) return { readable: false, dirty: false, entries: [] };
  const entries = out.split('\n').filter(Boolean);
  return { readable: true, dirty: entries.length > 0, entries };
}

function submoduleState(candidate, deadline) {
  const out = git(candidate, ['submodule', 'status', '--recursive'], {
    timeout: remaining(deadline),
    allowFailure: true,
  });
  if (out === null) return { readable: false, initialized: false };
  const initialized = out.split('\n').filter(Boolean).some((line) => !line.startsWith('-'));
  return { readable: true, initialized };
}

const PR_LIST_LIMIT = 100;

function pullRequestEvidence(repo, identity, branch, head, defaultBranch, deadline) {
  if (identity && identity.unreadable) return { available: false, open: false, merged: false, mergedVia: null };
  if (!identity || !identity.github) return { available: true, open: false, merged: false, mergedVia: null };
  const out = run('gh', [
    'pr', 'list', '--repo', `${identity.owner}/${identity.repository}`,
    '--head', branch, '--state', 'all', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,state,mergedAt,headRefOid,baseRefName',
  ], { timeout: remaining(deadline), allowFailure: true });
  if (out === null) return { available: false, open: false, merged: false, mergedVia: null };
  try {
    const rows = JSON.parse(out || '[]');
    // A full page proves nothing about the pull requests past it: an older open
    // one on a reused branch name would be missed and its checkout removed. The
    // newest page still counts if it shows one open; otherwise fail closed.
    if (rows.length >= PR_LIST_LIMIT && !rows.some((row) => String(row.state).toUpperCase() === 'OPEN')) {
      return { available: false, open: false, merged: false, mergedVia: null };
    }
    const open = rows.some((row) => String(row.state).toUpperCase() === 'OPEN');
    const merged = rows.find((row) => row.mergedAt && row.headRefOid === head && row.baseRefName === defaultBranch);
    return {
      available: true,
      open,
      merged: !!merged,
      mergedVia: merged ? `merged in #${merged.number}` : null,
    };
  } catch (_) {
    return { available: false, open: false, merged: false, mergedVia: null };
  }
}

function branchEvidence(primary, entry, options = {}) {
  const local = collect.localBranches(primary, {
    only: entry.branch,
    deadline: options.deadline || null,
  });
  const branch = local.branches && local.branches[0];
  if (!local.defaultBranch || local.unreadable || local.truncated || !branch) {
    return { state: STATES.UNKNOWN, reason: 'branch or default-branch evidence could not be read' };
  }

  let prs = { available: true, open: false, merged: false, mergedVia: null };
  if (!options.skipRemote) {
    prs = pullRequestEvidence(
      primary,
      options.identity,
      entry.branch,
      entry.head,
      local.defaultBranch,
      options.deadline
    );
  }

  if (prs.open) return { state: STATES.OPEN, reason: 'the branch has an open pull request' };
  // An unreadable pull-request list must not read as an empty one. Removal
  // promises the branch has no open pull request, and that was not checked.
  if (!prs.available) {
    return {
      state: STATES.UNKNOWN,
      reason: options.identity && options.identity.unreadable
        ? "the remote's address could not be read, so open pull requests were not checked"
        : 'open pull requests could not be read from GitHub',
    };
  }
  if (branch.aheadBy === 0 || branch.merged || prs.merged) {
    return {
      state: STATES.MERGED,
      reason: prs.mergedVia || branch.mergedVia || 'the default branch already contains this work',
    };
  }
  if (branch.aheadBy === null || branch.aheadBy === undefined || (branch.aheadBy > 0 && local.mergeCheckUnavailable)) {
    return { state: STATES.UNKNOWN, reason: 'the branch comparison was incomplete' };
  }
  return {
    state: STATES.UNIQUE,
    reason: `${branch.aheadBy} commit${branch.aheadBy === 1 ? '' : 's'} are not proved present in the default branch`,
  };
}

function classifyEntry(primary, entry, index, config, options = {}) {
  const presence = pathPresence(entry.path);
  const result = {
    path: entry.path,
    branch: entry.branch || null,
    head: entry.head || null,
    primary: index === 0,
    present: presence.present,
    absenceConfirmed: presence.absenceConfirmed,
    // A lock reason is free text anyone can write, so only this tool's own
    // reason is reported; any other shows as plain `locked`.
    locked: entry.locked ? (entry.locked === ACTIVE_LOCK_REASON ? ACTIVE_LOCK_REASON : 'locked') : null,
    prunable: entry.prunable || null,
    location: classifyLocation(entry.path, config),
    state: STATES.UNKNOWN,
    reason: 'required evidence was unavailable',
    dirty: false,
    status: [],
    removable: false,
    relocatable: false,
  };

  if (result.primary) {
    result.state = STATES.PRIMARY;
    result.reason = 'the primary checkout is never moved or removed';
    return result;
  }
  if (entry.locked) {
    result.state = STATES.LOCKED;
    const absent = !result.present;
    result.reason = `the worktree is locked${entry.locked === ACTIVE_LOCK_REASON ? ' as active agent work' : ''}`
      + (absent ? ', and its path is absent' : '');
    return result;
  }
  if (!presence.present && !presence.absenceConfirmed) {
    result.state = STATES.UNKNOWN;
    result.reason = `the worktree path could not be checked${presence.error ? `: ${presence.error}` : ''}`;
    return result;
  }
  if (presence.absenceConfirmed) {
    result.state = STATES.MISSING;
    result.reason = 'Git records this worktree but its path is absent';
    return result;
  }
  if (entry.prunable) {
    result.state = STATES.UNKNOWN;
    result.reason = 'Git marks this registration prunable, but its path still exists and requires repair';
    return result;
  }

  const working = status(entry.path, options.deadline);
  if (!working.readable) {
    result.state = STATES.UNKNOWN;
    result.reason = 'the worktree status could not be read';
    return result;
  }
  result.dirty = working.dirty;
  result.status = working.entries;
  if (working.dirty) {
    result.state = STATES.DIRTY;
    result.reason = 'tracked, staged, untracked, or ignored files are present';
    return result;
  }
  if (entry.detached || result.location === 'review-tool') {
    result.state = STATES.DETACHED_REVIEW;
    result.reason = entry.detached ? 'the worktree has a detached HEAD' : 'the path belongs to a recognized review-tool location';
    return result;
  }
  if (!entry.branch) {
    result.state = STATES.UNKNOWN;
    result.reason = 'the checked-out branch could not be identified';
    return result;
  }

  const submodules = submoduleState(entry.path, options.deadline);
  if (!submodules.readable) {
    result.state = STATES.UNKNOWN;
    result.reason = 'submodule state could not be read';
    return result;
  }
  if (submodules.initialized) {
    result.state = STATES.UNKNOWN;
    result.reason = 'Git cannot move or remove a worktree with initialized submodules';
    return result;
  }

  const evidence = branchEvidence(primary, entry, options);
  result.state = evidence.state;
  result.reason = evidence.reason;
  result.removable = evidence.state === STATES.MERGED;
  result.relocatable = !!(config.exists && config.valid && result.location !== 'managed-root');
  return result;
}

function auditRepository(repo, options = {}) {
  if (options.deadline && Date.now() >= options.deadline) return { truncated: true, repository: canonical(repo), worktrees: [] };
  const entries = registeredWorktrees(repo, options.deadline);
  if (!entries.length) throw new Error(`no registered worktrees found for ${repo}`);
  const primary = entries[0].path;
  const repositoryCommonDir = commonDir(primary, options.deadline);
  const config = options.config || loadConfig();
  const identity = remoteIdentity(primary, options.deadline);
  const worktrees = [];
  let truncated = false;
  for (let i = 0; i < entries.length; i += 1) {
    if (options.deadline && Date.now() >= options.deadline) { truncated = true; break; }
    worktrees.push(classifyEntry(primary, entries[i], i, config, { ...options, identity }));
  }
  if (options.deadline && Date.now() >= options.deadline) truncated = true;
  let defaultBranch = null;
  if (!truncated) {
    const defaultEvidence = collect.localBranches(primary, { deadline: options.deadline || null });
    defaultBranch = defaultEvidence.defaultBranch || null;
    if (defaultEvidence.truncated) truncated = true;
  }
  return {
    repository: primary,
    commonDir: repositoryCommonDir,
    defaultBranch,
    identity,
    truncated,
    worktrees,
  };
}

// Whether a folder is a repository of its own, and whether Git could read it.
// A Git failure alone does not mean "not a repository": a repository Git
// refuses (unsafe ownership, damaged metadata) fails the same probe, and
// treating it as a plain folder drops its worktrees from every total. The
// folder's own `.git` entry is what tells the two apart.
function probeRepository(candidate, deadline) {
  // Only a confirmed absence means no .git entry. A folder that cannot be
  // searched (EACCES) may hide a repository, so it counts as unreadable.
  let hasGitEntry = true;
  try { fs.lstatSync(path.join(candidate, '.git')); }
  catch (error) { if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) hasGitEntry = false; }
  const failed = hasGitEntry ? { kind: 'unreadable' } : { kind: 'none' };
  let top;
  try { top = topLevel(candidate, deadline); }
  catch (_) { return failed; }
  if (top !== canonical(candidate)) return failed;
  try { return { kind: 'repository', identity: commonDir(candidate, deadline) }; }
  catch (_) { return { kind: 'unreadable' }; }
}

function discoverRepositories(projectRoots, deadline) {
  const repositories = [];
  // A repository that could not be read is returned here, not dropped, so a
  // total never reads as complete without it.
  const unreadable = [];
  const seen = new Set();
  const expired = () => !!(deadline && Date.now() >= deadline);
  // Its identity could not be read, so an unreadable repository is matched by
  // path instead; overlapping roots would otherwise count it twice.
  const unreadableSeen = new Set();
  const add = (candidate, probe) => {
    if (probe.kind === 'unreadable') {
      const key = canonical(candidate);
      if (!unreadableSeen.has(key)) { unreadableSeen.add(key); unreadable.push(candidate); }
    }
    else if (probe.kind === 'repository' && !seen.has(probe.identity)) {
      seen.add(probe.identity);
      repositories.push(candidate);
    }
  };
  for (const root of projectRoots) {
    if (expired()) return { repositories, unreadable, truncated: true };
    // Same rule as for children below, for a review tool's repository named
    // directly as a root.
    if (REVIEW_LOCATION.test(canonical(root).replace(/\\/g, '/'))) continue;
    const rootProbe = probeRepository(root, deadline);
    // A probe cut short by the deadline is a truncated scan, not a bad repository.
    if (expired()) return { repositories, unreadable, truncated: true };
    if (rootProbe.kind !== 'none') {
      // A configured repository is itself the unit of discovery. Do not
      // descend into its working tree and mistake nested repositories for
      // sibling projects.
      add(root, rootProbe);
      continue;
    }
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (_) { add(root, { kind: 'unreadable' }); continue; }
    for (const entry of entries) {
      if (expired()) return { repositories, unreadable, truncated: true };
      // Dot-named folders are probed too: a project at Projects/.website is a
      // real repository, and skipping it by name hides all its worktrees.
      // Folders that are not repositories fail the probe below.
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      // A review tool's own repository (Projects/.review) is not a project:
      // auditing it would count the tool's internal registrations as missing.
      if (REVIEW_LOCATION.test(canonical(candidate).replace(/\\/g, '/'))) continue;
      const probe = probeRepository(candidate, deadline);
      if (expired()) return { repositories, unreadable, truncated: true };
      add(candidate, probe);
    }
  }
  return { repositories, unreadable, truncated: false };
}

function summarize(repositories) {
  const worktrees = repositories.flatMap((repo) => repo.worktrees || []);
  return {
    repositories: repositories.length,
    worktrees: worktrees.length,
    visible: worktrees.filter((entry) => (
      !entry.primary && entry.present && entry.location === 'project-root'
    )).length,
    removable: worktrees.filter((entry) => entry.removable).length,
    relocatable: worktrees.filter((entry) => entry.relocatable).length,
    missing: worktrees.filter((entry) => entry.absenceConfirmed).length,
    held: worktrees.filter((entry) => !entry.primary && !entry.removable && !entry.absenceConfirmed).length,
    unreadable: 0,
  };
}

// The session notice's scan. It counts only what needs no per-worktree Git
// work: where each registered worktree sits and whether its path exists. The
// full audit runs `git status` and branch evidence for every worktree, which on
// 27 repositories and 89 worktrees took about 28 seconds, so inside a 1.5
// second budget it always ran out and the notice never spoke. The counts match
// summarize(): visible is a present, non-primary worktree in the project folder
// but outside the worktree folder; missing is a registration whose path is
// confirmed absent.
function placementCounts(options = {}) {
  const config = options.config || loadConfig();
  const roots = config.exists && config.valid ? config.projectRoots : [];
  const discovered = discoverRepositories(roots, options.deadline);
  // A repository that could not be read leaves the counts incomplete, so the
  // notice stays silent, as it does when it runs out of time.
  if (discovered.truncated || discovered.unreadable.length) return { truncated: true, visible: 0, missing: 0 };
  let visible = 0;
  let missing = 0;
  for (const repo of discovered.repositories) {
    if (options.deadline && Date.now() >= options.deadline) return { truncated: true, visible: 0, missing: 0 };
    let entries;
    try { entries = registeredWorktrees(repo, options.deadline); }
    catch (_) { return { truncated: true, visible: 0, missing: 0 }; }
    entries.forEach((entry, index) => {
      if (index === 0) return;
      const presence = pathPresence(entry.path);
      if (presence.absenceConfirmed) missing += 1;
      else if (presence.present && classifyLocation(entry.path, config) === 'project-root') visible += 1;
    });
  }
  if (options.deadline && Date.now() >= options.deadline) return { truncated: true, visible: 0, missing: 0 };
  return { truncated: false, visible, missing };
}

function auditConfigured(options = {}) {
  const config = options.config || loadConfig();
  const roots = config.exists && config.valid ? config.projectRoots : [];
  const discovered = discoverRepositories(roots, options.deadline);
  const repositories = [];
  let truncated = discovered.truncated;
  const errors = discovered.unreadable.map((repo) => ({ repository: repo, error: 'the repository could not be read' }));
  for (const repo of discovered.repositories) {
    if (options.deadline && Date.now() >= options.deadline) { truncated = true; break; }
    // One repository Git cannot read must not discard the others. It is
    // reported with no worktrees, so nothing from it is offered for cleanup.
    let audited;
    try { audited = auditRepository(repo, { ...options, config }); }
    catch (error) {
      errors.push({ repository: repo, error: errorText(error) });
      continue;
    }
    repositories.push(audited);
    if (audited.truncated) { truncated = true; break; }
  }
  // Counts cover the repositories that were read. Say how many were not, so a
  // total never reads as complete when a repository was skipped.
  return { config, truncated, repositories, errors, summary: { ...summarize(repositories), unreadable: errors.length } };
}

function validateExactPath(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('an exact worktree path is required');
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) throw new Error('the worktree path must be absolute');
  if (/[?*\[\]$`]/.test(expanded)) throw new Error('the worktree path contains an unresolved expansion or glob');
  if (expanded.split(path.sep).includes('..')) throw new Error('the worktree path contains parent traversal');
  return canonicalProspective(expanded);
}

// Re-read one worktree's facts immediately before Git acts on it. The audit
// that classified it can take seconds on a large repository, and in that time
// another session can switch it to a detached HEAD with unique commits, write a
// file into it, or lock it. Git itself would still remove a clean detached
// checkout, and still move a dirty one.
function recheckTarget(repository, target, expected) {
  const entry = registeredWorktrees(repository).find((candidate) => canonical(candidate.path) === target);
  if (!entry) throw new Error(`refusing: ${target} is no longer a registered worktree`);
  if (entry.locked) throw new Error(`refusing: ${target} was locked after it was checked`);
  if (entry.detached || entry.branch !== expected.branch || entry.head !== expected.head) {
    throw new Error(`refusing: ${target} changed branch or commit after it was checked`);
  }
  const working = status(target);
  if (!working.readable || working.dirty) throw new Error(`refusing: ${target} has changes made after it was checked`);
}

// What Git's repository-wide prune would actually clear, from its own dry run.
// The audit's list of missing paths can be stale by the time prune runs, so the
// dry run is the evidence, mapped back to paths through each registration's
// gitdir file.
function pruneCandidates(repository) {
  // Git writes these "Removing worktrees/<name>" lines to stderr, not stdout.
  // Reading stdout alone sees an empty list, which looks like nothing to prune.
  const result = spawnSync('git', ['-C', repository, 'worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: MUTATION_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`refusing prune: the dry run failed (${describeFailure('git', ['-C', repository, 'worktree', 'prune'], result,
      'git worktree prune --dry-run --verbose --expire now shows what it would clear, without clearing it')})`);
  }
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  const admin = path.join(commonDir(repository), 'worktrees');
  const paths = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const match = /^Removing worktrees\/(.+?): /.exec(line);
    if (!match) {
      throw new Error(`refusing prune: Git's dry run printed a line this script does not recognise; run git worktree prune --dry-run --verbose --expire now in ${repository} to see it`);
    }
    let gitdir;
    try { gitdir = fs.readFileSync(path.join(admin, match[1], 'gitdir'), 'utf8').trim(); }
    // The registration name comes from Git's output and is named after a
    // user-chosen folder, so it is not printed.
    catch (_) { throw new Error(`refusing prune: cannot tell which path one of Git's registrations belongs to; run git worktree prune --dry-run --verbose --expire now in ${repository} to see them`); }
    // `git worktree add --relative-paths` stores this relative to the
    // registration's own folder, which is how Git resolves it too. Resolving it
    // from the process's folder names the wrong path and refuses a valid prune.
    const absolute = path.isAbsolute(gitdir) ? gitdir : path.resolve(path.join(admin, match[1]), gitdir);
    paths.push(canonicalProspective(path.dirname(absolute)));
  }
  return [...new Set(paths)].sort();
}

function requireExactPruneSet(repository, targets) {
  const candidates = pruneCandidates(repository);
  const unapproved = candidates.filter((candidate) => !targets.includes(candidate));
  const absent = targets.filter((candidate) => !candidates.includes(candidate));
  if (unapproved.length) {
    throw new Error(`refusing prune because Git would also clear unapproved registrations: ${unapproved.join(', ')}`);
  }
  if (absent.length) {
    throw new Error(`refusing prune because Git would not clear these approved paths: ${absent.join(', ')}`);
  }
}

function verifyPrune(repo, rawPaths, options = {}) {
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw new Error('at least one exact missing worktree path is required');
  }
  const targets = [...new Set(rawPaths.map(validateExactPath))].sort();
  if (targets.length !== rawPaths.length) throw new Error('duplicate worktree paths are not accepted');

  const audited = auditRepository(repo, {
    config: options.config || loadConfig(),
    skipRemote: true,
  });
  const unsafePrunable = audited.worktrees.filter((entry) => (
    entry.prunable && entry.state !== STATES.MISSING
  ));
  if (unsafePrunable.length) {
    throw new Error(`refusing prune because Git would also clear registrations that are not approved missing paths: ${unsafePrunable.map((entry) => entry.path).join(', ')}`);
  }
  const missing = audited.worktrees
    .filter((entry) => entry.state === STATES.MISSING)
    .map((entry) => canonicalProspective(entry.path))
    .sort();
  const unapproved = missing.filter((candidate) => !targets.includes(candidate));
  const notMissing = targets.filter((candidate) => !missing.includes(candidate));
  if (notMissing.length) {
    throw new Error(`refusing prune because these paths are not currently missing registrations: ${notMissing.join(', ')}`);
  }
  if (unapproved.length) {
    throw new Error(`refusing prune because Git would also clear unapproved missing registrations: ${unapproved.join(', ')}`);
  }

  requireExactPruneSet(audited.repository, targets);
  return {
    ok: true,
    repository: audited.repository,
    paths: targets,
    branchesPreserved: true,
  };
}

function pruneWorktrees(repo, rawPaths, options = {}) {
  if (!options.approved) throw new Error('refusing prune without --approved');
  const verified = verifyPrune(repo, rawPaths, options);
  // Git prune operates repository-wide, so take Git's own dry run again
  // immediately before it runs. Every registration it would clear must be one
  // the user approved.
  requireExactPruneSet(verified.repository, verified.paths);
  const before = registeredWorktrees(verified.repository).map((entry) => canonicalProspective(entry.path));
  git(verified.repository, ['worktree', 'prune', '--verbose', '--expire', 'now'], {
    timeout: MUTATION_TIMEOUT_MS,
  });
  const after = registeredWorktrees(verified.repository).map((entry) => canonicalProspective(entry.path));
  const stillRegistered = after.filter((candidate) => verified.paths.includes(candidate));
  if (stillRegistered.length) {
    throw new Error(`git reported success but these missing registrations remain: ${stillRegistered.join(', ')}`);
  }
  // The window between the dry run and the prune cannot be closed, so report
  // honestly if Git cleared anything else in it.
  const extra = before.filter((candidate) => !after.includes(candidate) && !verified.paths.includes(candidate));
  if (extra.length) {
    throw new Error(`Git also cleared registrations that were not approved, which changed after the final check: ${extra.join(', ')}`);
  }
  return { ...verified, pruned: true };
}

function auditForPath(raw, options = {}) {
  const target = validateExactPath(raw);
  if (!fs.existsSync(target)) throw new Error(`worktree path does not exist: ${target}`);
  const audited = auditRepository(target, options);
  const entry = audited.worktrees.find((candidate) => canonical(candidate.path) === target);
  if (!entry) throw new Error(`path is not the same registered worktree: ${target}`);
  return { audited, entry, target };
}

function verifyRemove(raw, options = {}) {
  const found = auditForPath(raw, options);
  const cwd = canonical(options.cwd || process.cwd());
  if (contains(found.target, cwd)) throw new Error('refusing to remove the caller\'s current working directory');
  if (!found.entry.removable || found.entry.state !== STATES.MERGED) {
    throw new Error(`refusing to remove ${found.target}: ${found.entry.state}, ${found.entry.reason}`);
  }
  return {
    ok: true,
    repository: found.audited.repository,
    path: found.target,
    branch: found.entry.branch,
    head: found.entry.head,
    state: found.entry.state,
    reason: found.entry.reason,
  };
}

function removeWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing removal without --approved');
  const verified = verifyRemove(raw, options);
  recheckTarget(verified.repository, verified.path, verified);
  git(verified.repository, ['worktree', 'remove', verified.path], { timeout: MUTATION_TIMEOUT_MS });
  if (fs.existsSync(verified.path)) throw new Error('git reported success but the worktree path still exists');
  return { ...verified, removed: true, branchPreserved: true };
}

function moveWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing relocation without --approved');
  // Relocation needs local state, not GitHub state. Requiring a remote lookup
  // here would strand a clean worktree whenever gh is offline even though no
  // deletion decision is being made.
  const found = auditForPath(raw, { ...options, skipRemote: true });
  const cwd = canonical(options.cwd || process.cwd());
  if (contains(found.target, cwd)) throw new Error('refusing to move the caller\'s current working directory');
  if (!found.entry.relocatable || found.entry.primary || found.entry.locked || found.entry.dirty || !found.entry.branch) {
    throw new Error(`refusing to move ${found.target}: ${found.entry.state}, ${found.entry.reason}`);
  }
  const config = options.config || loadConfig();
  const destination = destinationFor(found.audited.repository, found.entry.branch, config, options.task);
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  // Re-check before creating the parent folder, so a refusal leaves nothing behind.
  recheckTarget(found.audited.repository, found.target, found.entry);
  // Checked before mkdir so a refusal creates nothing, and again after it in
  // case a symlink appeared in between.
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before relocation');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before relocation');
  }
  git(found.audited.repository, ['worktree', 'move', found.target, destination], { timeout: MUTATION_TIMEOUT_MS });
  try {
    git(found.audited.repository, ['worktree', 'lock', '--reason', ACTIVE_LOCK_REASON, destination], { timeout: MUTATION_TIMEOUT_MS });
  } catch (lockError) {
    const rolledBack = git(found.audited.repository, ['worktree', 'move', destination, found.target], {
      timeout: MUTATION_TIMEOUT_MS,
      allowFailure: true,
    });
    if (rolledBack === null) {
      throw new Error(`worktree moved to ${destination}, but locking it and moving it back both failed: ${lockError.message}`);
    }
    throw new Error(`worktree relocation was rolled back because its activity lock failed: ${lockError.message}`);
  }
  return { moved: true, from: found.target, path: destination, branch: found.entry.branch, locked: true };
}

function createWorktree(repo, branch, options = {}) {
  const primary = auditRepository(repo, { config: options.config || loadConfig(), skipRemote: true }).repository;
  validateBranch(primary, branch);
  const config = options.config || loadConfig();
  const destination = destinationFor(primary, branch, config, options.task);
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);

  const branchExists = git(primary, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }) !== null;
  if (!branchExists && !options.approved) throw new Error('creating this worktree also creates a branch; rerun with --approved after confirmation');
  let remoteBase = null;
  if (!branchExists && options.base === undefined) {
    const remoteRefs = (git(primary, ['for-each-ref', '--format=%(refname)', 'refs/remotes/'], { allowFailure: true }) || '')
      .split('\n')
      .filter(Boolean)
      .filter((ref) => ref.replace(/^refs\/remotes\/[^/]+\//, '') === branch);
    if (remoteRefs.length > 1) {
      throw new Error(`more than one remote tracks ${branch}; choose one explicitly with --base`);
    }
    remoteBase = remoteRefs[0] || null;
  }
  const base = branchExists ? null : validateBase(primary, options.base === undefined ? (remoteBase || 'HEAD') : options.base);
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before creation');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before creation');
  }
  const args = branchExists
    ? ['worktree', 'add', destination, branch]
    : ['worktree', 'add', ...(remoteBase ? ['--track'] : []), '-b', branch, destination, base];
  git(primary, args, { timeout: MUTATION_TIMEOUT_MS });
  try {
    git(primary, ['worktree', 'lock', '--reason', ACTIVE_LOCK_REASON, destination], { timeout: MUTATION_TIMEOUT_MS });
  } catch (error) {
    const removed = git(primary, ['worktree', 'remove', destination], {
      timeout: MUTATION_TIMEOUT_MS,
      allowFailure: true,
    });
    if (removed === null) {
      throw new Error(`worktree creation reached ${destination}, but locking it and removing it both failed: ${errorText(error)}`);
    }
    if (!branchExists) {
      const branchRemoved = git(primary, ['branch', '-d', branch], {
        timeout: MUTATION_TIMEOUT_MS,
        allowFailure: true,
      });
      if (branchRemoved === null) {
        throw new Error(`worktree creation was removed after its activity lock failed, but the new branch ${branch} remains: ${errorText(error)}`);
      }
    }
    throw new Error(`worktree creation was rolled back because its activity lock failed: ${errorText(error)}`);
  }
  return { created: true, branchCreated: !branchExists, path: destination, branch, locked: true };
}

function activateWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing to lock without --approved');
  const found = auditForPath(raw, { ...options, skipRemote: true });
  if (found.entry.primary) throw new Error('the primary checkout is not managed as agent work');
  if (found.entry.locked) throw new Error('the worktree is already locked');
  // A lock would stop the owning review tool from cleaning up its own checkout.
  if (found.entry.location === 'review-tool') throw new Error('refusing to lock a worktree that belongs to a review tool');
  git(found.audited.repository, [
    'worktree', 'lock', '--reason', ACTIVE_LOCK_REASON, found.target,
  ], { timeout: MUTATION_TIMEOUT_MS });
  return { activated: true, path: found.target, branch: found.entry.branch || null, locked: true };
}

function finishWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing to unlock without --approved');
  const target = validateExactPath(raw);
  const presence = pathPresence(target);
  if (!presence.present && !presence.absenceConfirmed) {
    throw new Error(`the worktree path could not be checked${presence.error ? `: ${presence.error}` : ''}`);
  }
  const exists = presence.present;
  const repo = options.repo || (exists ? target : null);
  if (!repo) throw new Error('a locked worktree whose path is absent requires --repo <primary checkout>');
  const entries = registeredWorktrees(repo);
  const index = entries.findIndex((entry) => canonical(entry.path) === target);
  if (index === -1) throw new Error(`path is not a registered worktree: ${target}`);
  if (index === 0) throw new Error('the primary checkout cannot be finished through worktree hygiene');
  const entry = entries[index];
  if (!entry.locked) throw new Error('the worktree is already unlocked');
  if (exists) {
    const working = status(target);
    if (!working.readable || working.dirty) throw new Error('refusing to unlock a dirty or unreadable worktree');
  }
  const cwd = canonical(options.cwd || process.cwd());
  if (contains(target, cwd)) throw new Error('refusing to finish the caller\'s current working directory');
  git(entries[0].path, ['worktree', 'unlock', target], { timeout: MUTATION_TIMEOUT_MS });
  return {
    finished: true,
    path: target,
    branch: entry.branch || null,
    locked: false,
    missing: !exists,
  };
}

function renderAudit(audit) {
  const lines = [];
  lines.push(`${audit.summary.repositories} repositories, ${audit.summary.worktrees} registered worktrees.`);
  if (audit.truncated) lines.push('The audit was incomplete, so no cleanup count is claimed.');
  if (audit.config && audit.config.exists && !audit.config.valid) {
    lines.push(`The worktreeLocation setting was rejected: ${(audit.config.errors || []).join('; ') || 'no reason given'}. Run /git-hygiene:setup to fix it.`);
  }
  if ((audit.errors || []).length) {
    lines.push(`${audit.errors.length} repositor${audit.errors.length === 1 ? 'y was' : 'ies were'} not read and ${audit.errors.length === 1 ? 'is' : 'are'} not counted above.`);
  }
  for (const failure of audit.errors || []) lines.push(`Could not read ${failure.repository}: ${failure.error}`);
  for (const repo of audit.repositories) {
    lines.push('', repo.repository);
    for (const entry of repo.worktrees) {
      lines.push(`  ${entry.state.padEnd(15)} ${entry.path}${entry.branch ? `  (${entry.branch})` : ''}`);
      lines.push(`                  ${entry.reason}`);
    }
  }
  if (!audit.repositories.length && !audit.truncated && !(audit.errors || []).length) lines.push('No configured repositories were found.');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'audit', json: false, allConfigured: false, paths: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--path') { out.path = argv[++i]; out.paths.push(out.path); }
    else if (arg === '--branch') out.branch = argv[++i];
    else if (arg === '--base') out.base = argv[++i];
    else if (arg === '--task') out.task = argv[++i];
    else if (arg === '--json') out.json = true;
    else if (arg === '--all-configured') out.allConfigured = true;
    else if (arg === '--approved') out.approved = true;
    // Never echoed: even a plain-looking word here may be a pasted token.
    else throw new Error('unknown argument; accepted options: --repo --path --branch --base --task --json --all-configured --approved');
  }
  return out;
}

function output(value, json) {
  const text = json || typeof value !== 'string'
    ? JSON.stringify(redactValue(value), null, 2)
    : redactCredentials(value);
  process.stdout.write(text + '\n');
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${redactCredentials(errorText(error))}\n`); process.exit(2); }

  try {
    // --repo reaches `git -C` and is printed when a step fails, so it must be
    // a folder that exists: then it is a path, never pasted text.
    // Only where --repo is read. remove, move, activate and verify-remove find
    // the repository from --path, and a configured audit from its settings, so
    // a stale --repo passed to them must not stop them.
    const readsRepo = ['destination', 'create', 'verify-prune', 'prune', 'finish'].includes(args.command)
      || (args.command === 'audit' && !args.allConfigured);
    if (args.repo !== undefined && readsRepo) {
      let isFolder = false;
      try { isFolder = fs.statSync(args.repo).isDirectory(); } catch (_) { isFolder = false; }
      if (!isFolder) throw new Error('--repo must name an existing folder');
    }
    if (args.command === 'audit') {
      let audit;
      if (args.allConfigured) audit = auditConfigured();
      else {
        const repo = args.repo || process.cwd();
        const repository = auditRepository(repo);
        audit = { config: loadConfig(), truncated: repository.truncated, repositories: [repository], summary: summarize([repository]) };
      }
      output(args.json ? audit : renderAudit(audit), args.json);
      return;
    }
    if (args.command === 'destination') {
      output({
        repository: (() => {
          const listed = registeredWorktrees(args.repo || process.cwd());
          if (!listed.length) throw new Error(`no registered worktrees found for ${args.repo || process.cwd()}`);
          return listed[0].path;
        })(),
        branch: args.branch,
        path: destinationFor(args.repo || process.cwd(), args.branch, loadConfig(), args.task),
      }, true);
    }
    else if (args.command === 'create') output(createWorktree(args.repo || process.cwd(), args.branch, args), true);
    else if (args.command === 'move') output(moveWorktree(args.path, args), true);
    else if (args.command === 'activate') output(activateWorktree(args.path, args), true);
    else if (args.command === 'verify-prune') output(verifyPrune(args.repo || process.cwd(), args.paths, args), true);
    else if (args.command === 'prune') output(pruneWorktrees(args.repo || process.cwd(), args.paths, args), true);
    else if (args.command === 'verify-remove') output(verifyRemove(args.path, args), true);
    else if (args.command === 'remove') output(removeWorktree(args.path, args), true);
    else if (args.command === 'finish') output(finishWorktree(args.path, args), true);
    else throw new Error('unknown command; accepted: audit destination create move activate verify-prune prune verify-remove remove finish');
  } catch (error) {
    process.stderr.write(`${redactCredentials(errorText(error))}\n`);
    process.exit(3);
  }
}

if (require.main === module) main();

module.exports = {
  STATES,
  placementCounts,
  pruneCandidates,
  recheckTarget,
  activateWorktree,
  auditConfigured,
  auditForPath,
  auditRepository,
  branchEvidence,
  classifyEntry,
  createWorktree,
  destinationFor,
  errorText,
  shown,
  discoverRepositories,
  finishWorktree,
  moveWorktree,
  parsePorcelain,
  pathPresence,
  pullRequestEvidence,
  pruneWorktrees,
  redactCredentials,
  removeWorktree,
  renderAudit,
  summarize,
  validateExactPath,
  verifyPrune,
  verifyRemove,
};
