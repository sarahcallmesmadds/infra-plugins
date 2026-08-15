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
const isLegacyUnresolvedStatus = (status) => loose(status) === 'fixattemptedunresolved';
const expired = (deadline) => Date.now() >= deadline;

function jsonFiles(dir, deadline = Infinity) {
  if (expired(deadline)) return null;
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(dir, name));
    return expired(deadline) ? null : files;
  } catch (_) {
    return [];
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function entriesBeforeDeadline(dir, deadline) {
  const files = jsonFiles(dir, deadline);
  if (!files) return null;
  const entries = [];
  for (const file of files) {
    if (expired(deadline)) return null;
    entries.push(readJson(file));
  }
  return entries;
}

function queueLine(root, { deadline = Infinity } = {}) {
  const entries = entriesBeforeDeadline(path.join(root, 'queue'), deadline);
  if (!entries) return '';
  const active = entries
    .filter((entry) => entry && isActiveBuildStatus(entry.status));
  const legacy = entries
    .filter((entry) => entry && isLegacyUnresolvedStatus(entry.status));
  if (!active.length && !legacy.length) return '';

  const primary = active.filter((entry) => entry.type !== 'dep-review');
  const reviews = active.length - primary.length;
  const names = primary.slice(0, MAX_QUEUE_TITLES)
    .map((entry) => String(entry.target || entry.skill || entry.id || 'untitled').trim())
    .filter(Boolean);
  const more = primary.length > names.length ? `, +${primary.length - names.length} more` : '';
  const titleText = names.length ? `: ${names.join(', ')}${more}` : '';
  const legacyNames = legacy.slice(0, MAX_QUEUE_TITLES)
    .map((entry) => String(entry.target || entry.skill || entry.id || 'untitled').trim())
    .filter(Boolean);
  const legacyMore = legacy.length > legacyNames.length ? `, +${legacy.length - legacyNames.length} more` : '';

  const clauses = [];
  if (primary.length) clauses.push(`Bug queue: ${primary.length} active${titleText}.`);
  if (reviews) clauses.push(`Dependency reviews: ${reviews} active.`);
  if (legacy.length) {
    const legacyTitles = legacyNames.length ? `: ${legacyNames.join(', ')}${legacyMore}` : '';
    clauses.push(`Legacy unresolved queue entries: ${legacy.length}${legacyTitles}.`);
  }
  return clauses.join(' ');
}

function toBuildLine(root, { deadline = Infinity } = {}) {
  const read = entriesBeforeDeadline(path.join(root, 'to-build'), deadline);
  if (!read) return '';
  const entries = read
    .filter((entry) => entry && isActiveBuildStatus(entry.status));
  if (!entries.length) return '';
  const inProgress = entries.filter((entry) => loose(entry.status) === 'inprogress').length;
  return `To build: ${entries.length} active${inProgress ? ` (${inProgress} in progress)` : ''}.`;
}

function latestSummary(root, { now = Date.now(), deadline = Infinity } = {}) {
  if (expired(deadline)) return '';
  let files;
  try {
    files = fs.readdirSync(path.join(root, 'summaries'))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse();
  } catch (_) {
    return '';
  }
  if (!files.length || expired(deadline)) return '';

  const name = files[0];
  try {
    const file = path.join(root, 'summaries', name);
    if (now - fs.statSync(file).mtimeMs > SUMMARY_MAX_AGE_MS) return '';
    if (expired(deadline)) return '';
    const content = fs.readFileSync(file, 'utf8').trim();
    if (expired(deadline)) return '';
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
  if (expired(deadline)) return '';
  const deps = readJson(path.join(root, 'DEPS.json'));
  if (!deps) return '';
  const targets = deps.targets || deps.skills;
  if (!targets || typeof targets !== 'object') return '';

  // Only one question is asked here: is the file this entry points at still
  // there. A file that is gone is a fact, it is actionable in one command, and
  // it does not go away by itself.
  //
  // What this deliberately no longer counts is an entry whose file has been
  // edited since somebody last reviewed it. That was two thirds of the line's
  // output and none of its value. Measured on 2026-08-15: 82 of 127 entries,
  // and 0 gone. `last_updated` is a human review date that is never bumped by
  // machine, on purpose, so every reviewed-and-since-edited entry counted as
  // drift forever and the number only ever grew. A line that is always on tells
  // a reader nothing, and this one closed by telling them not to rely on a map
  // that was sound.
  //
  // That judgement has a home already. /audit-deps compares `last_updated`
  // against the file's modification time to decide an entry's edges want
  // re-inferring, which is the same measurement made where somebody can act on
  // it, one entry at a time, having asked for it.
  let gone = 0;
  let incomplete = false;
  let examined = 0;
  for (const target of Object.values(targets)) {
    if (expired(deadline)) {
      incomplete = true;
      break;
    }
    if (!target || typeof target !== 'object') continue;
    const targetPath = expandHome(target.path, home);
    if (!targetPath) continue;
    examined += 1;
    try { fs.statSync(targetPath); }
    catch (_) { gone += 1; }
  }

  // A scan cut short cannot say "nothing is gone", so it says what it managed
  // instead of staying quiet. Silence here has to mean the whole map was read
  // and every file was there.
  const cutShort = incomplete && examined
    ? ` Checked ${examined} of them before running out of time, so there may be more.`
    : '';

  if (gone) {
    return gone === 1
      ? `Dependency map: 1 entry points at a file that is gone. Run /audit-deps to drop it.${cutShort}`
      : `Dependency map: ${gone} entries point at files that are gone. Run /audit-deps to drop them.${cutShort}`;
  }
  if (incomplete && examined) {
    return `Dependency map: read ${examined} entr${examined === 1 ? 'y' : 'ies'} before running out of time, so nothing is confirmed either way.`;
  }
  return '';
}

function buildBrief({ home = os.homedir(), deadline = Infinity, includeSummary = true, now = Date.now() } = {}) {
  const root = path.join(home, '.claude', 'build-loop');
  const lines = [
    queueLine(root, { deadline }),
    toBuildLine(root, { deadline }),
    depsLine(root, { home, deadline }),
    includeSummary ? latestSummary(root, { now, deadline }) : '',
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
  isLegacyUnresolvedStatus,
  joinContext,
  latestSummary,
  queueLine,
  toBuildLine,
};
