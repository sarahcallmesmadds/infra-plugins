'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEASE_TTL_MS = 30 * 60 * 1000;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function absolutePath(value, cwd) {
  const expanded = expandHome(String(value || ''));
  if (!expanded) return '';
  return path.resolve(cwd || process.cwd(), expanded);
}

function loadRegistry(pluginRoot, home = os.homedir()) {
  const shipped = path.join(pluginRoot, 'hooks', 'resource-owners.json');
  const custom = path.join(home, '.claude', 'guardrails.resources.json');
  const fallback = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  let registry = fallback;
  if (fs.existsSync(custom)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(custom, 'utf8'));
      if (candidate && Array.isArray(candidate.resources)) registry = candidate;
    }
    catch (_) { registry = fallback; }
  }
  if (!registry || !Array.isArray(registry.resources)) throw new Error('resource registry has no resources array');
  return registry.resources;
}

function realPathWithMissingTail(value) {
  let existing = value;
  const tail = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return value;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync(existing), ...tail); }
  catch (_) { return value; }
}

// Every location a resource covers. `path` is the original single form and
// stays; `paths` exists because the same logical resource can live in more than
// one place at once. A git worktree is the case that forced it: a directory is
// checked out at its canonical path and again under a temporary one while a
// branch is in flight, and a guard that only knows the first is off exactly
// when the work is happening.
function resourcePaths(resource) {
  const many = Array.isArray(resource.paths) ? resource.paths : [];
  return [resource.path, ...many].filter(Boolean);
}

function contains(resource, candidate, cwd) {
  const actual = realPathWithMissingTail(absolutePath(candidate, cwd));
  if (!actual) return false;
  return resourcePaths(resource).some((spelling) => {
    const target = realPathWithMissingTail(absolutePath(spelling, cwd));
    if (!target) return false;
    if (resource.type === 'file') return actual === target;
    const relative = path.relative(target, actual);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

function shellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (char === '\\' && quote !== "'") {
      current += char + (command[i + 1] || '');
      i += 1;
      continue;
    }
    if ((char === "'" || char === '"')) {
      quote = quote === char ? null : (quote || char);
      current += char;
      continue;
    }
    if (!quote && (';|\n\r'.includes(char) || (char === '&' && command[i + 1] === '&'))) {
      segments.push(current);
      current = '';
      if ((char === '|' && command[i + 1] === '|') || (char === '&' && command[i + 1] === '&')) i += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

const WRITE_COMMANDS = /^(?:tee|mv|truncate|touch|mkdir|rm)$/;
const COPY_COMMANDS = /^(?:cp|install)$/;

// Whether a shell command writes anywhere the resource covers.
//
// Every candidate destination is judged with `contains`, the same test the
// Write and Edit path uses, so both sides go through realpath and `~`
// expansion. Comparing the registry spelling as a literal string was the
// earlier approach and it missed the case this guard exists for: on macOS
// /tmp is a symlink to /private/tmp, so a worktree registered under one
// spelling is written through the other all day.
function bashWritesPath(command, resource, cwd) {
  const raw = String(command || '');
  if (!raw) return false;
  // Judge one shell segment at a time. A path mentioned after `&&`, `;` or a
  // pipe is not an argument to the write command before it.
  return shellSegments(raw).some((segment) => segmentWritesPath(segment, resource, cwd));
}

function shellTokens(segment) {
  return (segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
}

// Programs that hand off to another command rather than doing the work
// themselves, so the write belongs to whatever comes next. `sudo tee` is the
// same write as `tee`, and `git rm` deletes a working-tree file.
const COMMAND_WRAPPERS = /^(?:sudo|doas|env|xargs|time|nohup|nice|command|git)$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Tokens that could name a file: not a flag, not a redirection, and not the
// scaffolding `find -exec` leaves in the argument list.
function pathArguments(tokens) {
  return tokens.filter((token) => token
    && !token.startsWith('-')
    && !['{}', ';', '+'].includes(token)
    && !/^[<>]/.test(token)
    && !/^\d*>>?/.test(token));
}

// Where the program name sits, stepping over leading `FOO=bar` assignments and
// wrappers. Only that one token decides whether a segment writes, which is the
// difference between `rm` and `docker rm` and between `install` and
// `npm install`. Matching a write command in any position instead reads every
// subcommand of that name as a write, and since a bare argument resolves
// against the event cwd, that turns `npm install` into a blocked write for
// anyone whose shell is sitting inside a guarded directory.
function commandIndex(tokens) {
  let index = 0;
  while (index < tokens.length
    && (ASSIGNMENT.test(tokens[index]) || COMMAND_WRAPPERS.test(path.basename(tokens[index])))) {
    index += 1;
  }
  return index;
}

function redirectTargets(segment) {
  return (segment.match(/>>?\s*["']?[^\s"'|;&<>]+/g) || [])
    .map((redirect) => redirect.replace(/^>>?\s*["']?/, ''));
}

function segmentWritesPath(segment, resource, cwd) {
  if (redirectTargets(segment).some((target) => contains(resource, target, cwd))) return true;

  const tokens = shellTokens(segment);
  const index = commandIndex(tokens);
  if (index >= tokens.length) return false;
  const name = path.basename(tokens[index]);
  const rest = tokens.slice(index + 1);
  const args = pathArguments(rest);

  if (WRITE_COMMANDS.test(name)) return args.some((arg) => contains(resource, arg, cwd));

  // cp and install read every argument except the last one. Only the last
  // path is their destination, so copying a protected file out is allowed.
  if (COPY_COMMANDS.test(name)) return args.length > 0 && contains(resource, args.at(-1), cwd);

  if (name === 'sed' && rest.some((flag) => /^-[^\s]*i/.test(flag))) {
    return args.some((arg) => contains(resource, arg, cwd));
  }
  return false;
}

function matchedResource(event, resources) {
  const input = event.tool_input || {};
  const cwd = event.cwd || process.cwd();
  if (WRITE_TOOLS.has(event.tool_name)) {
    const candidate = input.file_path || input.notebook_path;
    return resources.find((resource) => contains(resource, candidate, cwd)) || null;
  }
  if (event.tool_name === 'Bash') {
    return resources.find((resource) => bashWritesPath(input.command, resource, cwd)) || null;
  }
  return null;
}

function keyPart(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 20);
}

function leasePath(skill, sessionId, leaseDir = path.join(os.homedir(), '.claude', 'guardrails-leases')) {
  const safeSkill = String(skill).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80);
  return path.join(leaseDir, `.guardrails-owner-${keyPart(sessionId)}-${safeSkill}.json`);
}

function atomicWriteLease(file, lease) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(lease), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) { /* rename succeeded, or nothing was written */ }
  }
}

function writeLease(skill, sessionId, now = Date.now(), leaseDir) {
  const file = leasePath(skill, sessionId, leaseDir);
  atomicWriteLease(file, { skill, sessionId: keyPart(sessionId), startedAt: now, touchedAt: now });
  return file;
}

function readLease(skill, sessionId, now = Date.now(), leaseDir) {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(skill, sessionId, leaseDir), 'utf8'));
    if (lease.sessionId !== keyPart(sessionId)) return null;
    if (now - lease.touchedAt >= LEASE_TTL_MS) return null;
    return lease;
  } catch (_) {
    return null;
  }
}

function activeOwner(resource, sessionId, now = Date.now(), leaseDir) {
  return (resource.owners || []).find((skill) => readLease(skill, sessionId, now, leaseDir)) || null;
}

// Every file opened with the Read tool in this session, or null when the
// transcript cannot be read at all.
//
// The transcript rather than a state file, because the question being asked is
// "was this document opened in this session", and the transcript is the record
// of that. It is a proxy, and the limit is worth stating rather than
// overclaiming: the transcript is an append-only file that compaction does not
// rewrite, so a Read from before a compaction still satisfies the gate even
// though the document has left the working context. That is accepted. The
// alternative, a receipt written to disk, would also survive a context that
// moved on and would additionally survive the session itself.
//
// Deliberately only the Read tool. Reading a file with `cat` in a Bash call
// scrolls it past and is not the same as having it loaded, and the whole point
// of this gate is that the document is present, not that it was glanced at.
//
// Null rather than an empty set when the transcript is missing or unreadable.
// "Nobody opened it" and "we cannot tell" are different answers, and only one
// of them should stop a write. See `unreadRequirements`.
function readsInTranscript(transcriptPath, cwd) {
  if (!transcriptPath) return null;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch (_) { return null; }
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('"Read"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || block.name !== 'Read') continue;
      const file = block.input && block.input.file_path;
      // Resolved against the event's cwd, the same base the required files use,
      // so a relative path on either side cannot compare against two different
      // roots and hold the gate shut forever.
      if (file) seen.add(realPathWithMissingTail(absolutePath(file, cwd)));
    }
  }
  return seen;
}

// Which of a resource's required documents have not been read in this session.
// Empty means the gate is satisfied, including when the resource asks for
// nothing, which is every resource that existed before this.
//
// Also empty when the transcript is unavailable. Every hook in this plugin
// fails open, and this is the one gate that could turn "we could not tell"
// into a refusal with no way through: an unreadable transcript looks exactly
// like a session where nothing was read, so the block would tell someone to
// open a document they may already have open and would never lift.
function unreadRequirements(resource, transcriptPath, cwd) {
  const required = Array.isArray(resource.requiresRead) ? resource.requiresRead : [];
  if (!required.length) return [];
  const seen = readsInTranscript(transcriptPath, cwd);
  if (!seen) return [];
  return required.filter((file) => !seen.has(realPathWithMissingTail(absolutePath(file, cwd))));
}

module.exports = {
  LEASE_TTL_MS,
  absolutePath,
  activeOwner,
  readsInTranscript,
  resourcePaths,
  unreadRequirements,
  atomicWriteLease,
  bashWritesPath,
  contains,
  leasePath,
  loadRegistry,
  matchedResource,
  readLease,
  writeLease,
};
