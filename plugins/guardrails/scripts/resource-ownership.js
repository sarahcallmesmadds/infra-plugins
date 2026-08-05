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
  const mentions = normalizedSpellings.some((spelling) => raw.includes(spelling));
  if (!mentions) return false;

  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const redirectsToResource = normalizedSpellings.some((spelling) => (
    new RegExp(`>>?\\s*["']?${escape(spelling)}(?:[/"'\\s]|$)`).test(raw)
  ));

  return /(?:^|\s)(?:tee|cp|mv|install|truncate|touch|mkdir|rm)\b/.test(raw)
    || redirectsToResource
    || /\bsed\s+(?:-[^\s]*i[^\s]*)\b/.test(raw);
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

function leasePath(skill, sessionId, tempDir = os.tmpdir()) {
  const safeSkill = String(skill).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80);
  return path.join(tempDir, `.guardrails-owner-${keyPart(sessionId)}-${safeSkill}.json`);
}

function writeLease(skill, sessionId, now = Date.now(), tempDir = os.tmpdir()) {
  const file = leasePath(skill, sessionId, tempDir);
  fs.writeFileSync(file, JSON.stringify({ skill, sessionId: keyPart(sessionId), startedAt: now, touchedAt: now }), { mode: 0o600 });
  return file;
}

function readLease(skill, sessionId, now = Date.now(), tempDir = os.tmpdir()) {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(skill, sessionId, tempDir), 'utf8'));
    if (lease.sessionId !== keyPart(sessionId)) return null;
    if (now - lease.touchedAt >= LEASE_TTL_MS || now - lease.startedAt >= LEASE_MAX_MS) return null;
    return lease;
  } catch (_) {
    return null;
  }
}

function renewLeases(resources, sessionId, now = Date.now(), tempDir = os.tmpdir()) {
  const skills = [...new Set(resources.flatMap((resource) => resource.owners || []))];
  for (const skill of skills) {
    const lease = readLease(skill, sessionId, now, tempDir);
    if (!lease) continue;
    lease.touchedAt = now;
    fs.writeFileSync(leasePath(skill, sessionId, tempDir), JSON.stringify(lease), { mode: 0o600 });
  }
}

function activeOwner(resource, sessionId, now = Date.now(), tempDir = os.tmpdir()) {
  return (resource.owners || []).find((skill) => readLease(skill, sessionId, now, tempDir)) || null;
}

module.exports = {
  LEASE_MAX_MS,
  LEASE_TTL_MS,
  absolutePath,
  activeOwner,
  bashWritesPath,
  contains,
  leasePath,
  loadRegistry,
  matchedResource,
  readLease,
  renewLeases,
  writeLease,
};
