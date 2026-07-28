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

function cachePath(home = os.homedir()) {
  return path.join(home, '.cache', 'session', 'mcp-health.json');
}

// One line of `claude mcp list` output. The shape is:
//
//   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
//   claude.ai Mercury: https://mcp.mercury.com/mcp - ! Needs authentication
//
// Parsed with a regex rather than by splitting, because the server name may
// contain both spaces and a dot, the URL contains colons and slashes, and the
// status text contains a space. Splitting on any single one of those gets a
// different set of lines wrong.
const LINE_RE = /^(.+?):\s+(\S+)\s+-\s+(.+)$/;

function classifyStatus(text) {
  const t = String(text).toLowerCase();
  if (t.includes('connected')) return 'connected';
  if (t.includes('auth')) return 'needs_auth';
  // Anything else is a server that answered badly or not at all. Deliberately
  // not folded into needs_auth: the fix for one is signing in and the fix for
  // the other is not, so telling someone to re-authenticate a server that is
  // simply down sends them somewhere useless.
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
    const [, name, url, statusText] = m;
    if (!/^https?:\/\//.test(url) && !url.includes('/')) continue;
    servers.push({
      name: name.trim(),
      url,
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

  const problems = s.tools.filter((t) => t.status !== 'connected');
  const code = problems.some((t) => t.status === 'needs_auth' || t.status === 'down') ? 31
    : problems.length ? 33 : 32;

  let text = `Core tools ${s.connected}/${s.total}`;
  if (problems.length) {
    const needsAuth = problems.filter((t) => t.status === 'needs_auth').map((t) => t.label);
    const other = problems.filter((t) => t.status !== 'needs_auth').map((t) => t.label);
    const bits = [];
    if (needsAuth.length) bits.push(`${needsAuth.join(', ')} needs sign-in`);
    if (other.length) bits.push(`${other.join(', ')} unreachable`);
    text += ` (${bits.join('; ')})`;
  }
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
  parseMcpList,
  classifyStatus,
  probe,
  readCache,
  writeCache,
  cacheAgeMinutes,
  isStale,
  refresh,
  resolve,
  summarize,
  statuslineSegment,
  formatAge,
  LINE_RE,
};
