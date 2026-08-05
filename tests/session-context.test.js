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

// The git scan is off until asked for, so any test about what it reports has to
// ask. Tests that are about it staying quiet deliberately do not call this.
const enableGitActivity = (home) => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session.config.json'),
    JSON.stringify({ gitActivity: { enabled: true } }),
  );
  return home;
};

const writeTodos = (home, sessionId, tasks, suffix = 'agent-main') => {
  const dir = path.join(home, '.claude', 'todos');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}-${suffix}.json`), JSON.stringify(tasks));
};

// ------------------------------------------------------ current task line ----

check('the status line shows this session activeForm in the middle', () => {
  const home = tmp();
  writeTodos(home, 'session-a', [
    { status: 'completed', activeForm: 'Finished work' },
    { status: 'in_progress', activeForm: 'Building the current-task segment' },
  ]);
  writeTodos(home, 'session-b', [
    { status: 'in_progress', activeForm: 'Working in another session' },
  ]);
  const segment = statusline.readCurrentTaskStatuslineSegment({ sessionId: 'session-a', home });
  assert.match(segment, /Building the current-task segment/);
  assert.doesNotMatch(segment, /another session/);
  const line = statusline.composeStatusline({ model: 'Claude', dirname: 'plugins', currentTask: segment, cost: ' │ $1' });
  assert.ok(line.indexOf('Building the current-task segment') < line.indexOf('$1'));
});

check('current task stays quiet without a usable task file', () => {
  const home = tmp();
  writeTodos(home, 'other-session', [{ status: 'in_progress', activeForm: 'Not ours' }]);
  assert.strictEqual(statusline.readCurrentTaskStatuslineSegment({ sessionId: 'this-session', home }), '');
  writeTodos(home, 'this-session', [{ status: 'pending', activeForm: 'Not started' }]);
  assert.strictEqual(statusline.readCurrentTaskStatuslineSegment({ sessionId: 'this-session', home }), '');
});

check('current task accepts the wrapped todo shape and survives malformed files', () => {
  const home = tmp();
  writeTodos(home, 'wrapped', { tasks: [{ status: 'in_progress', activeForm: 'Wrapped task' }] }, 'agent-good');
  const bad = path.join(home, '.claude', 'todos', 'wrapped-agent-newer.json');
  fs.writeFileSync(bad, '{bad');
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(bad, future, future);
  assert.match(statusline.readCurrentTaskStatuslineSegment({ sessionId: 'wrapped', home }), /Wrapped task/);
});

check('current task can be disabled in session config', () => {
  const home = tmp();
  writeTodos(home, 'quiet', [{ status: 'in_progress', activeForm: 'Hidden task' }]);
  const segment = statusline.readCurrentTaskStatuslineSegment({
    sessionId: 'quiet', home, config: { currentTask: { enabled: false } },
  });
  assert.strictEqual(segment, '');
});

check('current task strips controls and bounds untrusted task text', () => {
  const home = tmp();
  writeTodos(home, 'safe', [{ status: 'in_progress', activeForm: `Doing\n\x1b[31m${'x'.repeat(100)}` }]);
  const plain = statusline.readCurrentTaskStatuslineSegment({ sessionId: 'safe', home })
    .replace(/\x1b\[[0-9;]*m/g, '');
  assert.doesNotMatch(plain, /\n|\x1b/);
  assert.doesNotMatch(plain, /\[31m/);
  assert.ok(plain.replace(/^.*↳ /, '').length <= 80);
});

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
      if (args.includes('log')) return 'abc123|1753600000|2 hours ago|did a thing\n';
      return '';
    },
  });
  assert.strictEqual(row.branch, 'main');
  assert.strictEqual(row.changed, 2);
  assert.strictEqual(row.commits.length, 1);
  assert.strictEqual(row.commits[0].subject, 'did a thing');
  assert.strictEqual(row.commits[0].when, '2 hours ago');
});

check('a commit subject containing a pipe survives parsing', () => {
  const row = ga.inspect('/fake', {
    exec: (cmd, args) => (args.includes('log') ? 'abc|1753600000|1 hour ago|fix a || b handling\n' : ''),
  });
  assert.strictEqual(row.commits[0].subject, 'fix a || b handling');
});

check('a commit carries a sortable timestamp as well as the printable one', () => {
  // `%ar` is what gets shown and cannot be compared. `%at` is what the ordering
  // sorts on. Asking for only the relative form is why the "newest first" claim
  // in scan's header was never implemented.
  const row = ga.inspect('/fake', {
    exec: (cmd, args) => (args.includes('log') ? 'abc|1753600000|1 hour ago|a subject\n' : ''),
  });
  assert.strictEqual(row.commits[0].at, 1753600000);
  assert.strictEqual(row.commits[0].when, '1 hour ago');
});

check('an unparseable timestamp is null rather than NaN', () => {
  // NaN sorts unpredictably and compares false against itself, so a row git
  // returned something odd for would move around between runs.
  const row = ga.inspect('/fake', {
    exec: (cmd, args) => (args.includes('log') ? 'abc|nonsense|1 hour ago|a subject\n' : ''),
  });
  assert.strictEqual(row.commits[0].at, null);
});

// -------------------------------------------------- the bounds actually bind ----
//
// `discover` advertised a bounded walk and performed an unbounded one whenever
// a caller left the bounds out.
//
// `{ ...DEFAULTS, roots, depth, maxRepos }` reads like a fallback and is the
// opposite: object shorthand always sets the key, so an omitted argument
// arrives as `undefined` and overwrites the default. `undefined < 0` and
// `undefined === 0` are both false and `undefined - 1` is NaN, so the depth
// limit never fired; `slice(0, undefined)` returned everything.
//
// The production path always passed concrete values, so nothing showed it. The
// tests above called `discover({ roots, depth, home })` with no cap and passed
// because their trees were tiny. These call it the way that was broken.

check('an omitted depth falls back to the default instead of removing the limit', () => {
  const home = tmp();
  let deep = path.join(home, 'Projects');
  for (let i = 0; i < 8; i += 1) deep = path.join(deep, `lvl${i}`);
  repoAt(deep);
  const { repos } = ga.discover({ roots: ['~/Projects'], home });
  assert.deepStrictEqual(repos, [], 'the walk went past the default depth');
});

check('an omitted maxRepos falls back to the default instead of removing the cap', () => {
  const home = tmp();
  for (let i = 0; i < 30; i += 1) repoAt(path.join(home, 'Projects', `r${i}`));
  const { repos, complete } = ga.discover({ roots: ['~/Projects'], home });
  assert.strictEqual(repos.length, ga.DEFAULTS.maxRepos);
  assert.strictEqual(complete, false, 'a capped walk claimed to be complete');
});

check('discover with no arguments at all still applies every default', () => {
  const cfg = ga.DEFAULTS;
  assert.ok(cfg.depth > 0 && cfg.maxRepos > 0 && cfg.roots.length,
    'the defaults themselves must be usable, since they are now the fallback');
});

check('an explicit override still wins over the default', () => {
  const home = tmp();
  for (let i = 0; i < 5; i += 1) repoAt(path.join(home, 'Projects', `r${i}`));
  assert.strictEqual(ga.discover({ roots: ['~/Projects'], maxRepos: 2, home }).repos.length, 2);
});

check('the deadline is checked between git calls, not only between repositories', () => {
  // Checking only between repositories bounds the loop and not the work: three
  // calls can each start just inside the deadline and finish well past it.
  let calls = 0;
  const row = ga.inspect('/fake', {
    deadline: Date.now() - 1,
    exec: () => { calls += 1; return ''; },
  });
  assert.strictEqual(calls, 0, `ran ${calls} git calls after the deadline had passed`);
  assert.strictEqual(row.changed, null);
  assert.strictEqual(row.commits, null);
});

check('a repository reached before the deadline is still inspected', () => {
  let calls = 0;
  ga.inspect('/fake', { deadline: Date.now() + 10000, exec: () => { calls += 1; return ''; } });
  assert.ok(calls > 0, 'the deadline check swallowed a repository that had time');
});

// -------------------------------------------- saying so when it did not finish ----
//
// Driven through the real hook as a subprocess with HOME overridden, because
// the line reads its own config and expands `~` against the real home
// directory. Calling the exported function directly scanned the actual machine
// and passed or failed depending on what happened to be lying around in
// ~/Projects, which is not a test.

const SESSION_START = path.join(ROOT, 'hooks', 'session-start.js');

function runSessionStart(home, cwd) {
  const out = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: 'test-abc', cwd, source: 'startup' }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  }).stdout;
  try {
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  } catch (_) {
    return '';
  }
}

check('a complete scan that found nothing says nothing about repositories', () => {
  // If the incompleteness notice fired on a clean machine it would appear at
  // the top of every session, and a notice you cannot act on is the fastest
  // way to get a plugin uninstalled.
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  const ctxOut = runSessionStart(home, home);
  assert.doesNotMatch(ctxOut, /repositor/i, ctxOut);
  assert.match(ctxOut, /Today is/, 'the date line should still be there');
});

check('work left in another repository is reported', () => {
  const home = tmp();
  const repo = path.join(home, 'Projects', 'leftovers');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'half finished');
  enableGitActivity(home);
  const out = runSessionStart(home, home);
  assert.match(out, /leftovers/, out);
  assert.match(out, /uncommitted/, out);
});

check('the repository you are standing in is not reported back to you', () => {
  // You can see it. Saying so every session is noise.
  const home = tmp();
  const repo = path.join(home, 'Projects', 'current');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'mine');
  enableGitActivity(home);
  const out = runSessionStart(home, repo);
  assert.doesNotMatch(out, /current.*uncommitted/, out);
});

// --------------------------------------------------- the budget split ----
//
// Both stages take the same absolute deadline, so whatever the session scan
// spends comes out of the git scan. That is deliberate, since the number a
// person notices is the total delay and not how it was divided.
//
// What it cost was the message. `liveSessions` reads the process table, the one
// call here whose cost depends on the machine, and where it ran long enough to
// exhaust the budget the git scan discovered nothing, returned `complete:
// false`, and the hook reported that some repositories could not be checked. On
// a scan that had checked none. True, useless, and shaped exactly like a real
// partial scan.
//
// These are source assertions rather than timing ones on purpose. Reproducing
// it behaviourally needs a machine slow enough to burn 1200ms reading the
// process table, which is not something a test can ask for and not something
// worth faking with a sleep. What can be pinned is that the first stage is
// capped, which is the property that stops the starvation.

const SESSION_START_SRC = fs.readFileSync(path.join(ROOT, 'hooks', 'session-start.js'), 'utf8');

check('the session scan is not handed the whole budget', () => {
  // The regression: `deadline: started + BUDGET_MS` on the liveSessions call
  // leaves the git scan whatever happens to be left, including nothing.
  const liveCall = SESSION_START_SRC.match(/liveSessions\(\{[^}]*\}\)/s);
  assert.ok(liveCall, 'could not find the liveSessions call');
  assert.doesNotMatch(
    liveCall[0], /started \+ BUDGET_MS/,
    'liveSessions must not take the full budget, or a slow process table starves the git scan',
  );
  assert.match(liveCall[0], /started \+ SESSIONS_BUDGET_MS/, liveCall[0]);
});

check('the git scan keeps the full absolute deadline', () => {
  // It has to stay absolute. A relative one would push the total past BUDGET_MS,
  // and picking up whatever the session scan did not use is the point.
  assert.match(SESSION_START_SRC, /gitActivityLine\(cwd, started \+ BUDGET_MS\)/);
});

check('the split leaves the git scan a usable share and stays inside the budget', () => {
  const budget = Number(SESSION_START_SRC.match(/const BUDGET_MS = (\d+)/)[1]);
  const share = SESSION_START_SRC.match(/const SESSIONS_BUDGET_MS = Math\.round\(BUDGET_MS \* ([\d.]+)\)/);
  assert.ok(share, 'SESSIONS_BUDGET_MS should stay a stated fraction of BUDGET_MS');
  const sessions = Math.round(budget * Number(share[1]));
  assert.ok(sessions < budget, 'the session scan must not be able to use the whole budget');
  assert.ok(budget - sessions >= 300,
    `the git scan is guaranteed only ${budget - sessions}ms, which is not enough to discover anything`);
});

check('an exhausted deadline still reports incomplete rather than clean', () => {
  // The other half of the contract, and the half that must not change. Capping
  // the session scan makes starvation unlikely, not impossible, so a scan that
  // ran out of time still has to say so rather than return a quiet all-clear.
  const out = ga.scan({ cwd: process.cwd(), config: {}, deadline: Date.now() - 1 });
  assert.strictEqual(out.complete, false, 'an expired deadline is not a complete scan');
  assert.strictEqual(out.repos.length, 0);
});

// ------------------------------------------- what the notice tells you to do ----

check('the notice never names a command that does not exist', () => {
  // It said "Run /sessions". There is no such skill, here or anywhere. There is
  // a `sessions` subcommand on the CLI, presumably where the name came from,
  // which the model has no path to and could not invoke as a slash command
  // anyway. The one actionable sentence in the notice pointed at nothing.
  //
  // Comment lines come out before the literals are matched, and the order
  // matters. An apostrophe in prose, "git's relative form", opens a quote that
  // closes at the next apostrophe several lines later, and everything between
  // reads as a string. The first version of this check failed on the comment
  // explaining the fix, which is a lint that fails when you document why.
  const code = SESSION_START_SRC
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const skills = new Set(fs.readdirSync(path.join(ROOT, 'skills')));
  const literals = code.match(/'([^'\\]*(?:\\.[^'\\]*)*)'/g) || [];
  const named = new Set();
  for (const literal of literals) {
    for (const hit of literal.match(/\/[a-z][a-z-]{2,}/g) || []) named.add(hit.slice(1));
  }
  const invented = [...named].filter((name) => !skills.has(name));
  assert.deepStrictEqual(invented, [], `notice names ${invented.join(', ')}, which is not a skill`);
});

// --------------------------------------------------- the order of the list ----
//
// The caller names three repositories and says "and N more", so which three it
// names is a decision whether or not anyone made it. It was filesystem walk
// order under a header claiming newest activity first.

const orderedScan = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-order-'));
  const make = (name) => { fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true }); };
  ['a-recent-commit', 'b-dirty', 'c-older-commit'].forEach(make);

  const exec = (cmd, args) => {
    const repo = args[1];
    const name = path.basename(repo);
    if (args.includes('--show-current')) return 'main\n';
    if (args.includes('--porcelain')) return name === 'b-dirty' ? ' M wip.js\n' : '';
    if (args.includes('log')) {
      if (name === 'a-recent-commit') return 'aaa|1753600000|1 hour ago|recent\n';
      if (name === 'c-older-commit') return 'ccc|1753500000|9 hours ago|older\n';
      return '';
    }
    return '';
  };

  return ga.scan({ cwd: null, config: { roots: [dir] }, exec }).notable.map((r) => r.name);
};

check('uncommitted work is named before committed work', () => {
  // A commit is saved. Uncommitted changes are what gets lost when a window
  // closes, which is the case this check exists for, so it takes the first slot
  // even though its repository has no recent commit at all.
  assert.strictEqual(orderedScan()[0], 'b-dirty', orderedScan().join(', '));
});

check('within a group, the newest commit comes first', () => {
  const order = orderedScan();
  assert.ok(
    order.indexOf('a-recent-commit') < order.indexOf('c-older-commit'),
    `expected the 1-hour-old commit before the 9-hour-old one, got ${order.join(', ')}`,
  );
});

check('the order does not depend on the order the walk found them', () => {
  // The regression, stated directly: run it twice and the answer is the same,
  // and it is the same answer as the rule above rather than whatever the
  // filesystem returned.
  assert.deepStrictEqual(orderedScan(), orderedScan());
  assert.deepStrictEqual(orderedScan(), ['b-dirty', 'a-recent-commit', 'c-older-commit']);
});

// ------------------------------------- an overrun in the last repository ----
//
// `scanned` was only ever set false by the next iteration's top-of-loop check.
// The last repository has no next iteration, so an inspect that ran past the
// deadline there produced an all-null row, which the notable filter dropped,
// while `complete` still said everything had been checked.
//
// That is the exact failure this module was written to prevent, reached by a
// different route: uncommitted work in that repository would be omitted from a
// notice claiming nothing was left anywhere.

const scanWith = (repoNames, execFor, deadline) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-cut-'));
  repoNames.forEach((n) => fs.mkdirSync(path.join(dir, n, '.git'), { recursive: true }));
  return ga.scan({ cwd: null, config: { roots: [dir] }, exec: execFor, deadline });
};

check('inspect reports that it was cut short, not just that it found nothing', () => {
  // The row already knew. Nothing carried it out.
  const row = ga.inspect('/fake', { deadline: Date.now() - 1, exec: () => '' });
  assert.strictEqual(row.cut, true);
  assert.strictEqual(row.changed, null);
});

check('a normal inspect is not marked as cut', () => {
  const row = ga.inspect('/fake', {
    deadline: Date.now() + 10000,
    exec: (cmd, args) => (args.includes('--porcelain') ? ' M a.js\n' : ''),
  });
  assert.strictEqual(row.cut, false);
  assert.strictEqual(row.changed, 1);
});

check('running out of time inside the last repository is not reported as complete', () => {
  // The reported bug, and it has to expire DURING the inspect to reproduce it.
  //
  // An already-expired deadline is caught by the top-of-loop check and proves
  // nothing: that path always worked. The failure needs the loop check to pass
  // and the budget to run out between git calls, on a repository with no next
  // iteration behind it to notice.
  //
  // So the first call outlives the remaining budget. branch returns, status and
  // log are skipped, and the row comes back all nulls, which the notable filter
  // drops. Before the fix, `complete` still said true.
  const burn = (ms) => { const until = Date.now() + ms; while (Date.now() < until); };
  const slowFirstCall = (cmd, args) => {
    if (args.includes('--show-current')) { burn(30); return 'main\n'; }
    return ' M wip.js\n';
  };
  const out = scanWith(['only'], slowFirstCall, Date.now() + 15);

  assert.deepStrictEqual(out.notable, [], 'the row should have been dropped, as it was in the report');
  assert.strictEqual(out.complete, false, 'a scan cut short must not claim to be complete');
});

check('a repository git cannot be read leaves the scan incomplete', () => {
  // Same all-null row, different cause, same silent all-clear.
  const out = scanWith(['broken'], () => { throw new Error('nope'); });
  assert.strictEqual(out.complete, false);
  assert.deepStrictEqual(out.notable, []);
});

check('a clean readable scan is still complete', () => {
  // The check has to stay quiet when there is genuinely nothing to say, or the
  // caveat becomes the thing people learn to ignore.
  const out = scanWith(['tidy'], (cmd, args) => (args.includes('--show-current') ? 'main\n' : ''));
  assert.strictEqual(out.complete, true);
  assert.deepStrictEqual(out.notable, []);
});

check('the caveat reaches the notice, not just the flag', () => {
  // End to end through the real hook, because the value being right and the
  // sentence being right are different things and that gap is most of why this
  // file exists.
  //
  // Goes through the unreadable path rather than the timeout, since BUDGET_MS
  // is a module constant with no way in from a test. A directory holding an
  // empty .git looks like a repository to discover and fails every git command,
  // which produces the same all-null row the timeout produces. What is pinned
  // is that an incomplete scan reaches the notice. That the timeout produces an
  // incomplete scan is pinned separately above.
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Projects', 'notarepo', '.git'), { recursive: true });
  enableGitActivity(home);
  const out = runSessionStart(home, home);
  assert.match(out, /could not be checked/, `expected the caveat, got: ${out}`);
});

// ------------------------------------------------ off until asked for ----
//
// The one default here that is not about cost. It is 86ms and bounded. The
// reason it is off is that installing a plugin about sessions and handoffs
// should not also start walking a directory of your unrelated work.
//
// The parallel-session check reads the process table and stays on, because it
// looks for Claude Code sessions, which is this plugin's own subject. The line
// is what each one looks at, not how expensive it is.

const cfg = require(path.join(ROOT, 'scripts', 'config.js'));

check('the git scan is off unless somebody asks for it', () => {
  assert.strictEqual(cfg.DEFAULTS.gitActivity.enabled, false);
  assert.strictEqual(cfg.load(tmp()).gitActivity.enabled, false, 'no config file means off');
});

check('a fresh install says nothing about repositories', () => {
  // End to end, with real work sitting in a real repository. Before, this
  // reported it. The point is not that the notice is wrong, it is that nobody
  // asked for it yet.
  const home = tmp();
  const repo = path.join(home, 'Projects', 'untouched');
  fs.mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'left behind');
  const out = runSessionStart(home, home);
  assert.doesNotMatch(out, /repositor/i, out);
  assert.match(out, /Today is/, 'the rest of the notice still runs');
});

check('the parallel-session check is still on by default', () => {
  // Turning off the wrong one would be a quiet way to lose the check this
  // plugin is mostly about.
  assert.strictEqual(cfg.DEFAULTS.gitActivity.enabled, false);
  assert.ok(!('enabled' in (cfg.DEFAULTS.contextWarnings || {})) || cfg.DEFAULTS.contextWarnings.enabled !== false);
  assert.doesNotMatch(SESSION_START_SRC, /liveSessions[\s\S]{0,200}enabled === false/,
    'the session check should not have picked up an off switch by accident');
});

check('naming any setting turns it on, so a config is never silently ignored', () => {
  // `load` replaces whole keys rather than merging into them, so a config that
  // sets `roots` drops the default `enabled: false` and the scan runs.
  //
  // Pinned because it is load-bearing and invisible. If `load` ever starts deep
  // merging, this config would be read, accepted, and quietly do nothing, which
  // is the failure mode this plugin keeps being written against. Better it
  // breaks here.
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session.config.json'),
    JSON.stringify({ gitActivity: { roots: ['~/code'] } }),
  );
  const loaded = cfg.load(home);
  assert.notStrictEqual(loaded.gitActivity.enabled, false,
    'setting roots without `enabled` must not leave the scan off');
  assert.deepStrictEqual(loaded.gitActivity.roots, ['~/code']);
});

check('an explicit false still wins', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'session.config.json'),
    JSON.stringify({ gitActivity: { enabled: false, roots: ['~/code'] } }),
  );
  assert.strictEqual(cfg.load(home).gitActivity.enabled, false);
});

process.stdout.write(`\n${failures === 0 ? 'all passed' : `${failures} failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
