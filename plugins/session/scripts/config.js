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

  // Warn the model when its own context is filling up.
  //
  // Only works when the status line is installed, because the status line is
  // the only component Claude Code hands the context window to. Without it the
  // bridge file is never written and this stays silent, which is the correct
  // behaviour: a warning invented from no reading would be worse than none.
  //
  // `enabled: false` switches it off. The thresholds are remaining percentages,
  // not used, so they count down.
  contextWarnings: {},

  // Report uncommitted work and recent commits at session start.
  //
  // Complements the live session check rather than duplicating it. That one
  // reads the process table and answers "is anyone in here now". This one
  // answers "was anyone in here, and did they leave something", which is the
  // case a window closed ten minutes ago produces.
  //
  // `roots` are searched for repositories, `~` expanded. Discovery rather than
  // a hand-written list on purpose: the hook this ports from held six absolute
  // paths from another machine, so anywhere else it checked six directories
  // that did not exist and reported nothing, which is indistinguishable from
  // all clear.
  //
  // Off until asked for, which is the one default in this file that is not
  // about cost.
  //
  // It is 86ms and bounded at 12 repositories, depth 2 and 400ms per git call.
  // Speed was never the question. The question is that installing a plugin
  // about sessions and handoffs would also start walking a directory of your
  // unrelated work and spawning git processes, every session, on a machine
  // where somebody installed something rather than wrote it. Nothing in the
  // name would lead them to expect that.
  //
  // The line this sits on: the parallel-session check reads the process table
  // by default and stays that way, because it is the plugin looking at Claude
  // Code sessions, which is its own subject. This one reads your work. One is
  // the plugin looking at itself, the other is the plugin looking at you, and
  // only the second needs asking.
  //
  // The cost of this default is real and falls on the people it was built for.
  // Somebody who reads the README and turns it on is largely somebody who did
  // not leave uncommitted work behind. That is accepted rather than solved.
  //
  // `load` replaces whole keys rather than merging into them, so a config
  // saying `{"gitActivity": {"roots": ["~/code"]}}` drops this `enabled: false`
  // and the scan runs. That is deliberate: configuring the thing is asking for
  // it, and the alternative is a config that is read, accepted, and silently
  // does nothing. If `load` ever starts deep merging, that stops being true,
  // and there is a test pinning it so the change cannot be quiet.
  gitActivity: { enabled: false },

  // Word budgets for the memory directory, checked by /wrap.
  //
  // Overrides merge one key at a time, so raising the total does not silently
  // reset the per-file limits. Empty here means the defaults in memory.js
  // apply, which is the common case.
  //
  // The live and durable limits differ on purpose. A `project` file is live
  // state, meant to be replaced rather than grown, so a long one means nothing
  // has been taken out since it was written. A `reference` file accumulates
  // slowly and legitimately, and holding both to one number would either nag
  // about a good reference file or stay quiet while a status document turns
  // into a session log.
  memoryBudget: {},

  // Where repositories live, for finding a project handoff by name.
  //
  // A project handoff sits next to the work, so reconstructing its path from a
  // slug means knowing the parent directory. `~/Projects` was hardcoded, which
  // is the same mistake `coreTools` above was written to avoid: it worked for
  // one person's layout and silently found nothing for everyone else's.
  //
  // This is not a licence to guess more directories. The index remains the only
  // authority on where a handoff actually went, because the writer is the only
  // thing that ever knew. This list exists so someone whose code lives in
  // `~/src` is not stuck with a lookup that cannot reach it, and so a repo moved
  // between two configured roots is still findable by name.
  //
  // A leading `~/` is expanded. Entries that are not usable strings are dropped,
  // and an empty list falls back to `~/Projects` rather than searching nothing.
  projectRoots: ['~/Projects'],

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

  // Same rule for roots: drop what cannot be used, and never end up with an
  // empty list, because searching nowhere finds nothing and looks identical to
  // a handoff that does not exist.
  if (!Array.isArray(merged.projectRoots)) merged.projectRoots = DEFAULTS.projectRoots;
  merged.projectRoots = merged.projectRoots
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim());
  if (!merged.projectRoots.length) merged.projectRoots = [...DEFAULTS.projectRoots];

  return merged;
}

module.exports = { DEFAULTS, configPath, load };
