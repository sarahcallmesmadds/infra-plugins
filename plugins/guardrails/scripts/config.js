// Configuration loader.
//
// Defaults live here so the plugin works the moment it is installed. A user
// override at ~/.claude/guardrails.config.json is merged over the top, one key
// at a time, so overriding one setting does not silently reset the others.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // Branches that should never receive a direct commit.
  protectedBranches: ['main', 'master'],

  // Block `git commit` while on a protected branch. Applies in every repository.
  blockCommitToProtectedBranch: true,

  // Require Conventional Commits format (feat:, fix:, docs: …). Off by default,
  // because plenty of repositories reasonably do not use it.
  requireConventionalCommits: false,

  // Block `rm -rf` outside known-disposable paths.
  blockDestructiveCommands: true,

  // Paths where recursive force-delete is routine and does not need a prompt.
  //
  // `/private/tmp/` is the same directory as `/tmp/` on macOS, where `/tmp` is a
  // symlink. Matching here is done on the path as it was typed, because the
  // target of a delete often does not exist yet or is about to stop existing,
  // so there is nothing reliable to resolve. That means the same directory got
  // two different verdicts depending on how it was spelled, and tools that
  // report a real path rather than the symlink hit the blocked spelling every
  // time. Listing both is the honest fix and widens nothing: it is one
  // directory that was already trusted under its other name.
  //
  // Still not covered: `os.tmpdir()`, which is a per-user path under
  // /var/folders on macOS. It cannot be hardcoded here because it differs per
  // machine, so it needs a config entry.
  safeDeletePaths: [
    '/tmp/',
    '/private/tmp/',
    'node_modules',
    '.git/objects/pack',
    '/dist/',
    '/build/',
    '/coverage/',
    '.DS_Store',
    '__pycache__',
    '.pytest_cache',
  ],

  // Scan content read from disk and the web for prompt-injection patterns.
  scanForInjection: true,

  // Extra path patterns (regex strings) to exclude from injection scanning,
  // on top of the built-in exclusions for security docs and planning files.
  injectionExcludePaths: [],
};

function loadConfig() {
  const configPath = path.join(os.homedir(), '.claude', 'guardrails.config.json');
  let userConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (_) {
    // A malformed config must not take the guards offline. Fall back to defaults.
    userConfig = {};
  }
  return { ...DEFAULTS, ...userConfig };
}

module.exports = { loadConfig, DEFAULTS };
