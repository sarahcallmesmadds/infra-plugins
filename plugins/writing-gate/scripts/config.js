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

function loadConfig() {
  const file = path.join(os.homedir(), '.claude', 'writing-gate.config.json');
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No file, unreadable, or invalid JSON. Defaults are a working setup, so
    // a broken override must never take the checks offline silently.
    return { ...DEFAULTS };
  }
  // Merged one key at a time, so setting one option does not reset the rest.
  return { ...DEFAULTS, ...user };
}

module.exports = { loadConfig, DEFAULTS };
