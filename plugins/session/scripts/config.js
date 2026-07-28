// Configuration loader.
//
// Defaults live here so the plugin works the moment it is installed. A user
// override at ~/.claude/session.config.json is merged over the top, one key at
// a time, so overriding one setting does not silently reset the others.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // Which connected tools to watch and show in the status line.
  //
  // Empty on purpose. This started as a hardcoded list of five services, which
  // is exactly the sort of thing that makes a public plugin useless to the
  // second person who installs it: their tools are not these tools, and there
  // is nothing they can do about it short of editing the source.
  //
  // Empty also means the segment stays off until someone opts in, so nobody
  // gets a status line cluttered with a tracker they never asked for. Run
  // /core-tools to pick from the servers actually connected on this machine.
  //
  // Each entry is:
  //   { "label": "Email", "match": "Gmail" }
  //
  // `match` is matched case-insensitively against the server name reported by
  // `claude mcp list`. It is a substring rather than an exact name because
  // those names carry a provider prefix that changes ("claude.ai Gmail"), and
  // pinning the full string would break the whole segment on a rename. `label`
  // is what appears when a tool needs attention, so it can be the short word
  // you actually call the thing.
  coreTools: [],

  // How old the health cache may get before it is refreshed, in minutes.
  //
  // The refresh shells out to `claude mcp list`, which genuinely contacts every
  // server and takes seconds. That is far too slow to run while a status line
  // renders, so it never does: the status line reads the cache, and the refresh
  // happens in the background at session start.
  healthMaxAgeMinutes: 30,

  // Show the health segment even when the cache is older than the age above.
  //
  // On by default, and marked as stale when it is. A count with no freshness is
  // a claim that everything was fine at a moment you cannot see, which is worse
  // than showing nothing. Hiding it entirely is the other reasonable choice and
  // is what setting this to false does.
  showStaleHealth: true,
};

function configPath(home = os.homedir()) {
  return path.join(home, '.claude', 'session.config.json');
}

function load(home = os.homedir()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  } catch (_) {
    // No config, or a config that will not parse. Either way the defaults are
    // a working plugin, and refusing to start over a malformed optional file
    // would be the wrong trade at session start.
    return { ...DEFAULTS };
  }
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };

  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined) merged[key] = raw[key];
  }

  // One bad entry should not take the segment down, so anything that is not a
  // usable pair is dropped rather than thrown.
  if (!Array.isArray(merged.coreTools)) merged.coreTools = [];
  merged.coreTools = merged.coreTools
    .filter((t) => t && typeof t === 'object' && (t.label || t.match))
    .map((t) => ({ label: String(t.label || t.match), match: String(t.match || t.label) }));

  return merged;
}

module.exports = { DEFAULTS, configPath, load };
