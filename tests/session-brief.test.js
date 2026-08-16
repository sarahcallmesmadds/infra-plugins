#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const brief = require(path.join(__dirname, '..', 'plugins', 'session', 'scripts', 'build-loop-brief.js'));
const sessionStart = require(path.join(__dirname, '..', 'plugins', 'session', 'hooks', 'session-start.js'));

let ran = 0;
let failed = 0;
function check(name, fn) {
  ran += 1;
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (error) { failed += 1; process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`); }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-brief-'));
}

function stateDir(home, name) {
  const dir = path.join(home, '.claude', 'build-loop', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

check('absent build-loop state stays silent', () => {
  assert.strictEqual(brief.buildBrief({ home: tempHome() }), '');
});

check('the queue reports active primary work and dependency reviews separately', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, '1.json'), { status: 'Open', type: 'primary', target: 'first-hook' });
  writeJson(path.join(dir, '2.json'), { status: 'In Progress', type: 'primary', target: 'second-script' });
  writeJson(path.join(dir, '3.json'), { status: 'Open', type: 'dep-review', target: 'dependent' });
  writeJson(path.join(dir, '4.json'), { status: 'Resolved', type: 'primary', target: 'finished' });
  writeJson(path.join(dir, '5.json'), { status: "Won't Fix", type: 'primary', target: 'declined' });
  fs.writeFileSync(path.join(dir, 'broken.json'), '{');

  const out = brief.buildBrief({ home });
  assert.match(out, /Bug queue: 2 active: first-hook, second-script\. Dependency reviews: 1 active\./);
  assert.doesNotMatch(out, /finished|declined|dependent/);
});

check('pre-v5 queue entries use skill as their short name', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, 'old.json'), {
    status: 'Open', skill: 'daily-brief', what_happened: 'A whole paragraph that must not be listed.',
  });
  const out = brief.buildBrief({ home });
  assert.match(out, /Bug queue: 1 active: daily-brief\./);
  assert.doesNotMatch(out, /whole paragraph/);
});

check('fix-applied watching entries do not inflate the list-bugs count', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, 'watching.json'), {
    status: 'fix applied, watching', type: 'primary', target: 'already-fixed',
  });
  assert.doesNotMatch(brief.buildBrief({ home }), /Bug queue/);
});

check('the retired unresolved status is surfaced separately from active', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, 'old-status.json'), {
    status: 'fix attempted / unresolved', skill: 'old-open-bug',
  });
  const out = brief.buildBrief({ home });
  assert.match(out, /Legacy unresolved queue entries: 1: old-open-bug\./);
  assert.doesNotMatch(out, /Bug queue:/);
});

check('dependency reviews alone do not announce zero active bugs', () => {
  const home = tempHome();
  const dir = stateDir(home, 'queue');
  writeJson(path.join(dir, 'review.json'), {
    status: 'Open', type: 'dep-review', target: 'dependent',
  });
  const out = brief.buildBrief({ home });
  assert.match(out, /Dependency reviews: 1 active\./);
  assert.doesNotMatch(out, /Bug queue: 0/);
});

check('the to-build count includes open and in-progress items only', () => {
  const home = tempHome();
  const dir = stateDir(home, 'to-build');
  writeJson(path.join(dir, '1.json'), { status: 'Open' });
  writeJson(path.join(dir, '2.json'), { status: 'In Progress' });
  writeJson(path.join(dir, '3.json'), { status: 'Built' });

  assert.match(brief.buildBrief({ home }), /To build: 2 active \(1 in progress\)\./);
});

check('the lexically latest weekly summary is included and bounded', () => {
  const home = tempHome();
  const dir = stateDir(home, 'summaries');
  fs.writeFileSync(path.join(dir, '2026-30.md'), 'old');
  fs.writeFileSync(path.join(dir, '2026-31.md'), 'x'.repeat(brief.SUMMARY_LIMIT + 100));

  const out = brief.buildBrief({ home });
  assert.match(out, /Latest weekly summary \(2026-31\.md\):/);
  assert.doesNotMatch(out, /old/);
  assert.ok(out.length < brief.SUMMARY_LIMIT + 100, `summary was not clipped: ${out.length}`);
  assert.ok(out.endsWith('\u2026'));
});

check('a weekly summary older than 14 days is not injected', () => {
  const home = tempHome();
  const dir = stateDir(home, 'summaries');
  const file = path.join(dir, '2026-01.md');
  fs.writeFileSync(file, 'stale report');
  const now = Date.now();
  fs.utimesSync(file, new Date(now - brief.SUMMARY_MAX_AGE_MS - 1), new Date(now - brief.SUMMARY_MAX_AGE_MS - 1));
  assert.doesNotMatch(brief.buildBrief({ home, now }), /weekly summary/i);
});

check('the weekly summary can be omitted on resume and compact', () => {
  const home = tempHome();
  const dir = stateDir(home, 'summaries');
  fs.writeFileSync(path.join(dir, '2026-31.md'), 'fresh report');
  assert.doesNotMatch(brief.buildBrief({ home, includeSummary: false }), /fresh report/);
});

check('only known repeat sources suppress the weekly summary', () => {
  assert.strictEqual(sessionStart.includeWeeklySummary('resume'), false);
  assert.strictEqual(sessionStart.includeWeeklySummary('compact'), false);
  assert.strictEqual(sessionStart.includeWeeklySummary('startup'), true);
  assert.strictEqual(sessionStart.includeWeeklySummary(undefined), true);
  assert.strictEqual(sessionStart.includeWeeklySummary('future-source'), true);
});

check('an entry pointing at a file that is gone is reported, with the remedy', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, 'here.js'), 'here');
  writeJson(path.join(root, 'DEPS.json'), { targets: {
    here: { path: '~/here.js', last_updated: '2000-01-01T00:00:00Z' },
    gone: { path: '~/gone.js', last_updated: '2000-01-01T00:00:00Z' },
  } });

  const out = brief.buildBrief({ home });
  assert.match(out, /Dependency map: 1 entry points at a file that is gone\./);
  assert.match(out, /Run \/audit-deps to drop it\./,
    'the line names the fault and not what to do about it, which is what makes '
    + 'a session-start line something to skip past');
});

check('an edited file is not reported at all', () => {
  // The whole bug. `last_updated` is a human review date and is deliberately
  // never bumped by machine, so an entry reviewed once and edited since counts
  // as drifted forever. On 2026-08-15 that was 82 of 127 entries with nothing
  // actually gone, printed as a warning not to rely on the map. Both files
  // below are present and both were edited long after their recorded date, and
  // the brief has nothing to say about either.
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, 'reviewed.js'), 'reviewed');
  fs.writeFileSync(path.join(home, 'watched.js'), 'watched');
  writeJson(path.join(root, 'DEPS.json'), { targets: {
    reviewed: { path: '~/reviewed.js', last_updated: '2000-01-01T00:00:00Z' },
    // A pre-v5 map: `last_auto_checked` was removed from the schema on
    // 2026-08-15, and this entry keeps it to prove the brief does not start
    // reading a field again just because an old map still carries it.
    watched: {
      path: '~/watched.js',
      last_updated: '2000-01-01T00:00:00Z',
      last_auto_checked: '2000-01-02T00:00:00Z',
    },
  } });

  const out = brief.buildBrief({ home });
  assert.doesNotMatch(out, /Dependency map/,
    'an edited file is a maintenance hint for /audit-deps, not a session-start '
    + 'line, and printing it every session is what stopped the real one landing');
  assert.doesNotMatch(out, /drift|changed|rely on it/i,
    'the old warning wording is back');
});

check('a whole map with every file present says nothing', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(home, 'one.js'), 'one');
  writeJson(path.join(root, 'DEPS.json'), { targets: {
    one: { path: '~/one.js', last_updated: '2000-01-01T00:00:00Z' },
  } });
  // Matched against the old wording as well as the new. Asserting only that the
  // new sentence is absent is satisfied by the old warning being printed
  // instead, which is the thing being removed, so the check would have passed
  // against the source it exists to rule out.
  assert.doesNotMatch(brief.buildBrief({ home }), /Dependency map|DEPS\.json drift/);
});

// There is no check here for a scan cut short partway through the map, and
// that is deliberate. `expired` reads the wall clock with nothing to inject, so
// reaching that branch means passing a deadline a millisecond or two out and
// hoping the loop is slower than the guard above it. That is a test whose
// answer depends on how busy the machine is, which is the fault #102, #103 and
// #104 were all about. The branch is unchanged by this commit and was untested
// before it. Reported rather than papered over with a check that passes for the
// wrong reason.

check('v1 DEPS skills are read as targets', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'DEPS.json'), { skills: {
    old: { path: '~/missing-old-skill', last_updated: '2000-01-01T00:00:00Z' },
  } });
  assert.match(brief.buildBrief({ home }), /Dependency map: 1 entry points at a file that is gone\./);
});

check('a deadline exhausted before any read stays silent', () => {
  const home = tempHome();
  const root = path.join(home, '.claude', 'build-loop');
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'DEPS.json'), { targets: { one: { path: '~/one' } } });
  assert.strictEqual(brief.buildBrief({ home, deadline: 0 }), '');
});

check('an exhausted deadline suppresses every brief reader', () => {
  const home = tempHome();
  const queue = stateDir(home, 'queue');
  const builds = stateDir(home, 'to-build');
  const summaries = stateDir(home, 'summaries');
  writeJson(path.join(queue, 'one.json'), { status: 'Open', target: 'bug' });
  writeJson(path.join(builds, 'one.json'), { status: 'Open' });
  fs.writeFileSync(path.join(summaries, '2026-31.md'), 'summary');
  assert.strictEqual(brief.buildBrief({ home, deadline: 0 }), '');
});

check('the combined hook context never exceeds 10000 characters', () => {
  const out = brief.joinContext(['date', 'x'.repeat(20000)]);
  assert.strictEqual(out.length, brief.CONTEXT_LIMIT);
  assert.ok(out.endsWith('\u2026'));
});

process.stdout.write(`\n${ran} checks, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
