'use strict';

// Reads the one worktree setting every part of Git Hygiene shares:
// `worktreeLocation` in ~/.claude/git-hygiene.config.json, written by
// /git-hygiene:setup and enforced by the worktree-location guard. The lifecycle
// engine must not keep a second schema. When it did, setup wrote one shape, the
// guard enforced another and the cleanup audit read a third, so a layout the
// guard required could be rejected by the audit as invalid.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWithin, resolveRoots } = require('./worktree-location');

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'git-hygiene.config.json');

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (typeof value === 'string' && (value.startsWith('~/') || value.startsWith(`~${path.sep}`))) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function contains(parent, child) {
  return isWithin(child, parent);
}

// `exists` means worktreeLocation is set, not merely that the file exists: the
// same file also holds branch settings, and those alone must not switch on the
// worktree audit or its session notice.
function loadConfig() {
  const base = { exists: false, valid: true, errors: [], file: CONFIG_FILE, projectRoots: [], worktreeRoot: null };
  let raw;
  try { raw = fs.readFileSync(CONFIG_FILE, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return base;
    // Fixed wording: Node's message is not ours to print.
    return { ...base, exists: true, valid: false, errors: [`configuration could not be read (${error.code || 'error'})`] };
  }
  let section;
  try {
    const parsed = JSON.parse(raw);
    section = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.worktreeLocation : undefined;
  } catch (error) {
    // A JSON parse error quotes part of the file; say where to look instead.
    return { ...base, exists: true, valid: false, errors: [`configuration is not valid JSON: ${CONFIG_FILE}`] };
  }
  if (section === undefined) return base;
  try {
    const roots = resolveRoots(section && section.projectRoot, section && section.worktreeRoot);
    return { ...base, exists: true, projectRoots: [roots.projectRoot], worktreeRoot: roots.worktreeRoot };
  } catch (_) {
    // The check's own message quotes the configured value, which may be any
    // text typed into the file, and the audit prints these errors. The audit
    // already points at /git-hygiene:setup, which explains what is wrong.
    return { ...base, exists: true, valid: false, errors: [`worktreeLocation in ${CONFIG_FILE} is not valid`] };
  }
}

module.exports = { CONFIG_FILE, contains, expandHome, loadConfig };
