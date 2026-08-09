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
// one place at once. A git worktree is the case that forced it: the AlwaysAllow
// site is checked out at ~/Projects/always-allow/site and again under
// /private/tmp while a branch is in flight, and a guard that only knows the
// first one is off exactly when the work is happening.
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

function bashWritesPath(command, resource, cwd) {
  const raw = String(command || '');
  if (!raw) return false;
  // Judged one location at a time, so a resource covering several places is
  // guarded in every one of them rather than only the first.
  return resourcePaths(resource).some((spelling) => bashWritesOnePath(raw, resource, spelling, cwd));
}

function bashWritesOnePath(raw, resource, resourcePath, cwd) {
  const target = absolutePath(resourcePath, cwd);
  if (!target) return false;

  const spellings = new Set([resourcePath, target]);
  if (target.startsWith(os.homedir() + path.sep)) {
    spellings.add('~/' + path.relative(os.homedir(), target));
  }
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

// Every file opened with the Read tool in this session.
//
// The transcript rather than a state file, because the question being asked is
// "is this document in front of you right now", and the transcript is the only
// thing that actually knows. A receipt written to disk survives a context that
// has moved on, which would make the gate pass while the document is no longer
// anywhere the work can see it.
//
// Deliberately only the Read tool. Reading a file with `cat` in a Bash call
// scrolls it past and is not the same as having it loaded, and the whole point
// of this gate is that the document is present, not that it was glanced at.
function readsInTranscript(transcriptPath) {
  const seen = new Set();
  if (!transcriptPath) return seen;
  let raw;
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch (_) { return seen; }
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('"Read"') === -1) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_use' || block.name !== 'Read') continue;
      const file = block.input && block.input.file_path;
      if (file) seen.add(realPathWithMissingTail(absolutePath(file)));
    }
  }
  return seen;
}

// Which of a resource's required documents have not been read in this session.
// Empty means the gate is satisfied, including when the resource asks for
// nothing, which is every resource that existed before this.
function unreadRequirements(resource, transcriptPath, cwd) {
  const required = Array.isArray(resource.requiresRead) ? resource.requiresRead : [];
  if (!required.length) return [];
  const seen = readsInTranscript(transcriptPath);
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
