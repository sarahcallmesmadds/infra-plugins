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
  // Phrases ruled out for this author, enforced the same way. The built-in
  // list is in patterns.js as HOUSE_RULES; anything here is added to it.
  // Set houseRules to false to turn the whole check off.
  houseRules: true,
  bannedPhrases: [],
  // Turn the hook off without uninstalling, when drafting something that
  // genuinely needs the forbidden shapes.
  enforce: true,
};

const CONFIG_PATH = 'slop-check.config.json';

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', CONFIG_PATH), 'utf8'));
  } catch {
    // Missing, unreadable, or invalid JSON. Defaults handle all three.
    return null;
  }
}

function loadConfig() {
  const user = readUserConfig();

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
