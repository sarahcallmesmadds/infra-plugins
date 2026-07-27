// Defaults live here so the plugin works the moment it is installed. The
// config file is only ever for overrides, and not having one is normal.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  // The two hard rules. Both enforced by the Stop hook.
  allowEmDash: false,
  choppyRunLimit: 3,
  // Turn the hook off without uninstalling, when drafting something that
  // genuinely needs the forbidden shapes.
  enforce: true,
};

// The plugin was called writing-gate until 2026-07-27, so a config written
// before the rename sits at the old path. Reading both means a rename does not
// quietly switch someone's settings back to the defaults, which is the failure
// mode here: `enforce: false` becoming `enforce: true` again turns the hook
// back on for a person who deliberately turned it off, and nothing says so.
//
// New path wins when both exist. The old one is never written to and never
// deleted; it is the user's file, not this plugin's.
const CONFIG_PATHS = ['slop-check.config.json', 'writing-gate.config.json'];

function readFirstConfig() {
  for (const name of CONFIG_PATHS) {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', name), 'utf8'));
    } catch {
      // Missing, unreadable, or invalid JSON. Try the next one.
    }
  }
  return null;
}

function loadConfig() {
  const user = readFirstConfig();

  // No file, unreadable, or invalid JSON. Defaults are a working setup, so a
  // broken override must never take the checks offline silently.
  //
  // The array check matters: JSON.parse succeeds on `[1,2]` and on `"text"`,
  // and spreading either produces an object with numeric keys rather than
  // failing. That would read as a config with no recognised settings, which is
  // indistinguishable from an empty one, so a malformed file would look like it
  // was applied.
  if (user === null || typeof user !== 'object' || Array.isArray(user)) {
    return { ...DEFAULTS };
  }

  // Merged one key at a time, so setting one option does not reset the rest.
  return { ...DEFAULTS, ...user };
}

module.exports = { loadConfig, DEFAULTS };
