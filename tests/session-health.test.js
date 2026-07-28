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
// The `claude mcp list` sample is real output, with two servers genuinely
// needing authentication at the time it was captured.

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

const REAL_MCP_LIST = [
  'Checking MCP server health…',
  '',
  'claude.ai Intuit QuickBooks: https://ai-inc.quickbooks.intuit.com/v1/mcp - ✔ Connected',
  'claude.ai Mercury: https://mcp.mercury.com/mcp - ! Needs authentication',
  'claude.ai Microsoft 365: https://microsoft365.mcp.claude.com/mcp - ✔ Connected',
  'claude.ai n8n: https://sarahcallmesmadds.app.n8n.cloud/mcp-server/http - ! Needs authentication',
  'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'claude.ai Notion: https://mcp.notion.com/mcp - ✔ Connected',
].join('\n');

// ---------------------------------------------------------------- parsing ----

check('parses real `claude mcp list` output', () => {
  const servers = health.parseMcpList(REAL_MCP_LIST);
  assert.strictEqual(servers.length, 7, `got ${servers.length}`);
});

check('the "Checking MCP server health" header is not a server', () => {
  const servers = health.parseMcpList(REAL_MCP_LIST);
  assert.ok(!servers.some((s) => /Checking/.test(s.name)), 'header parsed as a server');
});

check('a server name containing a dot and a space survives intact', () => {
  // "claude.ai Intuit QuickBooks" breaks anything that splits on a dot, a
  // space, or the first colon.
  const servers = health.parseMcpList(REAL_MCP_LIST);
  assert.ok(servers.some((s) => s.name === 'claude.ai Intuit QuickBooks'));
});

check('the URL is not truncated at its own colon', () => {
  const servers = health.parseMcpList(REAL_MCP_LIST);
  const gmail = servers.find((s) => s.name.includes('Gmail'));
  assert.strictEqual(gmail.url, 'https://gmailmcp.googleapis.com/mcp/v1');
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

check('a failed refresh leaves the existing cache untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-health-'));
  health.writeCache([{ name: 'claude.ai Notion', url: 'u', status: 'connected' }], { home });
  const before = fs.readFileSync(health.cachePath(home), 'utf8');

  health.refresh({ home, exec: () => { throw new Error('nope'); } });

  assert.strictEqual(fs.readFileSync(health.cachePath(home), 'utf8'), before);
});

// ------------------------------------------------------------ resolution ----

const SERVERS = health.parseMcpList(REAL_MCP_LIST);

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
