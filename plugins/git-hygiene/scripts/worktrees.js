#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
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
    const detail = (result.stderr || result.stdout || (result.error && result.error.message) || 'command failed').trim();
    throw new Error(`${file} ${args.join(' ')}: ${detail}`);
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
// `.worktrees/owner -> /somewhere/else` makes the leaf absent while still
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

function remoteIdentity(repo, deadline) {
  const url = git(repo, ['remote', 'get-url', 'origin'], {
    timeout: remaining(deadline),
    allowFailure: true,
  });
  if (!url) return null;

  let host = null;
  let pathname = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      pathname = parsed.pathname.replace(/^\//, '');
    } catch (_) {
      return null;
    }
  } else {
    const scp = /^([^@]+@)?([^:]+):(.+)$/.exec(url);
    if (!scp || /^[A-Za-z]:[\\/]/.test(url)) return null;
    host = scp[2];
    pathname = scp[3];
  }

  const parts = String(pathname || '').replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return {
    host: String(host).toLowerCase(),
    namespace: parts.slice(0, -1),
    owner: parts[parts.length - 2],
    repository: parts[parts.length - 1],
    github: /(^|\.)github\.com$/i.test(host || ''),
  };
}

function safeSegment(value) {
  const source = String(value || '');
  if (!source) throw new Error(`cannot turn ${value} into a safe path segment`);
  // Percent-encode every byte outside the deliberately small readable set.
  // Lossy replacement makes distinct valid refs such as a+b and a-b collide.
  try {
    const encoded = encodeURIComponent(source)
      .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    if (encoded === '.') return '%2E';
    if (encoded === '..') return '%2E%2E';
    return encoded;
  } catch (_) {
    throw new Error(`cannot turn ${value} into a safe path segment`);
  }
}

function validateBranch(repo, branch) {
  if (!branch || branch.startsWith('-') || branch.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`refusing unsafe branch name: ${branch || '(empty)'}`);
  }
  const valid = git(repo, ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (valid === null) throw new Error(`refusing invalid branch name: ${branch}`);
  return branch;
}

function validateBase(repo, base) {
  if (!base || typeof base !== 'string' || base.startsWith('-')) {
    throw new Error(`refusing unsafe base revision: ${base || '(empty)'}`);
  }
  const resolved = git(repo, ['rev-parse', '--verify', `${base}^{commit}`], { allowFailure: true });
  if (resolved === null) throw new Error(`refusing unknown base revision: ${base}`);
  return base;
}

function destinationFor(repo, branch, config = loadConfig()) {
  if (!config.exists || !config.valid) throw new Error('run /git-hygiene:setup before creating or moving worktrees');
  const registered = registeredWorktrees(repo);
  const primary = registered.length ? registered[0].path : topLevel(repo);
  validateBranch(primary, branch);
  const identity = remoteIdentity(primary);
  let pieces;
  if (identity) {
    // Keep the documented GitHub owner/repository layout for its single-level
    // namespace. Other hosts include the host and full namespace so two
    // distinct remotes cannot collapse onto one checkout destination.
    pieces = identity.github && identity.namespace.length === 1
      ? [safeSegment(identity.owner), safeSegment(identity.repository)]
      : [safeSegment(identity.host), ...identity.namespace.map(safeSegment), safeSegment(identity.repository)];
  } else {
    pieces = [
      'local',
      `${safeSegment(path.basename(primary))}-${crypto.createHash('sha256').update(commonDir(primary)).digest('hex').slice(0, 10)}`,
    ];
  }
  const target = path.join(config.worktreeRoot, ...pieces, ...branch.split('/').map(safeSegment));
  const root = canonicalProspective(config.worktreeRoot);
  const resolvedTarget = canonicalProspective(target);
  if (!contains(root, resolvedTarget) || resolvedTarget === root) {
    throw new Error('the computed worktree path escaped the configured root');
  }
  return resolvedTarget;
}

function classifyLocation(candidate, config) {
  const here = canonical(candidate);
  if (contains(config.worktreeRoot, here)) return 'managed-root';
  if (REVIEW_LOCATION.test(here.replace(/\\/g, '/'))) return 'review-tool';
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

function pullRequestEvidence(repo, identity, branch, head, defaultBranch, deadline) {
  if (!identity || !identity.github) return { available: true, open: false, merged: false, mergedVia: null };
  const out = run('gh', [
    'pr', 'list', '--repo', `${identity.owner}/${identity.repository}`,
    '--head', branch, '--state', 'all', '--limit', '100',
    '--json', 'number,state,mergedAt,headRefOid,baseRefName',
  ], { timeout: remaining(deadline), allowFailure: true });
  if (out === null) return { available: false, open: false, merged: false, mergedVia: null };
  try {
    const rows = JSON.parse(out || '[]');
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

  if (!prs.available) return { state: STATES.UNKNOWN, reason: 'pull-request evidence could not be read' };
  if (prs.open) return { state: STATES.OPEN, reason: 'the branch has an open pull request' };
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
    locked: entry.locked || null,
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
    result.reason = `the worktree is locked${entry.locked === 'locked' ? '' : `: ${entry.locked}`}`
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

function discoverRepositories(projectRoots, deadline) {
  const repositories = [];
  const seen = new Set();
  for (const root of projectRoots) {
    if (deadline && Date.now() >= deadline) return { repositories, truncated: true };
    try {
      const top = topLevel(root, deadline);
      if (top === canonical(root)) {
        const identity = commonDir(root, deadline);
        if (!seen.has(identity)) {
          seen.add(identity);
          repositories.push(root);
        }
        // A configured repository is itself the unit of discovery. Do not
        // descend into its working tree and mistake nested repositories for
        // sibling projects.
        continue;
      }
    } catch (_) {
      // Container roots are the ordinary case and are scanned one level below.
    }
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const entry of entries) {
      if (deadline && Date.now() >= deadline) return { repositories, truncated: true };
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const candidate = path.join(root, entry.name);
      let top;
      try { top = topLevel(candidate, deadline); }
      catch (_) { continue; }
      if (top !== canonical(candidate)) continue;
      let identity;
      try { identity = commonDir(candidate, deadline); }
      catch (_) { continue; }
      if (seen.has(identity)) continue;
      seen.add(identity);
      repositories.push(candidate);
    }
  }
  return { repositories, truncated: false };
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
    held: worktrees.filter((entry) => !entry.primary && !entry.removable).length,
  };
}

function auditConfigured(options = {}) {
  const config = options.config || loadConfig();
  const roots = config.exists && config.valid ? config.projectRoots : [];
  const discovered = discoverRepositories(roots, options.deadline);
  const repositories = [];
  let truncated = discovered.truncated;
  for (const repo of discovered.repositories) {
    if (options.deadline && Date.now() >= options.deadline) { truncated = true; break; }
    const audited = auditRepository(repo, { ...options, config });
    repositories.push(audited);
    if (audited.truncated) { truncated = true; break; }
  }
  return { config, truncated, repositories, summary: summarize(repositories) };
}

function validateExactPath(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('an exact worktree path is required');
  const expanded = expandHome(raw);
  if (!path.isAbsolute(expanded)) throw new Error('the worktree path must be absolute');
  if (/[?*\[\]$`]/.test(expanded)) throw new Error('the worktree path contains an unresolved expansion or glob');
  if (expanded.split(path.sep).includes('..')) throw new Error('the worktree path contains parent traversal');
  return canonicalProspective(expanded);
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

  git(audited.repository, ['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now'], {
    timeout: MUTATION_TIMEOUT_MS,
  });
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
  // Git prune operates repository-wide, so repeat the complete exact-set check
  // immediately before it runs. Every currently eligible registration must be
  // one of the paths the user approved.
  verifyPrune(verified.repository, verified.paths, options);
  git(verified.repository, ['worktree', 'prune', '--verbose', '--expire', 'now'], {
    timeout: MUTATION_TIMEOUT_MS,
  });
  const stillRegistered = registeredWorktrees(verified.repository)
    .map((entry) => canonicalProspective(entry.path))
    .filter((candidate) => verified.paths.includes(candidate));
  if (stillRegistered.length) {
    throw new Error(`git reported success but these missing registrations remain: ${stillRegistered.join(', ')}`);
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
    state: found.entry.state,
    reason: found.entry.reason,
  };
}

function removeWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing removal without --approved');
  const verified = verifyRemove(raw, options);
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
  const destination = destinationFor(found.audited.repository, found.entry.branch, config);
  if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before relocation');
  }
  git(found.audited.repository, ['worktree', 'move', found.target, destination], { timeout: MUTATION_TIMEOUT_MS });
  try {
    git(found.audited.repository, ['worktree', 'lock', '--reason', 'git-hygiene: active agent work', destination], { timeout: MUTATION_TIMEOUT_MS });
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
  const destination = destinationFor(primary, branch, config);
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
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (canonicalProspective(destination) !== destination) {
    throw new Error('the computed worktree path changed through a symlink before creation');
  }
  const args = branchExists
    ? ['worktree', 'add', destination, branch]
    : ['worktree', 'add', ...(remoteBase ? ['--track'] : []), '-b', branch, destination, base];
  git(primary, args, { timeout: MUTATION_TIMEOUT_MS });
  try {
    git(primary, ['worktree', 'lock', '--reason', 'git-hygiene: active agent work', destination], { timeout: MUTATION_TIMEOUT_MS });
  } catch (error) {
    const removed = git(primary, ['worktree', 'remove', destination], {
      timeout: MUTATION_TIMEOUT_MS,
      allowFailure: true,
    });
    if (removed === null) {
      throw new Error(`worktree creation reached ${destination}, but locking it and removing it both failed: ${error.message}`);
    }
    if (!branchExists) {
      const branchRemoved = git(primary, ['branch', '-d', branch], {
        timeout: MUTATION_TIMEOUT_MS,
        allowFailure: true,
      });
      if (branchRemoved === null) {
        throw new Error(`worktree creation was removed after its activity lock failed, but the new branch ${branch} remains: ${error.message}`);
      }
    }
    throw new Error(`worktree creation was rolled back because its activity lock failed: ${error.message}`);
  }
  return { created: true, branchCreated: !branchExists, path: destination, branch, locked: true };
}

function activateWorktree(raw, options = {}) {
  if (!options.approved) throw new Error('refusing to lock without --approved');
  const found = auditForPath(raw, { ...options, skipRemote: true });
  if (found.entry.primary) throw new Error('the primary checkout is not managed as agent work');
  if (found.entry.locked) throw new Error('the worktree is already locked');
  git(found.audited.repository, [
    'worktree', 'lock', '--reason', 'git-hygiene: active agent work', found.target,
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
  for (const repo of audit.repositories) {
    lines.push('', repo.repository);
    for (const entry of repo.worktrees) {
      lines.push(`  ${entry.state.padEnd(15)} ${entry.path}${entry.branch ? `  (${entry.branch})` : ''}`);
      lines.push(`                  ${entry.reason}`);
    }
  }
  if (!audit.repositories.length && !audit.truncated) lines.push('No configured repositories were found.');
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
    else if (arg === '--json') out.json = true;
    else if (arg === '--all-configured') out.allConfigured = true;
    else if (arg === '--approved') out.approved = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function output(value, json) {
  if (json || typeof value !== 'string') process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else process.stdout.write(value + '\n');
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }

  try {
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
        repository: auditRepository(args.repo || process.cwd(), { skipRemote: true }).repository,
        branch: args.branch,
        path: destinationFor(args.repo || process.cwd(), args.branch),
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
    else throw new Error(`unknown command: ${args.command}`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  }
}

if (require.main === module) main();

module.exports = {
  STATES,
  activateWorktree,
  auditConfigured,
  auditForPath,
  auditRepository,
  branchEvidence,
  classifyEntry,
  createWorktree,
  destinationFor,
  discoverRepositories,
  finishWorktree,
  moveWorktree,
  parsePorcelain,
  pathPresence,
  pullRequestEvidence,
  pruneWorktrees,
  removeWorktree,
  renderAudit,
  summarize,
  validateExactPath,
  verifyPrune,
  verifyRemove,
};
