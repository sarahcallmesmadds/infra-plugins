#!/usr/bin/env node
// Regression tests for the context monitor and the git activity check.
//
// Run: node tests/session-context.test.js
//
// The context monitor exists because Claude Code hands the context window to
// the status line and tells the model nothing, so the person watching the bar
// fill up and the assistant deciding whether to open six more files have
// different information. The status line writes the number to a file and a
// PostToolUse hook reads it back.
//
// Two things carry most of the risk and both are pinned below.
//
// The number written to the bridge must be the raw one. The meter subtracts
// the autocompact buffer and rescales, which is correct for a progress bar and
// wrong for a warning: at 20% remaining the meter draws 96% and the raw figure
// is 80%. Sixteen points, in a message telling somebody how much room is left,
// against a /context reading they can check.
//
// And the debounce must not swallow an escalation. This runs after every tool
// call, so without a debounce a long session carries the same paragraph
// forever, spending context to complain about context. But crossing from
// warning into critical is the one transition that must always be heard.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'plugins', 'session');
const ctx = require(path.join(ROOT, 'scripts', 'context.js'));
const ga = require(path.join(ROOT, 'scripts', 'git-activity.js'));
const statusline = require(path.join(ROOT, 'statusline', 'statusline.js'));
const MONITOR = path.join(ROOT, 'hooks', 'context-monitor.js');

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { failures += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-ctx-'));

// ----------------------------------------------------------- the bridge ----

check('the bridge carries the raw percentage, not the meter percentage', () => {
  // The whole point. At 20% remaining the meter draws 96% because it discounts
  // the autocompact buffer. Telling the model 96 when /context says 80 is two
  // components disagreeing about one number in front of the user.
  const dir = tmp();
  const written = ctx.writeBridge({
    sessionId: 's1', contextWindow: { remaining_percentage: 20, total_tokens: 1000000 }, tmp: dir,
  });
  assert.strictEqual(written.used_pct, 80);
  assert.strictEqual(written.remaining_percentage, 20);

  const meter = statusline.renderContextMeter({ remaining_percentage: 20, total_tokens: 1000000 });
  const drawn = Number(meter.replace(/\x1b\[[0-9;]*m/g, '').match(/(\d+)%/)[1]);
  assert.notStrictEqual(drawn, written.used_pct,
    'the meter and the bridge agreeing would mean one of them is now wrong');
  assert.ok(drawn > written.used_pct, `meter ${drawn} should exceed raw ${written.used_pct}`);
});

check('a session id that looks like a path is refused, not sanitised', () => {
  // It lands in a filename. Rewriting a bad value would invent an id and share
  // one file between two sessions; refusing means no warnings, which is safe.
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
    assert.strictEqual(ctx.bridgePath(bad, '/tmp'), null, `accepted ${bad}`);
    assert.strictEqual(ctx.safeSessionId(bad), null);
  }
  assert.ok(ctx.bridgePath('3667d77f-7558-4f65-b19e-0483620f95bf', '/tmp'));
});

check('a missing or unreadable context window writes nothing', () => {
  const dir = tmp();
  assert.strictEqual(ctx.writeBridge({ sessionId: 's', contextWindow: null, tmp: dir }), null);
  assert.strictEqual(ctx.writeBridge({ sessionId: 's', contextWindow: {}, tmp: dir }), null);
  assert.strictEqual(fs.readdirSync(dir).length, 0);
});

check('a stale reading is not used', () => {
  // The status line renders constantly, so a stale file means it stopped. A
  // number from two minutes ago is not a fact about now.
  const dir = tmp();
  const now = Date.now();
  ctx.writeBridge({ sessionId: 's', contextWindow: { remaining_percentage: 10 }, tmp: dir, now });
  assert.ok(ctx.readBridge('s', { tmp: dir, now }), 'a fresh reading should be used');
  assert.strictEqual(ctx.readBridge('s', { tmp: dir, now: now + 120000 }), null);
});

check('no bridge file at all reads as no data, not as full context', () => {
  assert.strictEqual(ctx.readBridge('never-written', { tmp: tmp() }), null);
});

// ---------------------------------------------------------- the decision ----

const D = (remaining, state) => ctx.decide({ remaining, state });

check('plenty of remaining context says nothing', () => {
  assert.strictEqual(D(80, {}).speak, false);
  assert.strictEqual(D(36, {}).speak, false);
});

check('crossing the warning threshold speaks immediately', () => {
  const v = D(35, {});
  assert.strictEqual(v.speak, true);
  assert.strictEqual(v.level, 'warning');
});

check('the next few tool calls are debounced', () => {
  let state = D(30, {}).state;
  for (let i = 0; i < 3; i += 1) {
    const v = ctx.decide({ remaining: 30, state });
    assert.strictEqual(v.speak, false, `spoke again after ${i + 1} calls`);
    state = v.state;
  }
});

check('it speaks again once the debounce runs out', () => {
  let state = D(30, {}).state;
  let spoke = false;
  for (let i = 0; i < 6; i += 1) {
    const v = ctx.decide({ remaining: 30, state });
    state = v.state;
    if (v.speak) spoke = true;
  }
  assert.ok(spoke, 'it went permanently quiet');
});

check('escalating from warning to critical bypasses the debounce', () => {
  // The one transition that must always be heard. Swallowing it means the
  // model learns about the warning and never about the emergency.
  const state = D(30, {}).state;
  const v = ctx.decide({ remaining: 20, state });
  assert.strictEqual(v.speak, true, 'the escalation was swallowed');
  assert.strictEqual(v.level, 'critical');
  assert.strictEqual(v.escalated, true);
});

check('critical does not re-escalate forever once it has been said', () => {
  let state = ctx.decide({ remaining: 20, state: D(30, {}).state }).state;
  const v = ctx.decide({ remaining: 20, state });
  assert.strictEqual(v.speak, false, 'critical repeated on every single tool call');
});

check('recovering above the threshold resets the state', () => {
  const state = D(20, {}).state;
  const v = ctx.decide({ remaining: 90, state });
  assert.strictEqual(v.speak, false);
  assert.strictEqual(v.state.lastLevel, null, 'a recovered session stayed primed');
});

check('a nonsense remaining value says nothing rather than warning', () => {
  for (const bad of [null, undefined, NaN, 'lots']) {
    assert.strictEqual(ctx.decide({ remaining: bad, state: {} }).speak, false);
  }
});

// ---------------------------------------------------------- the message ----

check('the warning is advisory and does not order files to be written', () => {
  // An earlier generation told the model to save state and write handoffs,
  // which meant a long session spontaneously produced files nobody asked for
  // at the moment the user was busiest.
  const m = ctx.message({ level: 'critical', usedPct: 80, remaining: 20 });
  assert.match(m, /ask how they want to proceed/);
  assert.match(m, /do not save state or write handoff files/i);
});

check('both messages state the numbers they are warning about', () => {
  for (const level of ['warning', 'critical']) {
    const m = ctx.message({ level, usedPct: 70, remaining: 30 });
    assert.match(m, /70%/);
    assert.match(m, /30%/);
  }
});

// ------------------------------------------------------ the hook itself ----

function runMonitor(sessionId, dir) {
  return spawnSync(process.execPath, [MONITOR], {
    input: JSON.stringify({ session_id: sessionId, cwd: '/tmp' }),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: dir },
  }).stdout;
}

check('the hook stays silent with no bridge file', () => {
  assert.strictEqual(runMonitor('no-bridge-here', tmp()).trim(), '');
});

check('the hook emits a PostToolUse block when context is low', () => {
  const dir = tmp();
  ctx.writeBridge({ sessionId: 'live', contextWindow: { remaining_percentage: 22 }, tmp: dir });
  const out = runMonitor('live', dir);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(parsed.hookSpecificOutput.additionalContext, /CONTEXT CRITICAL/);
});

check('the hook stays silent when there is room', () => {
  const dir = tmp();
  ctx.writeBridge({ sessionId: 'roomy', contextWindow: { remaining_percentage: 90 }, tmp: dir });
  assert.strictEqual(runMonitor('roomy', dir).trim(), '');
});

// -------------------------------------------------------- git activity ----
//
// The hook this ports from held six absolute repository paths from another
// machine. Anywhere else it checked six directories that did not exist, found
// nothing, and said nothing, which is indistinguishable from all clear. So the
// tests here are about discovery finding things and about saying when it did
// not finish.

function repoAt(dir) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

check('repositories are discovered under a root rather than listed by hand', () => {
  const home = tmp();
  const root = path.join(home, 'Projects');
  repoAt(path.join(root, 'alpha'));
  repoAt(path.join(root, 'group', 'beta'));
  fs.mkdirSync(path.join(root, 'not-a-repo'), { recursive: true });

  const { repos } = ga.discover({ roots: ['~/Projects'], depth: 2, home });
  const names = repos.map((r) => path.basename(r)).sort();
  assert.deepStrictEqual(names, ['alpha', 'beta']);
});

check('a root that does not exist is survived, not thrown on', () => {
  const { repos, complete } = ga.discover({ roots: ['~/nowhere'], home: tmp() });
  assert.deepStrictEqual(repos, []);
  assert.strictEqual(complete, true, 'an absent root is not an incomplete scan');
});

check('the cap is reported as incomplete rather than passed off as everything', () => {
  const home = tmp();
  const root = path.join(home, 'Projects');
  for (let i = 0; i < 6; i += 1) repoAt(path.join(root, `r${i}`));
  const { repos, complete } = ga.discover({ roots: ['~/Projects'], depth: 2, maxRepos: 3, home });
  assert.strictEqual(repos.length, 3);
  assert.strictEqual(complete, false, 'a truncated walk claimed to be complete');
});

check('the current repository is included even when it is outside every root', () => {
  const home = tmp();
  const outside = repoAt(path.join(home, 'elsewhere', 'thing'));
  const { repos } = ga.discover({ roots: ['~/Projects'], depth: 2, home, extra: [outside] });
  assert.ok(repos.some((r) => path.basename(r) === 'thing'));
});

check('node_modules and dot directories are not walked', () => {
  const home = tmp();
  const root = path.join(home, 'Projects');
  repoAt(path.join(root, 'node_modules', 'pkg'));
  repoAt(path.join(root, '.cache', 'thing'));
  repoAt(path.join(root, 'real'));
  const { repos } = ga.discover({ roots: ['~/Projects'], depth: 2, home });
  assert.deepStrictEqual(repos.map((r) => path.basename(r)), ['real']);
});

check('a repository git cannot be read in is not reported as clean', () => {
  // null is "we could not look". Reporting it as zero changes would be a quiet
  // all-clear about a directory nobody managed to inspect.
  const row = ga.inspect('/no/such/repo', { exec: () => { throw new Error('nope'); } });
  assert.strictEqual(row.changed, null);
  assert.strictEqual(row.commits, null);
  assert.strictEqual(row.readable, false);
});

check('uncommitted files and recent commits are both counted', () => {
  const row = ga.inspect('/fake', {
    exec: (cmd, args) => {
      if (args.includes('--show-current')) return 'main\n';
      if (args.includes('--porcelain')) return ' M a.js\n?? b.js\n';
      if (args.includes('log')) return 'abc123|2 hours ago|did a thing\n';
      return '';
    },
  });
  assert.strictEqual(row.branch, 'main');
  assert.strictEqual(row.changed, 2);
  assert.strictEqual(row.commits.length, 1);
  assert.strictEqual(row.commits[0].subject, 'did a thing');
});

check('a commit subject containing a pipe survives parsing', () => {
  const row = ga.inspect('/fake', {
    exec: (cmd, args) => (args.includes('log') ? 'abc|1 hour ago|fix a || b handling\n' : ''),
  });
  assert.strictEqual(row.commits[0].subject, 'fix a || b handling');
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
