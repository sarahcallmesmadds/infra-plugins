#!/usr/bin/env node
// Read the build-loop plugin's user state without depending on its code.
//
// Session is a standalone plugin. Importing a sibling plugin would make this
// feature work in this repository and fail for somebody who installed session
// by itself. The files are the interface here: absent, old or malformed state
// makes the brief omit that section rather than breaking session start.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTEXT_LIMIT = 10000;
const SUMMARY_LIMIT = 2000;
const SUMMARY_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_TITLES = 5;

const loose = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const isActiveBuildStatus = (status) => ['open', 'inprogress'].includes(loose(status));

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function queueLine(root) {
  const active = jsonFiles(path.join(root, 'queue'))
    .map(readJson)
    .filter((entry) => entry && isActiveBuildStatus(entry.status));
  if (!active.length) return '';

  const primary = active.filter((entry) => entry.type !== 'dep-review');
  const reviews = active.length - primary.length;
  const names = primary.slice(0, MAX_QUEUE_TITLES)
    .map((entry) => String(entry.target || entry.skill || entry.id || 'untitled').trim())
    .filter(Boolean);
  const more = primary.length > names.length ? `, +${primary.length - names.length} more` : '';
  const reviewText = reviews ? `; ${reviews} dependency review${reviews === 1 ? '' : 's'}` : '';
  const titleText = names.length ? `: ${names.join(', ')}${more}` : '';
  return `Bug queue: ${primary.length} active${titleText}${reviewText}.`;
}

function toBuildLine(root) {
  const entries = jsonFiles(path.join(root, 'to-build'))
    .map(readJson)
    .filter((entry) => entry && isActiveBuildStatus(entry.status));
  if (!entries.length) return '';
  const inProgress = entries.filter((entry) => loose(entry.status) === 'inprogress').length;
  return `To build: ${entries.length} active${inProgress ? ` (${inProgress} in progress)` : ''}.`;
}

function latestSummary(root, { now = Date.now() } = {}) {
  let files;
  try {
    files = fs.readdirSync(path.join(root, 'summaries'))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse();
  } catch (_) {
    return '';
  }
  if (!files.length) return '';

  const name = files[0];
  try {
    const file = path.join(root, 'summaries', name);
    if (now - fs.statSync(file).mtimeMs > SUMMARY_MAX_AGE_MS) return '';
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return '';
    const clipped = content.length > SUMMARY_LIMIT
      ? `${content.slice(0, SUMMARY_LIMIT - 1).trimEnd()}\u2026`
      : content;
    return `Latest weekly summary (${name}):\n${clipped}`;
  } catch (_) {
    return '';
  }
}

function expandHome(value, home) {
  if (typeof value !== 'string' || !value) return null;
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function depsLine(root, { home, deadline = Infinity } = {}) {
  const deps = readJson(path.join(root, 'DEPS.json'));
  if (!deps || !deps.targets || typeof deps.targets !== 'object') return '';

  let missing = 0;
  let changed = 0;
  let incomplete = false;
  for (const target of Object.values(deps.targets)) {
    if (Date.now() >= deadline) {
      incomplete = true;
      break;
    }
    if (!target || typeof target !== 'object') continue;
    const targetPath = expandHome(target.path, home);
    if (!targetPath) continue;
    let stat;
    try { stat = fs.statSync(targetPath); }
    catch (_) { missing += 1; continue; }
    const recorded = Date.parse(target.last_updated || '');
    if (Number.isFinite(recorded) && stat.mtimeMs > recorded) changed += 1;
  }

  if (!missing && !changed && !incomplete) return '';
  const bits = [];
  if (missing) bits.push(`${missing} missing`);
  if (changed) bits.push(`${changed} changed`);
  if (incomplete) bits.push('check incomplete');
  return `DEPS.json drift warning: ${bits.join(', ')}. Review it before relying on it.`;
}

function buildBrief({ home = os.homedir(), deadline = Infinity, includeSummary = true, now = Date.now() } = {}) {
  const root = path.join(home, '.claude', 'build-loop');
  const lines = [
    queueLine(root),
    toBuildLine(root),
    depsLine(root, { home, deadline }),
    includeSummary ? latestSummary(root, { now }) : '',
  ]
    .filter(Boolean);
  return lines.length ? `Build-loop brief:\n${lines.join('\n')}` : '';
}

function joinContext(parts, limit = CONTEXT_LIMIT) {
  const joined = parts.filter(Boolean).join('\n\n');
  if (joined.length <= limit) return joined;
  if (limit <= 1) return joined.slice(0, limit);
  return `${joined.slice(0, limit - 1).trimEnd()}\u2026`;
}

module.exports = {
  CONTEXT_LIMIT,
  SUMMARY_MAX_AGE_MS,
  SUMMARY_LIMIT,
  buildBrief,
  depsLine,
  isActiveBuildStatus,
  joinContext,
  latestSummary,
  queueLine,
  toBuildLine,
};
