// Are the tools you depend on still authenticated.
//
// ---------------------------------------------------------------------------
// The bug this file exists to fix.
//
// The original core-tools indicator was a reader with no writer. It loaded a
// "last known good" cache from ~/.cache/ai-core-mcp-health.json and formatted
// whatever it found. Nothing on any machine ever wrote that file. It did not
// exist, and the statusline branch of the formatter returns an empty string
// when the cache is missing, so the segment simply never appeared and never
// said why.
//
// That is the same failure as the injection scanner that reported every file
// clean because it was reading an empty string: a component that looks correct
// line by line, produces no error, and has never once done its job. A reader is
// not a monitor. The writer is the monitor.
//
// ---------------------------------------------------------------------------
// Why the refresh is not on the render path.
//
// `claude mcp list` really does contact every configured server, so it takes
// seconds. A status line renders constantly and must be effectively free, so
// probing there would make the prompt unusable. The split is:
//
//   refresh   background, at session start, only when the cache is stale
//   render    reads the cache, never probes, never blocks
//
// The cost of that split is that the number on screen is as old as the cache,
// which is why age is tracked and shown rather than quietly dropped.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROBE_TIMEOUT_MS = 25000;
const INCIDENT_SOURCE_ID = 'session:core-tools';
const INCIDENT_LOCK_STALE_MS = 2 * 60 * 1000;

function cachePath(home = os.homedir()) {
  return path.join(home, '.cache', 'session', 'mcp-health.json');
}

function incidentPath(home = os.homedir()) {
  return path.join(home, '.cache', 'session', 'core-tools-incident.json');
}

function incidentLockPath(home = os.homedir()) {
  return `${incidentPath(home)}.lock`;
}

// One line of `claude mcp list` output. The shape is `name: target - status`:
//
//   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
//   claude.ai Mercury: https://mcp.mercury.com/mcp - ! Needs authentication
//   demo-stdio: node /path/to/server.js - ✘ Failed to connect
//   bare-cmd: node - ✘ Failed to connect
//
// Parsed with a regex rather than by splitting, because the name may contain
// spaces and a dot, a URL target contains colons and slashes, a command target
// contains spaces and may contain neither, and the status text contains spaces
// too. Every single-character split gets some row wrong.
//
// The third and fourth rows above are why the target is `(.+?)` and why there
// is no check that it looks like a URL. An earlier version captured `(\S+)`
// and additionally required the target to be a URL or at least contain a
// slash, which dropped every locally-run server on the floor: one because its
// command had a space in it, the other because `node` has neither. They did
// not appear as broken, they did not appear at all, so a coreTools entry
// pointing at one was reported as a name matching nothing.
const LINE_RE = /^(.+?):\s+(.+?)\s+-\s+(\S.*)$/;

// Failure words are checked first, and the order is the whole point.
//
// "Disconnected" contains "connected". A version of this that asked about
// "connected" first classified a dead server as healthy, which is the single
// worst answer available here: the segment exists to notice exactly that, and
// it would have shown green.
function classifyStatus(text) {
  const t = String(text).toLowerCase();
  if (/fail|error|refused|timed out|timeout|disconnect|unreachable|closed/.test(t)) return 'down';
  if (t.includes('auth')) return 'needs_auth';
  if (t.includes('connected')) return 'connected';
  // Anything unrecognised is treated as a server that answered badly.
  // Deliberately not folded into needs_auth: the fix for one is signing in and
  // the fix for the other is not, so telling someone to re-authenticate a
  // server that is simply down sends them somewhere useless.
  return 'down';
}

function parseMcpList(text) {
  if (!text) return [];
  const servers = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // The header line has no URL and must not become a server named "Checking
    // MCP server health…".
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, name, target, statusText] = m;
    servers.push({
      name: name.trim(),
      // A URL for a remote server, a command for a local one. Kept under the
      // same key because nothing downstream cares which it is, and renaming it
      // per row would push that distinction onto every reader.
      url: target.trim(),
      status: classifyStatus(statusText),
      statusText: statusText.trim(),
    });
  }
  return servers;
}

// Ask Claude Code what it can currently reach. Returns null when we cannot ask,
// which is different from an empty list and must not be written to the cache as
// one. An empty list means "you have no servers"; null means "we did not find
// out", and overwriting a good cache with the second is how a monitor starts
// lying.
function probe({ exec = execFileSync } = {}) {
  try {
    const out = exec('claude', ['mcp', 'list'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const servers = parseMcpList(out);
    return servers.length ? servers : null;
  } catch (_) {
    return null;
  }
}

function readCache(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(home), 'utf8'));
    return raw && Array.isArray(raw.servers) ? raw : null;
  } catch (_) {
    return null;
  }
}

function writeCache(servers, { home = os.homedir(), now = Date.now() } = {}) {
  const payload = { version: 1, updated_at: new Date(now).toISOString(), servers };
  const target = cachePath(home);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written to a temporary name and renamed, so a status line reading the
    // cache at the moment of a refresh sees the old file or the new one and
    // never a half-written one.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return payload;
  } catch (_) {
    return null;
  }
}

function readIncident(home = os.homedir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(incidentPath(home), 'utf8'));
    return raw && raw.version === 1 && raw.incident && typeof raw.incident === 'object'
      ? raw
      : { version: 1, incident: null };
  } catch (_) {
    return { version: 1, incident: null };
  }
}

function writeIncident(state, { home = os.homedir() } = {}) {
  const target = incidentPath(home);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, target);
    return state;
  } catch (_) {
    return null;
  }
}

function acquireIncidentLock(home = os.homedir(), now = Date.now()) {
  const lock = incidentLockPath(home);
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.mkdirSync(lock);
    return { status: 'acquired', path: lock };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return { status: 'error', path: null };
    try {
      if (now - fs.statSync(lock).mtimeMs <= INCIDENT_LOCK_STALE_MS) {
        return { status: 'busy', path: null };
      }
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      return { status: 'acquired', path: lock };
    } catch (_) {
      return { status: 'error', path: null };
    }
  }
}

function releaseIncidentLock(lock) {
  if (!lock) return;
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function cacheAgeMinutes(cache, now = Date.now()) {
  if (!cache || !cache.updated_at) return null;
  const t = Date.parse(cache.updated_at);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

function isStale(cache, maxAgeMinutes, now = Date.now()) {
  const age = cacheAgeMinutes(cache, now);
  return age == null || age >= maxAgeMinutes;
}

function refresh({ home = os.homedir(), now = Date.now(), exec } = {}) {
  const servers = probe({ exec });
  if (!servers) return null;
  return writeCache(servers, { home, now });
}

function problemFingerprint(problems) {
  return problems
    .map((problem) => `${problem.label}:${problem.status}`)
    .sort()
    .join('|');
}

function formatProblem(problem) {
  if (problem.status === 'needs_auth') return `${problem.label} needs sign-in`;
  if (problem.status === 'down') return `${problem.label} is unreachable`;
  if (problem.status === 'missing') return `${problem.label} is not found; check its configured name`;
  return 'the health check could not run';
}

function scheduledProbe({ config, home = os.homedir(), now = Date.now(), exec } = {}) {
  const tools = (config && config.coreTools) || [];
  if (!tools.length) return { event: 'unconfigured', message: '', incident: null };

  const lock = acquireIncidentLock(home, now);
  if (lock.status === 'busy') {
    return { event: 'busy', message: '', incident: readIncident(home).incident };
  }
  if (lock.status === 'error') {
    return {
      event: 'lock_failed',
      message: 'Core tools monitor error: the coordination lock could not be created; check ~/.cache/session permissions.',
      incident: readIncident(home).incident,
    };
  }

  try {
    const state = readIncident(home);
    const previous = state.incident;
    const servers = probe({ exec });
    let problems;
    if (servers) {
      writeCache(servers, { home, now });
      problems = resolve(tools, servers).filter((tool) => tool.status !== 'connected');
    } else if (previous && previous.status === 'open') {
      return { event: 'probe_failed', message: '', incident: previous };
    } else {
      problems = [{ label: 'Core tools probe', match: '', server: null, status: 'probe_failed' }];
    }

    const nowIso = new Date(now).toISOString();

    if (!problems.length) {
      if (!previous || previous.status !== 'open') {
        return { event: 'unchanged', message: '', incident: previous || null };
      }
      const incident = {
        ...previous,
        status: 'resolved',
        updated_at: nowIso,
        resolved_at: nowIso,
        fingerprint: '',
        problems: [],
      };
      if (!writeIncident({ version: 1, incident }, { home })) {
        return {
          event: 'write_failed',
          message: 'Core tools monitor error: recovery was detected but the incident record could not be updated.',
          incident: previous,
        };
      }
      return {
        event: 'resolved',
        message: `Core tools recovered: all ${tools.length} connected. Closed ${INCIDENT_SOURCE_ID}.`,
        incident,
      };
    }

    const fingerprint = problemFingerprint(problems);
    if (previous && previous.status === 'open' && previous.fingerprint === fingerprint) {
      return { event: 'unchanged', message: '', incident: previous };
    }

    const reopening = previous && previous.status === 'resolved';
    const updating = previous && previous.status === 'open';
    const incident = {
      source_id: INCIDENT_SOURCE_ID,
      status: 'open',
      opened_at: updating ? previous.opened_at : nowIso,
      updated_at: nowIso,
      resolved_at: null,
      occurrence: reopening ? (previous.occurrence || 1) + 1 : (previous?.occurrence || 1),
      fingerprint,
      problems,
    };
    if (!writeIncident({ version: 1, incident }, { home })) {
      const detail = problems.map(formatProblem).join('; ');
      return {
        event: 'write_failed',
        message: `Core tools monitor error: ${detail}, but the incident could not be recorded; this alert may repeat.`,
        incident: previous || null,
      };
    }
    const detail = problems.map(formatProblem).join('; ');
    return {
      event: updating ? 'updated' : 'opened',
      message: `Core tools alert${updating ? ' updated' : ''}: ${detail}. Source ${INCIDENT_SOURCE_ID}.`,
      incident,
    };
  } finally {
    releaseIncidentLock(lock.path);
  }
}

// Match the configured tools against what the cache saw.
//
// A configured tool that matches no server is 'missing', not 'down'. They look
// the same on a status line and are completely different problems: one is a
// server that stopped working, the other is a name in your config that no
// longer refers to anything, usually because the server was renamed. Reporting
// a rename as an outage sends you to check a service that is fine.
function resolve(coreTools, servers) {
  return coreTools.map((tool) => {
    const needle = tool.match.toLowerCase();
    const hit = (servers || []).find((s) => s.name.toLowerCase().includes(needle));
    return {
      label: tool.label,
      match: tool.match,
      server: hit ? hit.name : null,
      status: hit ? hit.status : 'missing',
    };
  });
}

function summarize({ config, home = os.homedir(), now = Date.now() } = {}) {
  const tools = (config && config.coreTools) || [];
  if (!tools.length) return null;

  const cache = readCache(home);
  if (!cache) return { tools: resolve(tools, []), total: tools.length, connected: 0, ageMinutes: null, noCache: true };

  const rows = resolve(tools, cache.servers);
  return {
    tools: rows,
    total: rows.length,
    connected: rows.filter((r) => r.status === 'connected').length,
    ageMinutes: cacheAgeMinutes(cache, now),
    noCache: false,
  };
}

// The status line segment, or '' when there is nothing honest to show.
function statuslineSegment({ config, home = os.homedir(), now = Date.now(), color = true } = {}) {
  const s = summarize({ config, home, now });
  if (!s) return '';

  // No cache yet means the background refresh has not completed once. Saying
  // "0/5" here would read as five broken tools, which is a far more alarming
  // and entirely invented claim.
  if (s.noCache) return '';

  const stale = s.ageMinutes != null && s.ageMinutes >= (config.healthMaxAgeMinutes || 30) * 2;
  if (stale && !config.showStaleHealth) return '';

  // Three buckets, not two, because there are three different things to go and
  // do about them.
  //
  // `resolve` above is careful to separate a server that is down from a config
  // entry that matches nothing, and says why in its own comment. An earlier
  // version of this function then threw that away: it split on needs_auth and
  // swept everything else into one bucket labelled "unreachable", so a typo in
  // the config was reported as an outage and sent you to check a service that
  // was working perfectly.
  //
  // Worth recording how that survived. The distinction was correct in the data,
  // there was a passing test pinning it, and the comment explaining it was
  // right there. All of that was one layer upstream of the sentence anyone
  // actually reads. Fixing a thing and writing down why the rest is fine is not
  // the same as checking that the rest is fine.
  const label = (t) => t.label;
  const needsAuth = s.tools.filter((t) => t.status === 'needs_auth').map(label);
  const down = s.tools.filter((t) => t.status === 'down').map(label);
  const missing = s.tools.filter((t) => t.status === 'missing').map(label);

  // A missing entry is a config problem and nothing is broken, so it does not
  // get the colour that means "something is wrong with your tools".
  const code = (needsAuth.length || down.length) ? 31 : missing.length ? 33 : 32;

  let text = `Core tools ${s.connected}/${s.total}`;
  const bits = [];
  if (needsAuth.length) bits.push(`${needsAuth.join(', ')} needs sign-in`);
  if (down.length) bits.push(`${down.join(', ')} unreachable`);
  if (missing.length) bits.push(`${missing.join(', ')} not found, check the name`);
  if (bits.length) text += ` (${bits.join('; ')})`;
  if (stale) text += ` · ${formatAge(s.ageMinutes)} old`;

  const body = color ? `\x1b[${code}m${text}\x1b[0m` : text;
  return ` │ ${body}`;
}

function formatAge(minutes) {
  if (minutes == null) return 'unknown age';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

module.exports = {
  cachePath,
  incidentPath,
  incidentLockPath,
  parseMcpList,
  classifyStatus,
  probe,
  readCache,
  writeCache,
  readIncident,
  writeIncident,
  acquireIncidentLock,
  releaseIncidentLock,
  cacheAgeMinutes,
  isStale,
  refresh,
  problemFingerprint,
  formatProblem,
  scheduledProbe,
  resolve,
  summarize,
  statuslineSegment,
  formatAge,
  LINE_RE,
  INCIDENT_SOURCE_ID,
  INCIDENT_LOCK_STALE_MS,
};
