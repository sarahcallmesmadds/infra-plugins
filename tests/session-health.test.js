#!/usr/bin/env node
// Regression tests for the connected tool health tracker.
//
// Run: node tests/session-health.test.js
//
// This component shipped once already as a reader with no writer. It loaded a
// cache nobody ever wrote, formatted the nothing it found, and returned an
// empty string on every render since the day it shipped. It looked switched
// off rather than broken, which is why it survived so long.
//
// So the tests here are weighted toward the states that produce silence, and
// toward the difference between "everything is fine" and "we did not find out".
// Those two look identical on a status line and are not the same answer.
//
// The `claude mcp list` sample is synthetic but preserves the output shapes,
// including two servers that need authentication.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const health = require(path.join(ROOT, 'scripts', 'mcp-health.js'));
const config = require(path.join(ROOT, 'scripts', 'config.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const MCP_LIST_SAMPLE = [
  'Checking MCP server health…',
  '',
  'claude.ai Intuit QuickBooks: https://ledger.example.test/v1/mcp - ✔ Connected',
  'claude.ai Mercury: https://bank.example.test/mcp - ! Needs authentication',
  'claude.ai Microsoft 365: https://suite.example.test/mcp - ✔ Connected',
  'claude.ai n8n: https://workflow.example.test/mcp-server/http - ! Needs authentication',
  'claude.ai Google Calendar: https://calendar.example.test/mcp/v1 - ✔ Connected',
  'claude.ai Gmail: https://mail.example.test/mcp/v1 - ✔ Connected',
  'claude.ai Notion: https://notes.example.test/mcp - ✔ Connected',
].join('\n');

// ---------------------------------------------------------------- parsing ----

check('parses representative `claude mcp list` output', () => {
  const servers = health.parseMcpList(MCP_LIST_SAMPLE);
  assert.strictEqual(servers.length, 7, `got ${servers.length}`);
});

check('the "Checking MCP server health" header is not a server', () => {
  const servers = health.parseMcpList(MCP_LIST_SAMPLE);
  assert.ok(!servers.some((s) => /Checking/.test(s.name)), 'header parsed as a server');
});

check('a server name containing a dot and a space survives intact', () => {
  // "claude.ai Intuit QuickBooks" breaks anything that splits on a dot, a
  // space, or the first colon.
  const servers = health.parseMcpList(MCP_LIST_SAMPLE);
  assert.ok(servers.some((s) => s.name === 'claude.ai Intuit QuickBooks'));
});

check('the URL is not truncated at its own colon', () => {
  const servers = health.parseMcpList(MCP_LIST_SAMPLE);
  const gmail = servers.find((s) => s.name.includes('Gmail'));
  assert.strictEqual(gmail.url, 'https://mail.example.test/mcp/v1');
});

check('needs-authentication is distinguished from unreachable', () => {
  // The fix for one is signing in and the fix for the other is not. Folding
  // them together sends someone to re-authenticate a service that is simply
  // down.
  assert.strictEqual(health.classifyStatus('✔ Connected'), 'connected');
  assert.strictEqual(health.classifyStatus('! Needs authentication'), 'needs_auth');
  assert.strictEqual(health.classifyStatus('✗ Failed to connect'), 'down');
});

// Local (stdio) servers are reported with a command where a remote one has a
// URL. Both real lines below were captured from `claude mcp list` after adding
// two throwaway stdio servers.
//
// The previous parser dropped both: it captured the target as `(\S+)` so a
// command containing a space did not match, and it additionally required the
// target to look like a URL, which `node` does not. They did not show as
// broken, they did not show at all, so a coreTools entry pointing at one was
// reported as a name matching nothing.

const REAL_STDIO = [
  'demo-stdio: node /tmp/nonexistent-server.js - \u2718 Failed to connect \u2014 -32000: MCP error -32000: Connection closed',
  'bare-cmd: node  - \u2718 Failed to connect \u2014 MCP server "bare-cmd" connection timed out after 30000ms',
].join('\n');

check('a stdio server whose command contains a space is not dropped', () => {
  const servers = health.parseMcpList(REAL_STDIO);
  const s = servers.find((x) => x.name === 'demo-stdio');
  assert.ok(s, `dropped: ${JSON.stringify(servers.map((x) => x.name))}`);
  assert.strictEqual(s.url, 'node /tmp/nonexistent-server.js');
  assert.strictEqual(s.status, 'down');
});

check('a stdio server whose command has no slash at all is not dropped', () => {
  const s = health.parseMcpList(REAL_STDIO).find((x) => x.name === 'bare-cmd');
  assert.ok(s, 'a bare command was dropped');
  assert.strictEqual(s.url, 'node');
  assert.strictEqual(s.status, 'down');
});

check('a timed-out server is down rather than unrecognised', () => {
  assert.strictEqual(health.classifyStatus('connection timed out after 30000ms'), 'down');
});

check('"Disconnected" is not read as connected', () => {
  // It contains the word. Asking about "connected" before asking about failure
  // classified a dead server as healthy, which is the one thing this segment
  // exists to notice, shown green.
  assert.strictEqual(health.classifyStatus('Disconnected'), 'down');
  assert.strictEqual(health.classifyStatus('\u2718 Failed to connect'), 'down');
  assert.strictEqual(health.classifyStatus('Connection closed'), 'down');
});

check('a genuinely connected server still reads as connected', () => {
  // The other direction, so the failure-first ordering above cannot have
  // quietly turned everything into an outage.
  assert.strictEqual(health.classifyStatus('\u2714 Connected'), 'connected');
  assert.strictEqual(health.classifyStatus('! Needs authentication'), 'needs_auth');
});

check('parsing empty or garbage output yields no servers rather than throwing', () => {
  assert.deepStrictEqual(health.parseMcpList(''), []);
  assert.deepStrictEqual(health.parseMcpList(null), []);
  assert.deepStrictEqual(health.parseMcpList('total nonsense\nmore nonsense'), []);
});

// ---------------------------------------------------------------- probing ----

check('a probe that cannot run returns null, not an empty list', () => {
  // These are different claims. An empty list says "you have no servers" and
  // would overwrite a good cache with an all-clear. null says "we did not find
  // out", and leaves the cache alone.
  const result = health.probe({
    exec: () => { throw new Error('claude: command not found'); },
  });
  assert.strictEqual(result, null);
});

check('a probe returning no parseable servers is also null', () => {
  assert.strictEqual(health.probe({ exec: () => 'Checking MCP server health…' }), null);
});

check('a successful no-servers response is an empty list rather than a failed probe', () => {
  assert.deepStrictEqual(health.probe({ exec: () => 'No MCP servers configured' }), []);
});

check('a failed refresh leaves the existing cache untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
  health.writeCache([{ name: 'claude.ai Notion', url: 'u', status: 'connected' }], { home });
  const before = fs.readFileSync(health.cachePath(home), 'utf8');

  health.refresh({ home, exec: () => { throw new Error('nope'); } });

  assert.strictEqual(fs.readFileSync(health.cachePath(home), 'utf8'), before);
});

// ----------------------------------------------------- scheduled monitor ----

const MCP = (rows) => ['Checking MCP server health…', '', ...rows].join('\n');
const connected = (name) => `claude.ai ${name}: https://example.com/${name} - ✔ Connected`;
const needsAuth = (name) => `claude.ai ${name}: https://example.com/${name} - ! Needs authentication`;
const unreachable = (name) => `claude.ai ${name}: https://example.com/${name} - ✘ Failed to connect`;
const monitorConfig = (tools) => ({ ...config.DEFAULTS, coreTools: tools });

check('an unconfigured scheduled probe says that nothing is being watched', () => {
  const result = health.scheduledProbe({ config: monitorConfig([]) });
  assert.strictEqual(result.event, 'unconfigured');
  assert.match(result.message, /not watching anything/);
  assert.match(result.message, /\/core-tools/);
});

check('a healthy scheduled probe is silent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([connected('Gmail')]),
  });
  assert.strictEqual(result.event, 'unchanged');
  assert.strictEqual(result.message, '');
  assert.ok(health.readCache(home), 'the scheduled probe did not refresh the status cache');
});

check('a failure opens one incident and repeated failures stay silent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const args = {
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([needsAuth('Gmail')]),
  };
  const first = health.scheduledProbe({ ...args, now: 1000 });
  assert.strictEqual(first.event, 'opened');
  assert.match(first.message, /Email needs sign-in/);
  assert.match(first.message, /session:core-tools/);

  const second = health.scheduledProbe({ ...args, now: 2000 });
  assert.strictEqual(second.event, 'unchanged');
  assert.strictEqual(second.message, '');
  assert.strictEqual(health.readIncident(home).incident.source_id, 'session:core-tools');
});

check('a changed failure updates the same incident instead of stacking another', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const cfg = monitorConfig([
    { label: 'Email', match: 'Gmail' },
    { label: 'Notion', match: 'Notion' },
  ]);
  health.scheduledProbe({ home, config: cfg, now: 1000, exec: () => MCP([needsAuth('Gmail'), connected('Notion')]) });
  const changed = health.scheduledProbe({
    home, config: cfg, now: 2000, exec: () => MCP([needsAuth('Gmail'), unreachable('Notion')]),
  });
  assert.strictEqual(changed.event, 'updated');
  assert.match(changed.message, /Notion is unreachable/);
  assert.strictEqual(health.readIncident(home).incident.source_id, 'session:core-tools');
});

check('recovery closes the incident once and then stays silent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const cfg = monitorConfig([{ label: 'Email', match: 'Gmail' }]);
  health.scheduledProbe({ home, config: cfg, now: 1000, exec: () => MCP([needsAuth('Gmail')]) });

  const recovered = health.scheduledProbe({ home, config: cfg, now: 2000, exec: () => MCP([connected('Gmail')]) });
  assert.strictEqual(recovered.event, 'resolved');
  assert.match(recovered.message, /recovered/);
  assert.strictEqual(health.readIncident(home).incident.status, 'resolved');

  const again = health.scheduledProbe({ home, config: cfg, now: 3000, exec: () => MCP([connected('Gmail')]) });
  assert.strictEqual(again.event, 'unchanged');
  assert.strictEqual(again.message, '');
});

check('a failed health command alerts once, stays silent, and recovers once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  health.writeCache(health.parseMcpList(MCP([connected('Gmail')])), { home, now: 1 });
  const before = fs.readFileSync(health.cachePath(home), 'utf8');
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => { throw new Error('cannot run'); },
  });
  assert.strictEqual(result.event, 'probe_failed');
  assert.match(result.message, /Claude CLI/);
  assert.strictEqual(health.readIncident(home).incident.kind, 'probe_error');
  assert.strictEqual(fs.readFileSync(health.cachePath(home), 'utf8'), before);

  const repeated = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => { throw new Error('still cannot run'); },
  });
  assert.strictEqual(repeated.event, 'unchanged');
  assert.strictEqual(repeated.message, '');

  const recovered = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([connected('Gmail')]),
  });
  assert.strictEqual(recovered.event, 'resolved');
  assert.match(recovered.message, /health check is running again/);
});

check('a failed health command does not replace an existing real outage', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const cfg = monitorConfig([{ label: 'Email', match: 'Gmail' }]);
  const opened = health.scheduledProbe({ home, config: cfg, now: 1000, exec: () => MCP([needsAuth('Gmail')]) });
  const failed = health.scheduledProbe({
    home, config: cfg, now: 2000, exec: () => { throw new Error('temporary failure'); },
  });
  assert.strictEqual(failed.event, 'unchanged');
  assert.strictEqual(failed.message, '');
  assert.deepStrictEqual(health.readIncident(home).incident.problems, opened.incident.problems);

  const stillDown = health.scheduledProbe({ home, config: cfg, now: 3000, exec: () => MCP([needsAuth('Gmail')]) });
  assert.strictEqual(stillDown.event, 'unchanged');
  assert.strictEqual(stillDown.message, '');
});

check('an unwritable lock parent reports that monitoring cannot run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  fs.mkdirSync(path.join(home, '.cache'));
  fs.writeFileSync(path.join(home, '.cache', 'session'), 'not a directory');
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([needsAuth('Gmail')]),
  });
  assert.strictEqual(result.event, 'lock_failed');
  assert.match(result.message, /coordination lock could not be created/);
  assert.match(result.message, /permissions/);
});

check('a failure to persist a new incident is reported instead of hidden', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([needsAuth('Gmail')]),
    writeIncidentFn: () => null,
  });
  assert.strictEqual(result.event, 'write_failed');
  assert.match(result.message, /could not be recorded/);
  assert.match(result.message, /may repeat/);
});

check('a failed incident rename removes its temporary file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  fs.mkdirSync(health.incidentPath(home), { recursive: true });
  assert.strictEqual(health.writeIncident({ version: 1, incident: { status: 'open' } }, { home }), null);
  const leftovers = fs.readdirSync(path.dirname(health.incidentPath(home)))
    .filter((name) => name.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

check('a stale lock takeover cannot be released by the previous owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const first = health.acquireIncidentLock(home, 1000);
  assert.strictEqual(first.status, 'acquired');
  fs.utimesSync(first.path, new Date(0), new Date(0));

  const second = health.acquireIncidentLock(home, health.INCIDENT_LOCK_STALE_MS + 2000);
  assert.strictEqual(second.status, 'acquired');
  assert.notStrictEqual(first.owner, second.owner);

  health.releaseIncidentLock(first);
  assert.ok(fs.existsSync(second.path), 'the old owner removed its successor\'s live lock');
  health.releaseIncidentLock(second);
  assert.ok(!fs.existsSync(second.path), 'the current owner did not release its own lock');
});

check('a stale-lock contender cannot move and delete a newly-created live lock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const abandoned = health.acquireIncidentLock(home, 1000);
  assert.strictEqual(abandoned.status, 'acquired');
  fs.utimesSync(abandoned.path, new Date(0), new Date(0));
  let successor;
  const contender = health.acquireIncidentLock(home, health.INCIDENT_LOCK_STALE_MS + 2000, {
    beforeStaleRename: (lockPath) => {
      fs.rmSync(lockPath, { recursive: true, force: true });
      successor = health.acquireIncidentLock(home, health.INCIDENT_LOCK_STALE_MS + 2001);
    },
  });
  assert.strictEqual(successor.status, 'acquired');
  assert.strictEqual(contender.status, 'busy');
  assert.strictEqual(fs.readFileSync(path.join(successor.path, 'owner'), 'utf8'), successor.owner);
  health.releaseIncidentLock(successor);
});

check('logical incident time cannot keep a crashed monitor lock fresh forever', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  const abandoned = health.acquireIncidentLock(home, Date.now());
  assert.strictEqual(abandoned.status, 'acquired');
  fs.utimesSync(abandoned.path, new Date(0), new Date(0));

  const result = health.scheduledProbe({
    home,
    now: 1000,
    wallNow: Date.now(),
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([connected('Gmail')]),
  });
  assert.strictEqual(result.event, 'unchanged');
  assert.strictEqual(result.message, '');
});

check('a corrupt incident record is quarantined once without opening a duplicate incident', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  fs.mkdirSync(path.dirname(health.incidentPath(home)), { recursive: true });
  fs.writeFileSync(health.incidentPath(home), '{not json');
  let probed = false;
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => { probed = true; return MCP([needsAuth('Gmail')]); },
  });
  assert.strictEqual(result.event, 'state_repaired');
  assert.match(result.message, /repaired an unreadable incident record/);
  assert.strictEqual(probed, false);
  assert.strictEqual(health.readIncident(home).incident, null);
  assert.ok(fs.readdirSync(path.dirname(health.incidentPath(home))).some((name) => name.includes('.corrupt.')));

  const next = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([connected('Gmail')]),
  });
  assert.strictEqual(next.event, 'unchanged');
  assert.strictEqual(next.message, '');
});

check('an overlapping scheduled probe stays silent rather than duplicating an alert', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-'));
  fs.mkdirSync(health.incidentLockPath(home), { recursive: true });
  const result = health.scheduledProbe({
    home,
    config: monitorConfig([{ label: 'Email', match: 'Gmail' }]),
    exec: () => MCP([needsAuth('Gmail')]),
  });
  assert.strictEqual(result.event, 'busy');
  assert.strictEqual(result.message, '');
});

// ------------------------------------------------------------ resolution ----

const SERVERS = health.parseMcpList(MCP_LIST_SAMPLE);

check('a configured tool matches its server case-insensitively by substring', () => {
  const rows = health.resolve([{ label: 'Email', match: 'gmail' }], SERVERS);
  assert.strictEqual(rows[0].status, 'connected');
  assert.strictEqual(rows[0].server, 'claude.ai Gmail');
});

check('a tool whose server needs auth is reported as needing auth', () => {
  const rows = health.resolve([{ label: 'Bank', match: 'Mercury' }], SERVERS);
  assert.strictEqual(rows[0].status, 'needs_auth');
});

check('a tool matching nothing is missing, not down', () => {
  // A name in the config that refers to nothing is a config problem, usually a
  // renamed server. Reporting it as an outage sends someone to check a service
  // that is fine.
  const rows = health.resolve([{ label: 'Ghost', match: 'nosuchserver' }], SERVERS);
  assert.strictEqual(rows[0].status, 'missing');
  assert.strictEqual(rows[0].server, null);
});

// -------------------------------------------------------------- the line ----

function withCache(servers, { ageMinutes = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
  health.writeCache(servers, { home, now: Date.now() - ageMinutes * 60000 });
  return home;
}

const CFG = (tools, extra = {}) => ({ ...config.DEFAULTS, coreTools: tools, ...extra });

check('no configured tools means no segment at all', () => {
  const home = withCache(SERVERS);
  assert.strictEqual(health.statuslineSegment({ config: CFG([]), home }), '');
});

check('no cache shows nothing rather than zero out of five', () => {
  // Before the first background refresh completes there is no cache. "0/5"
  // would read as five broken tools, which is alarming and invented.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
  const seg = health.statuslineSegment({ config: CFG([{ label: 'Email', match: 'Gmail' }]), home });
  assert.strictEqual(seg, '');
});

check('all connected shows a plain count', () => {
  const home = withCache(SERVERS);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Email', match: 'Gmail' }, { label: 'Notion', match: 'Notion' }]),
    home,
    color: false,
  });
  assert.match(seg, /Core tools 2\/2/);
});

check('a tool needing sign-in is named, and said to need sign-in', () => {
  const home = withCache(SERVERS);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Email', match: 'Gmail' }, { label: 'Bank', match: 'Mercury' }]),
    home,
    color: false,
  });
  assert.match(seg, /Core tools 1\/2/);
  assert.match(seg, /Bank needs sign-in/);
});

check('an unreachable tool is not described as needing sign-in', () => {
  const home = withCache([{ name: 'claude.ai Thing', url: 'u', status: 'down' }]);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Thing', match: 'Thing' }]), home, color: false,
  });
  assert.match(seg, /unreachable/);
  assert.doesNotMatch(seg, /needs sign-in/);
});

// The next three pin the sentence rather than the data. `resolve` already kept
// missing and down apart, and there is a passing test above proving it, but the
// display path swept them into one bucket and called both "unreachable". A typo
// in the config was reported as an outage, which sends someone to troubleshoot
// a service that is working.
//
// The lesson is the one this repository keeps relearning: a correct
// distinction upstream, a comment explaining it, and a test pinning it are all
// worth nothing if the sentence a person actually reads collapses it again.

check('a mistyped tool name is never called unreachable', () => {
  const home = withCache([{ name: 'claude.ai Notion', url: 'u', status: 'connected' }]);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Noton', match: 'Noton' }]), home, color: false,
  });
  assert.doesNotMatch(seg, /unreachable/, 'a config typo was reported as an outage');
  assert.match(seg, /not found/);
});

check('a mistyped name does not get the colour that means something is broken', () => {
  // 31 is red and means a tool has actually stopped working. A name that
  // matches nothing is a config problem, so it gets 33.
  const home = withCache([{ name: 'claude.ai Notion', url: 'u', status: 'connected' }]);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Noton', match: 'Noton' }]), home,
  });
  assert.ok(seg.includes('\x1b[33m'), `expected yellow, got ${JSON.stringify(seg)}`);
  assert.ok(!seg.includes('\x1b[31m'), 'a config typo was coloured as an outage');
});

check('a real outage and a mistyped name at once are reported separately', () => {
  const home = withCache([{ name: 'claude.ai Thing', url: 'u', status: 'down' }]);
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Thing', match: 'Thing' }, { label: 'Ghost', match: 'nosuch' }]),
    home,
    color: false,
  });
  assert.match(seg, /Thing unreachable/);
  assert.match(seg, /Ghost not found/);
});

check('all three problem kinds at once each keep their own wording', () => {
  const home = withCache([
    { name: 'claude.ai Gmail', url: 'u', status: 'connected' },
    { name: 'claude.ai Mercury', url: 'u', status: 'needs_auth' },
    { name: 'claude.ai Thing', url: 'u', status: 'down' },
  ]);
  const seg = health.statuslineSegment({
    config: CFG([
      { label: 'Email', match: 'Gmail' },
      { label: 'Bank', match: 'Mercury' },
      { label: 'Thing', match: 'Thing' },
      { label: 'Ghost', match: 'nosuch' },
    ]),
    home,
    color: false,
  });
  assert.match(seg, /Core tools 1\/4/);
  assert.match(seg, /Bank needs sign-in/);
  assert.match(seg, /Thing unreachable/);
  assert.match(seg, /Ghost not found/);
});

check('a stale cache says how old it is', () => {
  // A count with no age is a claim about a moment you cannot see.
  const home = withCache(SERVERS, { ageMinutes: 300 });
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Email', match: 'Gmail' }]), home, color: false,
  });
  assert.match(seg, /5h old/);
});

check('a fresh cache does not clutter the line with its age', () => {
  const home = withCache(SERVERS, { ageMinutes: 2 });
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Email', match: 'Gmail' }]), home, color: false,
  });
  assert.doesNotMatch(seg, /old/);
});

check('showStaleHealth false hides a stale segment entirely', () => {
  const home = withCache(SERVERS, { ageMinutes: 300 });
  const seg = health.statuslineSegment({
    config: CFG([{ label: 'Email', match: 'Gmail' }], { showStaleHealth: false }),
    home,
    color: false,
  });
  assert.strictEqual(seg, '');
});

// ---------------------------------------------------------------- config ----

check('a missing config file gives working defaults, with the segment off', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cfg-'));
  const cfg = config.load(home);
  assert.deepStrictEqual(cfg.coreTools, []);
  assert.strictEqual(cfg.healthMaxAgeMinutes, config.DEFAULTS.healthMaxAgeMinutes);
});

check('a malformed config file does not take the session down', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(config.configPath(home), '{ this is not json');
  assert.deepStrictEqual(config.load(home).coreTools, []);
});

check('overriding one key leaves the others at their defaults', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(config.configPath(home), JSON.stringify({ healthMaxAgeMinutes: 5 }));
  const cfg = config.load(home);
  assert.strictEqual(cfg.healthMaxAgeMinutes, 5);
  assert.strictEqual(cfg.showStaleHealth, config.DEFAULTS.showStaleHealth);
});

check('an unusable coreTools entry is dropped, not fatal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(config.configPath(home), JSON.stringify({
    coreTools: [{ label: 'Good', match: 'Gmail' }, null, 'nonsense', {}],
  }));
  const cfg = config.load(home);
  assert.strictEqual(cfg.coreTools.length, 1);
  assert.strictEqual(cfg.coreTools[0].label, 'Good');
});

check('a coreTools entry with only a label uses it as the match too', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cfg-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(config.configPath(home), JSON.stringify({ coreTools: [{ label: 'Notion' }] }));
  assert.strictEqual(config.load(home).coreTools[0].match, 'Notion');
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
