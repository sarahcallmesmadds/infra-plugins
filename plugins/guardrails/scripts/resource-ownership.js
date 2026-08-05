'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEASE_TTL_MS = 30 * 60 * 1000;
const LEASE_MAX_MS = 2 * 60 * 60 * 1000;
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

function loadRegistry(pluginRoot) {
  const shipped = path.join(pluginRoot, 'hooks', 'resource-owners.json');
  const custom = path.join(os.homedir(), '.claude', 'guardrails.resources.json');
  let registry = JSON.parse(fs.readFileSync(shipped, 'utf8'));
  if (fs.existsSync(custom)) registry = JSON.parse(fs.readFileSync(custom, 'utf8'));
  if (!registry || !Array.isArray(registry.resources)) throw new Error('resource registry has no resources array');
  return registry.resources;
}

function contains(resource, candidate, cwd) {
  const target = absolutePath(resource.path, cwd);
  const actual = absolutePath(candidate, cwd);
  if (!target || !actual) return false;
  if (resource.type === 'file') return actual === target;
  const relative = path.relative(target, actual);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function bashWritesPath(command, resource, cwd) {
  const target = absolutePath(resource.path, cwd);
  const raw = String(command || '');
  if (!target || !raw) return false;

  const spellings = new Set([resource.path, target]);
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
  for (const segment of raw.split(/&&|\|\||[;|\n\r]/)) {
    if (!normalizedSpellings.some((spelling) => segment.includes(spelling))) continue;
    if (new RegExp(`>>?\\s*["']?(?:${pathPattern})(?:[/"'\\s]|$)`).test(segment)) return true;
    if (new RegExp(`\\b(?:tee|mv|truncate|touch|mkdir|rm)\\b[^;|\\n\\r]*(?:${pathPattern})`).test(segment)) return true;
    if (/\bsed\s+(?:-[^\s]*i[^\s]*)\b/.test(segment)) return true;

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
    if (now - lease.touchedAt >= LEASE_TTL_MS || now - lease.startedAt >= LEASE_MAX_MS) return null;
    return lease;
  } catch (_) {
    return null;
  }
}

function renewLeases(resources, sessionId, now = Date.now(), leaseDir) {
  const skills = [...new Set(resources.flatMap((resource) => resource.owners || []))];
  for (const skill of skills) {
    const lease = readLease(skill, sessionId, now, leaseDir);
    if (!lease) continue;
    lease.touchedAt = now;
    atomicWriteLease(leasePath(skill, sessionId, leaseDir), lease);
  }
}

function activeOwner(resource, sessionId, now = Date.now(), leaseDir) {
  return (resource.owners || []).find((skill) => readLease(skill, sessionId, now, leaseDir)) || null;
}

module.exports = {
  LEASE_MAX_MS,
  LEASE_TTL_MS,
  absolutePath,
  activeOwner,
  atomicWriteLease,
  bashWritesPath,
  contains,
  leasePath,
  loadRegistry,
  matchedResource,
  readLease,
  renewLeases,
  writeLease,
};
