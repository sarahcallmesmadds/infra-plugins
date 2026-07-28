#!/usr/bin/env node
// Regression tests for the parallel session detector.
//
// Run: node tests/session-sessions.test.js
//
// The rows that matter most are the two impostors. On a machine that runs the
// Claude desktop app or a session manager, the process table is full of things
// with "claude" in the command line that are not sessions. Matching one of them
// produces a warning about a session that does not exist, pointing at a
// directory that means nothing, which is the fastest way to teach someone to
// ignore this hook.
//
// The `ps` samples below are real output from a machine running all three at
// once, trimmed in width only.

'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const { parsePs, overlaps } = require(path.join(ROOT, 'scripts', 'sessions.js'));
const { parallelLine } = require(path.join(ROOT, 'hooks', 'session-start.js'));

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

// ------------------------------------------------------------ ps parsing ----

const REAL_PS = [
  '  PID                  STARTED COMMAND',
  ' 2936 Fri Jul 24 22:28:53 2026 /Applications/Claude.app/Contents/MacOS/Claude',
  ' 2940 Fri Jul 24 22:28:56 2026 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process',
  '66995 Mon Jul 27 20:19:01 2026 /Applications/cmux.app/Contents/Resources/bin/cmux hooks feed --source claude',
  '66141 Mon Jul 27 20:14:57 2026 /Users/sarahmadden/.local/bin/claude --session-id 3667d77f-7558-4f65-b19e-0483620f95bf --settings {"hooks":{}}',
  '69501 Mon Jul 27 20:31:12 2026 /Users/sarahmadden/.local/bin/claude --session-id 78F0713B-0EB4-4B77-BCCD-5441DA44A5D5',
].join('\n');

const NOW = Date.parse('Mon Jul 27 20:34:57 2026');

check('finds exactly the two real sessions in real ps output', () => {
  const found = parsePs(REAL_PS, NOW);
  assert.strictEqual(found.length, 2, `expected 2, got ${found.length}: ${found.map((f) => f.pid)}`);
  assert.deepStrictEqual(found.map((f) => f.pid), [66141, 69501]);
});

check('the desktop app is not a session', () => {
  const found = parsePs(REAL_PS, NOW);
  assert.ok(!found.some((f) => f.pid === 2936), 'matched /Applications/Claude.app');
  assert.ok(!found.some((f) => f.pid === 2940), 'matched a Claude Helper renderer');
});

check('a session manager passing --source claude is not a session', () => {
  const found = parsePs(REAL_PS, NOW);
  assert.ok(!found.some((f) => f.pid === 66995), 'matched cmux');
});

check('session ids are lowercased so self-exclusion cannot miss on case', () => {
  const found = parsePs(REAL_PS, NOW);
  assert.strictEqual(found[1].sessionId, '78f0713b-0eb4-4b77-bccd-5441da44a5d5');
});

check('age is computed from the ps start time', () => {
  const found = parsePs(REAL_PS, NOW);
  assert.strictEqual(found[0].ageMinutes, 20);
  assert.strictEqual(found[1].ageMinutes, 4);
});

check('an unparseable start time leaves age null, never zero', () => {
  // Zero reads as "started just now", which is a claim, and a wrong one.
  const found = parsePs('123 not a real date at all /usr/bin/claude --session-id '
    + '11111111-2222-3333-4444-555555555555', NOW);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].ageMinutes, null);
  assert.strictEqual(found[0].startedAt, null);
});

check('empty and garbage input yield no sessions rather than throwing', () => {
  assert.deepStrictEqual(parsePs('', NOW), []);
  assert.deepStrictEqual(parsePs(null, NOW), []);
  assert.deepStrictEqual(parsePs('\n\n   \n', NOW), []);
});

// ------------------------------------------------- recognising the caller ----
//
// Failing to recognise the caller produces the one answer guaranteed to be
// useless: "another session is live in this directory", about itself. The hook
// has an exact id from its event. A command run from a skill has no event and
// reads the environment, so it reads two variables rather than betting the
// whole answer on one name staying the same.

const { liveSessions } = require(path.join(ROOT, 'scripts', 'sessions.js'));
const psExec = (cmd) => (cmd === 'ps' ? REAL_PS : null);

check('the caller is excluded by session id', () => {
  const r = liveSessions({
    selfSessionId: '3667d77f-7558-4f65-b19e-0483620f95bf', exec: psExec, now: NOW,
  });
  assert.strictEqual(r.sessions.length, 1);
  assert.strictEqual(r.identifiedSelf, true);
});

check('the caller is excluded by pid when the id is unavailable', () => {
  // The second signal. The pid is in the process table already, so it needs no
  // agreement about formats, and it covers a renamed id variable.
  const r = liveSessions({ selfPid: '66141', exec: psExec, now: NOW });
  assert.strictEqual(r.sessions.length, 1);
  assert.ok(!r.sessions.some((s) => s.pid === 66141));
  assert.strictEqual(r.identifiedSelf, true);
});

check('a session id in a different case still excludes the caller', () => {
  const r = liveSessions({
    selfSessionId: '78F0713B-0EB4-4B77-BCCD-5441DA44A5D5', exec: psExec, now: NOW,
  });
  assert.ok(!r.sessions.some((s) => s.pid === 69501));
});

check('when neither signal identifies the caller, that is reported', () => {
  // The important half. Silently listing yourself as a parallel session is a
  // confident wrong answer; saying the list may include you is a true one.
  const r = liveSessions({ exec: psExec, now: NOW });
  assert.strictEqual(r.sessions.length, 2);
  assert.strictEqual(r.identifiedSelf, false);
});

check('a nonsense pid does not accidentally exclude a real session', () => {
  for (const bad of ['', 'abc', '0', '-1', null, undefined]) {
    const r = liveSessions({ selfPid: bad, exec: psExec, now: NOW });
    assert.strictEqual(r.sessions.length, 2, `pid ${JSON.stringify(bad)} excluded something`);
    assert.strictEqual(r.identifiedSelf, false);
  }
});

check('a failed ps reports incomplete rather than an empty all-clear', () => {
  const r = liveSessions({ exec: () => null });
  assert.deepStrictEqual(r.sessions, []);
  assert.strictEqual(r.complete, false);
});

// -------------------------------------------------------------- overlap ----

const OVERLAP_CASES = [
  ['/a/b', '/a/b', true, 'the same directory'],
  ['/a/b', '/a/b/c', true, 'their session is inside ours'],
  ['/a/b/c', '/a/b', true, 'ours is inside theirs, which collides just as much'],
  ['/a/b/', '/a/b', true, 'a trailing slash is not a different directory'],
  ['/a/b', '/a/c', false, 'siblings do not collide'],
  ['/a/b', '/a/bc', false, 'a shared prefix is not containment'],
  ['/a/b', null, false, 'an unknown directory is not an overlap'],
  [null, '/a/b', false, 'and neither is an unknown one on our side'],
];

for (const [a, b, expected, why] of OVERLAP_CASES) {
  check(`overlap: ${why}`, () => {
    assert.strictEqual(overlaps(a, b), expected);
  });
}

// --------------------------------------------------------- the sentence ----

const deps = { overlaps };
const sess = (cwd, ageMinutes = 5) => ({ pid: 1, sessionId: 'x', cwd, ageMinutes });

check('says nothing when no other session is running', () => {
  assert.strictEqual(parallelLine('/a/b', { sessions: [], complete: true }, deps), '');
});

check('says nothing when every other session is elsewhere and we checked them all', () => {
  const line = parallelLine('/a/b', { sessions: [sess('/x/y')], complete: true }, deps);
  assert.match(line, /running elsewhere/);
  assert.doesNotMatch(line, /already live in this working directory/);
});

check('warns, with the path, when one overlaps', () => {
  const line = parallelLine('/a/b', { sessions: [sess('/a/b')], complete: true }, deps);
  assert.match(line, /Another Claude Code session is already live/);
  assert.match(line, /\/a\/b/);
});

check('counts and pluralizes when several overlap', () => {
  const line = parallelLine('/a/b', {
    sessions: [sess('/a/b'), sess('/a/b/c')], complete: true,
  }, deps);
  assert.match(line, /2 other Claude Code sessions are already live/);
});

check('caps the names it lists and says how many it left out', () => {
  const many = ['/a/1', '/a/2', '/a/3', '/a/4', '/a/5', '/a/6'].map((p) => sess(p));
  const line = parallelLine('/a', { sessions: many, complete: true }, deps);
  assert.match(line, /and 2 more/);
});

// This is the one that matters. An empty overlap list means "nothing overlaps"
// only when every working directory was actually read. When the deadline cut the
// scan short, the same empty list means "we do not know", and reporting silence
// there is a false all-clear at exactly the moment a warning was the point.
check('an incomplete scan never reports a clean all-clear', () => {
  const line = parallelLine('/a/b', { sessions: [sess(null)], complete: false }, deps);
  assert.match(line, /could not all be read/);
  assert.doesNotMatch(line, /none in this directory/);
});

check('an incomplete scan still reports the count, which is known', () => {
  const line = parallelLine('/a/b', {
    sessions: [sess(null), sess(null)], complete: false,
  }, deps);
  assert.match(line, /2 other Claude Code sessions are/);
});

check('an overlap found during an incomplete scan is still reported as one', () => {
  // Not knowing about some sessions is no reason to stay quiet about a session
  // we positively identified.
  const line = parallelLine('/a/b', {
    sessions: [sess('/a/b'), sess(null)], complete: false,
  }, deps);
  assert.match(line, /already live in this working directory/);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
