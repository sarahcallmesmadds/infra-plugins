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

// Whether a shell command writes anywhere the resource covers.
//
// Every registered spelling is considered, not only `path`, so a resource that
// lists a worktree under `paths` is guarded there too.
//
// The detection is deliberately conservative and stays that way in this change.
// It fires only when a segment literally contains one of the registered
// spellings, which is why it does not misread a `>` inside quoted text as a
// redirection. It also means it cannot see a write that reaches the same
// directory by another spelling, `/tmp` for `/private/tmp` on macOS being the
// obvious one, or one built from a bare relative name. Both gaps are real and
// predate this change; widening the detection is its own piece of work, because
// the version that tried to do it here traded those misses for refusing
// `grep "a>b"` inside a guarded directory, and a guard that blocks ordinary
// commands is one that gets switched off.
//
// The Write and Edit path does not share this limitation. It goes through
// `contains`, which resolves symlinks and relative names properly.
function bashWritesPath(command, resource, cwd) {
  const raw = String(command || '');
  if (!raw) return false;

  const spellings = new Set();
  for (const spelling of resourcePaths(resource)) {
    const target = absolutePath(spelling, cwd);
    if (!target) continue;
    spellings.add(spelling);
    spellings.add(target);
    if (target.startsWith(os.homedir() + path.sep)) {
      spellings.add(`~/${path.relative(os.homedir(), target)}`);
    }
  }
  if (!spellings.size) return false;

  const normalizedSpellings = [...spellings]
    .map((spelling) => spelling && spelling.replace(/\/$/, ''))
    .filter(Boolean);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathPattern = normalizedSpellings.map(escape).join('|');

  // Judge one shell segment at a time. A path mentioned after `&&`, `;` or a
  // pipe is not an argument to the write command before it.
  for (const segment of shellSegments(raw)) {
    if (!normalizedSpellings.some((spelling) => segment.includes(spelling))) continue;
    if (new RegExp(`>>?\\s*["']?(?:${pathPattern})(?:[/"'\\s]|$)`).test(segment)) return true;
    if (new RegExp(`\\b(?:tee|mv|truncate|touch|mkdir|rm)\\b[^;|\\n\\r]*(?:${pathPattern})`).test(segment)) return true;
    if (/\bsed\s+(?:-[^\s]*i[^\s]*)\b/.test(segment)) {
      const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      if (tokens.some((token) => contains(resource, token.replace(/^['"]|['"]$/g, ''), cwd))) return true;
    }

    // cp and install read every argument except the last one. Only the last
    // path is their destination, so copying a protected file out is allowed.
    if (/\b(?:cp|install)\b/.test(segment)) {
      const tokens = segment.trim().match(/"[^"]*"|'[^']*'|\S+/g) || [];
      const destination = (tokens.at(-1) || '').replace(/^['"]|['"]$/g, '');
      if (contains(resource, destination, cwd)) return true;
    }
  }
  return false;
}

// Every resource a write touches, not the first one.
//
// It used to return one, which was correct while every resource asked the same
// single question. With two independent gates it stops being correct: a broad
// directory carrying `owners` and a narrower one inside it carrying
// `requiresRead` are both live, and returning whichever the registry happens to
// list first silently switches the other off. Registry order is not something
// anyone should have to reason about to know which rules apply.
function matchedResources(event, resources) {
  const input = event.tool_input || {};
  const cwd = event.cwd || process.cwd();
  if (WRITE_TOOLS.has(event.tool_name)) {
    const candidate = input.file_path || input.notebook_path;
    return resources.filter((resource) => contains(resource, candidate, cwd));
  }
  if (event.tool_name === 'Bash') {
    return resources.filter((resource) => bashWritesPath(input.command, resource, cwd));
  }
  return [];
}

// Kept because it is exported and used elsewhere. The plural is what the guard
// asks for now.
function matchedResource(event, resources) {
  return matchedResources(event, resources)[0] || null;
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

// Which files were opened with the Read tool in this session.
//
// Returns null, and not an empty set, when the record cannot be consulted at
// all. The two are different facts and the caller has to be able to tell them
// apart: "nothing was read" is a reason to refuse, "we could not look" is not.
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
// Also empty when the record is unavailable. Every hook in this plugin fails
// open, and this is the one gate that could turn "we could not tell" into a
// refusal with no way through: an unreadable record looks exactly like a
// session where nothing was read, so the block would tell someone to open a
// document they may already have open and would never lift.
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
  atomicWriteLease,
  bashWritesPath,
  contains,
  leasePath,
  loadRegistry,
  matchedResource,
  matchedResources,
  readLease,
  readsInTranscript,
  resourcePaths,
  unreadRequirements,
  writeLease,
};
