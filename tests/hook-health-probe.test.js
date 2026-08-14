#!/usr/bin/env node
// The probe that says which hook interpreter went missing.
//
// Run: node tests/hook-health-probe.test.js
//
// Written after the 2026-08-07 UserPromptSubmit entry, which recorded that a
// hook failed with exit code 127 and not which hook. Two commands run on that
// event on this machine, either can 127, Claude Code writes no UserPromptSubmit
// hook runs to the transcript, and the session that filed the report left none
// either. Identifying it four days later took a whole session and still stopped
// short of proof.
//
// This suite runs the probe rather than reading it. That distinction is the one
// hook-executable.test.js was written about: a hook tested by a route the shell
// never takes is a hook nobody has tested. Every case below drives it the way
// Claude Code does, through its shebang with an event on stdin, and asserts on
// the file it leaves behind.
//
// The environment is stripped with env -i for the failure cases. That is the
// whole point: `node` is on PATH here through a shell profile, so the only
// honest way to test "node is missing" is to take it away.
//
// Taking it away means building the PATH rather than trimming one. This used to
// point at /usr/bin:/bin on the reasoning that node lives under ~/.local/bin,
// which is true on one machine and false on Debian, Ubuntu and most CI images,
// where the package installs /usr/bin/node. There the negative cases quietly
// kept node and three checks failed for everybody except the author. Below,
// PATH is a directory this file fills with links to the handful of utilities
// the probe actually calls, so node is absent because it was never put there.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'plugins', 'build-loop', 'hooks', 'hook-health-probe.sh');

const EXPECTED_CHECKS = 25;

// The probe calls these and nothing else. `sh` is not among them: the kernel
// reads the shebang and runs /bin/sh by absolute path, so PATH never decides
// which interpreter starts.
//
// This list used to hold sed, head, grep and tail as well. They went when the
// session id and the change-of-state lookup moved into shell expansions: a
// probe that asks external commands whether it has already reported a problem
// stops deduplicating on the machines where those commands are missing, which
// are the machines it exists for.
const PROBE_NEEDS = ['date', 'mkdir'];

// First match for `name` on this process's PATH, or null. A plain search rather
// than `which`, so the lookup does not itself depend on a utility being found.
function locate(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) { /* next directory */ }
  }
  return null;
}

// A PATH with the probe's utilities and deliberately no node, and a second one
// holding only node. Which of the two a case gets is the whole experiment, so
// neither is allowed to inherit anything.
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-bin-'));
const NODE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-node-'));

const unlocatable = [];
for (const tool of PROBE_NEEDS) {
  const found = locate(tool);
  if (!found) { unlocatable.push(tool); continue; }
  fs.symlinkSync(found, path.join(BIN, tool));
}
fs.symlinkSync(process.execPath, path.join(NODE_BIN, 'node'));

if (unlocatable.length > 0) {
  // Stop rather than run: every case below would fail for a reason that has
  // nothing to do with the probe, which is the failure this file was rewritten
  // to stop producing.
  console.log(
    `  FAIL  the test environment can supply the utilities the probe calls\n`
    + `        not found on PATH: ${unlocatable.join(', ')}. The negative cases `
    + `build a PATH from these, so they cannot run without them.`
  );
  console.log('\n0 checks, 1 failed');
  process.exit(1);
}

let failed = 0;
let ran = 0;
function check(what, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${what}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${what}\n        ${error.message}`);
  }
}

const SESSION = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const OTHER_SESSION = 'cccccccc-4444-5555-6666-dddddddddddd';

function eventFor(sid) {
  return JSON.stringify({
    session_id: sid,
    transcript_path: '/dev/null',
    cwd: '/tmp',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'anything',
  });
}

// A HOME per case, so one case cannot read another's log. The probe writes to
// $HOME/.claude/build-loop/hook-health.log and nothing else.
function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
}

function logPath(home) {
  return path.join(home, '.claude', 'build-loop', 'hook-health.log');
}

function readLog(home) {
  const p = logPath(home);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Drive the probe exactly as a shell would: execute the file, let the shebang
// pick the interpreter, hand it the event on stdin. `env` builds the whole
// environment from scratch so a PATH inherited from this process cannot quietly
// rescue a case that is meant to fail.
// `pathOverride` is for the cases that are about PATH itself: a PATH holding
// the home directory, one holding wildcards, one that is empty. They used to
// call spawnSync by hand for that, which is how the pin below missed them and
// how the suite came to pass here and fail everywhere else. Varying one field
// is not a reason to rebuild the environment.
// `spawnOptions` is merged into the spawn itself rather than the environment.
// One case drops to an unprivileged uid to make the log genuinely unwritable,
// which is a property of the process and not of what it can see.
function runProbe(home, {
  withNode, env = {}, session = SESSION, pathOverride, spawnOptions = {},
} = {}) {
  const parts = ['-i', `HOME=${home}`];
  const searchPath = pathOverride !== undefined
    ? pathOverride
    : (withNode ? `${NODE_BIN}:${BIN}` : BIN);
  parts.push(`PATH=${searchPath}`);

  // The probe asks bin/hook-node whether node can be found, and that search
  // reaches past PATH into ~/.local/bin, Homebrew, /usr/local and /usr/bin.
  // HOME is a sandbox here so the first is empty, but the others are real
  // absolute paths, and whether they hold a node is a property of whoever runs
  // this suite rather than of the case being tested. $CLAUDE_HOOK_NODE is
  // authoritative to the launcher, so pinning it is what makes "node is
  // missing" mean the same thing on every machine.
  //
  // This is the trap the header above describes, arriving by a new route: a
  // negative case that quietly keeps node passes for the author and fails for
  // everybody else. Pushed before the caller's own entries so a case can still
  // override it, since `env` takes the last assignment of a name.
  parts.push(withNode
    ? `CLAUDE_HOOK_NODE=${path.join(NODE_BIN, 'node')}`
    : 'CLAUDE_HOOK_NODE=/nonexistent/node');

  for (const [k, v] of Object.entries(env)) parts.push(`${k}=${v}`);
  parts.push(PROBE);
  return spawnSync('env', parts, {
    input: eventFor(session), encoding: 'utf8', ...spawnOptions,
  });
}

// --- the interpreter it cannot report on itself ----------------------------

check('every case starts the probe through runProbe', () => {
  // The 2026-08-14 review. runProbe learned to pin $CLAUDE_HOOK_NODE so that
  // "node is missing" means the same thing everywhere, but seven invocations
  // called spawnSync by hand to vary PATH and inherited no pin. On this machine
  // node sits at none of the absolute paths the launcher searches, so the suite
  // was green here and six checks failed on Debian, Ubuntu, Homebrew and most
  // CI images, which is the trap in this file's own header arriving by a new
  // route for the second time.
  //
  // The pin cannot be enforced by asking each case to remember it, so this asks
  // instead that there is only one door.
  const source = fs.readFileSync(__filename, 'utf8');
  const callSites = source.split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => /spawnSync\(/.test(line))
    .filter(({ line }) => !/require\(/.test(line))
    .filter(({ line }) => !/^\s*\/\//.test(line));

  assert.strictEqual(callSites.length, 1,
    'the probe is started from more than one place, so the $CLAUDE_HOOK_NODE pin '
    + 'does not reach every case and the suite passes or fails by machine:\n        '
    + `${callSites.map((c) => `line ${c.n}: ${c.line.trim()}`).join('\n        ')}\n`
    + '        Add a runProbe option instead of spawning it directly.');
});

check('the probe is not written in node', () => {
  // A node script cannot tell you node is missing. If this file is ever
  // rewritten in the language of the thing it watches, it stops working in the
  // only situation it was built for, and every test still passes.
  const shebang = fs.readFileSync(PROBE, 'utf8').split('\n')[0];
  assert.ok(
    /^#!\/bin\/sh$/.test(shebang),
    `the probe's shebang is "${shebang}". It has to be /bin/sh: it exists to `
    + 'report a missing interpreter, so it cannot depend on one that can go '
    + 'missing.'
  );
});

check('the probe is executable, in the index and on disk', () => {
  // Same contract hook-executable.test.js enforces. Restated here because a
  // .sh hook is the first of its kind in this repository and the walker there
  // has only ever seen .js files.
  fs.accessSync(PROBE, fs.constants.X_OK);
  const mode = execFileSync('git', ['ls-files', '-s', '--', PROBE], { cwd: ROOT, encoding: 'utf8' });
  assert.ok(
    mode.startsWith('100755'),
    `the probe is mode ${mode.slice(0, 6)} in the git index, so a fresh clone `
    + 'cannot run it'
  );
});

check('hooks.json runs it on UserPromptSubmit', () => {
  const hooks = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'plugins', 'build-loop', 'hooks', 'hooks.json'), 'utf8')
  );
  const ups = JSON.stringify(hooks.hooks.UserPromptSubmit || []);
  assert.ok(
    ups.includes('hook-health-probe.sh'),
    'the probe is not registered on UserPromptSubmit, which is the event whose '
    + 'failures leave no transcript record'
  );
  assert.ok(
    ups.includes('notice-correction.js'),
    'the probe replaced notice-correction.js rather than running beside it'
  );
});

// --- it catches the thing it was built for ---------------------------------

check('a missing node is recorded', () => {
  const home = sandbox();
  const r = runProbe(home, { withNode: false });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}, it must never fail a prompt`);
  const log = readLog(home);
  assert.ok(log.includes('MISSING'), `nothing was recorded. log: ${JSON.stringify(log)}`);
  assert.ok(log.includes('node'), `the log does not name node. log: ${JSON.stringify(log)}`);
});

check('a session where PATH lacks node but the launcher finds it is not reported broken', () => {
  // This is every GUI-launched host on this machine, and the reason the probe
  // stopped asking PATH. Codex started from the Dock gets a bare PATH with no
  // node on it, and since 2026-08-13 its hooks run anyway, because hooks.json
  // starts them through bin/hook-node. A probe still asking `command -v node`
  // wrote MISSING on the first prompt of every one of those sessions while the
  // hooks it was reporting on were running perfectly.
  //
  // Node is reachable here only through $CLAUDE_HOOK_NODE, exactly as it is
  // reachable on that machine only through ~/.local/bin. PATH holds the
  // probe's utilities and no node at all.
  const home = sandbox();
  const r = runProbe(home, {
    withNode: false,
    env: { CLAUDE_HOOK_NODE: path.join(NODE_BIN, 'node') },
  });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}, it must never fail a prompt`);
  assert.strictEqual(
    readLog(home), '',
    'the probe called a session broken because node was not on PATH, but the '
    + 'launcher resolves node and the hooks run. The log now reports a fault '
    + 'that is not there, which is how a diagnostic gets muted and then cannot '
    + 'report the fault that is.'
  );
});

check('the probe decides node health through the launcher, not through PATH', () => {
  // The check above passes on a healthy tree whether the probe asks the right
  // question or not, as long as the answers happen to agree. This reads the
  // source, because the two questions agree on most machines and disagree on
  // exactly the ones this work is for.
  const source = fs.readFileSync(PROBE, 'utf8');
  assert.ok(
    source.includes('--which'),
    'the probe does not ask bin/hook-node --which, so it is deciding hook '
    + 'health from something other than what starts the hooks'
  );
  const barePathCheck = /^\s*command -v node[^\n]*\|\|\s*missing=/m;
  const lines = source.split('\n');
  const bareLine = lines.findIndex((l) => barePathCheck.test(l));
  assert.ok(
    bareLine === -1 || lines.slice(0, bareLine).some((l) => l.includes('launcher')),
    'the probe asks `command -v node` without having asked the launcher first, '
    + 'so a GUI-launched session is reported broken while its hooks run'
  );
});

check('an interpreter setting pointing at a directory is reported, not accepted', () => {
  // The 2026-08-14 review. `[ -x path ]` is true for a directory, because a
  // directory's execute bit is its search bit, so CLAUDE_HOOK_NODE naming the
  // folder that holds node was taken as node. Run mode then died with "is a
  // directory" and exit 126, which Claude Code discards, while --which printed
  // the directory and exited 0. Every hook in all five plugins was dead and
  // this log said everything was fine, which is this probe's purpose inverted
  // by a single mistyped setting.
  const home = sandbox();
  const r = runProbe(home, {
    withNode: false,
    env: { CLAUDE_HOOK_NODE: os.tmpdir() },   // executable, and not a program
  });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}, it must never fail a prompt`);
  const log = readLog(home);
  assert.ok(log.includes('MISSING'),
    'a directory was accepted as the interpreter, so the hooks are dead and the '
    + `log says nothing. log: ${JSON.stringify(log)}`);
  assert.ok(log.includes('hook_node=set-unusable'),
    `the line does not say the override was the cause. log: ${JSON.stringify(log)}`);
});

check('a failure line names what was searched, and never the override value', () => {
  // The evidence has to match the question. Health is decided by the launcher,
  // which looks in six places, so a line reporting only PATH sends somebody to
  // fix a PATH that was never involved. build-loop/README.md promises this line
  // names what was searched.
  //
  // The override's value is deliberately absent. It is a path on somebody's
  // machine and this file is written to be pasted into a bug report, which is
  // the same reason the home directory is masked out of the PATH field.
  const secret = path.join(sandbox(), 'a-private-looking-path');
  const home = sandbox();
  runProbe(home, { withNode: false, env: { CLAUDE_HOOK_NODE: secret } });
  const withOverride = readLog(home);
  assert.ok(withOverride.includes('searched=$CLAUDE_HOOK_NODE'),
    `the line does not name the override as the scope. log: ${JSON.stringify(withOverride)}`);
  assert.ok(!withOverride.includes(secret),
    `the override's value was written to the log: ${JSON.stringify(withOverride)}`);

  // With no override the scope is the launcher's whole list, taken from the
  // launcher itself rather than restated here, so the two cannot drift.
  const plain = sandbox();
  runProbe(plain, { withNode: false, env: { CLAUDE_HOOK_NODE: '' } });
  const line = readLog(plain);
  assert.ok(/searched=\S*PATH\S*/.test(line),
    `the line does not name the searched scope. log: ${JSON.stringify(line)}`);
  assert.ok(line.includes('~/.local/bin/node'),
    'the searched scope omits the fixed locations the launcher looks in, so the '
    + `line still implies PATH was the whole question. log: ${JSON.stringify(line)}`);
  assert.ok(/searched=[^ ]+ /.test(line),
    `the searched field contains a space and has split the log line: ${JSON.stringify(line)}`);
});

check('a working environment records nothing', () => {
  const home = sandbox();
  const r = runProbe(home, { withNode: true });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(
    readLog(home), '',
    'the probe wrote a line while everything was fine, which is how a log stops '
    + 'being read'
  );
});

check('a stale cmux binary path is recorded', () => {
  // The specific shape an app update leaves behind: an absolute path exported
  // at launch that no longer resolves. cmux hooks 127 on every prompt until
  // the session restarts.
  const home = sandbox();
  const r = runProbe(home, {
    withNode: true,
    env: { CMUX_CLAUDE_HOOK_CMUX_BIN: path.join(home, 'gone', 'cmux') },
  });
  assert.strictEqual(r.status, 0);
  const log = readLog(home);
  assert.ok(log.includes('cmux_bin=stale'), `the stale path was not recorded. log: ${JSON.stringify(log)}`);
});

check('cmux is not reported on a machine that does not run it', () => {
  // Without this the probe writes a line about missing software on every
  // prompt for every user who does not use cmux.
  const home = sandbox();
  runProbe(home, { withNode: true });
  assert.ok(
    !readLog(home).includes('cmux'),
    'cmux was reported absent with no sign the session is running inside it'
  );
});

// --- it stays readable -----------------------------------------------------

check('an unchanged state is not written twice', () => {
  // A line per prompt for the length of a broken session buries the transition
  // that matters under thousands of copies of itself.
  const home = sandbox();
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: false });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 1,
    `three identical states produced ${lines.length} lines:\n        ` + lines.join('\n        ')
  );
});

check('a recovery is recorded once', () => {
  const home = sandbox();
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: true });
  runProbe(home, { withNode: true });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 2,
    `expected one failure and one recovery, got ${lines.length}:\n        ` + lines.join('\n        ')
  );
  assert.ok(lines[0].includes('MISSING'), 'the first line is not the failure');
  assert.ok(lines[1].includes('RECOVERED'), 'the recovery was not recorded');
});

check('a healthy session files no recovery for a fault it never saw', () => {
  // Recovery used to mean "this file has held a failure at some point", which
  // every session after the first fault satisfies. Each new one wrote its own
  // RECOVERED line and the next one did it again, so the single transition the
  // log exists to show ended up buried under reports of a thing that never
  // happened. It has to mean "the last thing this session recorded was broken".
  const home = sandbox();
  runProbe(home, { withNode: false, session: SESSION });
  runProbe(home, { withNode: true, session: SESSION });
  const afterFirstSession = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    afterFirstSession.length, 2,
    'the setup did not produce one failure and one recovery, so what follows '
    + 'proves nothing'
  );

  runProbe(home, { withNode: true, session: OTHER_SESSION });
  runProbe(home, { withNode: true, session: 'eeeeeeee-7777-8888-9999-ffffffffffff' });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 2,
    `two healthy sessions added ${lines.length - 2} line(s) about somebody `
    + `else's fault:\n        ` + lines.join('\n        ')
  );
});

check('two sessions sharing a HOME do not write a line each per prompt', () => {
  // One session broken and one healthy, prompting in turn. Judged against
  // whichever line landed last, each reads as a transition away from the other
  // and they trade lines for as long as both stay open, which is the flooding
  // the change-of-state rule exists to prevent.
  const home = sandbox();
  runProbe(home, { withNode: false, session: SESSION });
  runProbe(home, { withNode: true, session: OTHER_SESSION });
  runProbe(home, { withNode: false, session: SESSION });
  runProbe(home, { withNode: true, session: OTHER_SESSION });
  runProbe(home, { withNode: false, session: SESSION });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 1,
    `five prompts across two sessions produced ${lines.length} lines:\n        `
    + lines.join('\n        ')
  );
  assert.ok(lines[0].includes('MISSING'), 'the one line recorded is not the failure');
});

check('PATH is recorded on a failure and left off a recovery', () => {
  // Exit 127 is "not found", so the places that were searched are the evidence
  // and a failure line without them names a symptom. On a recovery it explains
  // nothing, and this file is one somebody pastes into a bug report.
  const home = sandbox();
  runProbe(home, { withNode: false });
  runProbe(home, { withNode: true });
  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.ok(
    lines[0].includes(`path=${BIN}`),
    `the failure line does not say where it looked:\n        ${lines[0]}`
  );
  assert.ok(
    !lines[1].includes('path='),
    `the recovery line carries the machine's PATH for no diagnostic gain:\n        ${lines[1]}`
  );
});

check('a failure line names the search path without naming the machine', () => {
  // CWE-532. The directories are the evidence for a 127; the home directory
  // inside them is a username and a layout, which identify whose machine this
  // is and diagnose nothing. The file is meant to be pasted into a bug report,
  // so the two are separated rather than the whole field being dropped.
  const home = sandbox();
  const inHome = path.join(home, '.local', 'bin');
  fs.mkdirSync(inHome, { recursive: true });
  for (const tool of PROBE_NEEDS) fs.symlinkSync(locate(tool), path.join(inHome, tool));

  const r = runProbe(home, { pathOverride: inHome });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}`);

  const line = readLog(home).trim();
  assert.ok(
    line.includes('path=~/.local/bin'),
    `the search path was not recorded, or was not reduced to ~:\n        ${line}`
  );
  assert.ok(
    !line.includes(home),
    `the line carries the home directory, so it names the user:\n        ${line}`
  );
});

check('a home directory that reads as a regular expression is masked, in silence', () => {
  // The first version of the masking passed HOME into sed, where data is a
  // pattern. A bracket in a home directory produced "unbalanced brackets" on
  // stderr and no substitution, so a probe whose contract is that it never
  // speaks spoke, on the one path where the session is already broken. Both
  // halves are asserted: the mask still happens, and nothing is said.
  const home = path.join(sandbox(), 'ho[me');
  const inHome = path.join(home, 'bin');
  fs.mkdirSync(inHome, { recursive: true });
  for (const tool of PROBE_NEEDS) fs.symlinkSync(locate(tool), path.join(inHome, tool));

  const r = runProbe(home, { pathOverride: inHome });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}`);
  assert.strictEqual(
    r.stderr, '',
    `the probe wrote to stderr: ${JSON.stringify(r.stderr)}`
  );

  const line = readLog(home).trim();
  assert.ok(
    line.includes('path=~/bin'),
    `a home directory holding a bracket defeated the mask:\n        ${line}`
  );
});

check('a log it cannot write to is not something it complains about', () => {
  // A shell applies redirections left to right, so `>> log 2>/dev/null` silences
  // stderr only after the append has already failed and printed. The order is
  // the fix and this is the guard on it.
  //
  // The unwritable log here is a directory rather than a file with its write
  // bit off, because a suite running as root, which is most CI images, would
  // write straight through the permission bit and the case would prove nothing
  // in the place it most needs to.
  const home = sandbox();
  fs.mkdirSync(logPath(home), { recursive: true });

  const r = runProbe(home, { withNode: false });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}, it must never fail a prompt`);
  assert.strictEqual(
    r.stderr, '',
    'a log it cannot write to made the probe speak, on a machine that is '
    + `already having a bad day: ${JSON.stringify(r.stderr)}`
  );
  assert.strictEqual(r.stdout, '', `the probe wrote to stdout: ${JSON.stringify(r.stdout)}`);
});

check('a log it cannot read is not something it complains about or rewrites', () => {
  const home = sandbox();
  const dir = path.dirname(logPath(home));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logPath(home), 'existing state\n', { mode: 0o600 });

  let r;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // Root ignores ordinary read bits. Run only this child as the conventional
    // nobody uid so the case still proves the redirection behavior in CI.
    fs.chmodSync(home, 0o755);
    fs.chmodSync(path.join(home, '.claude'), 0o755);
    fs.chmodSync(dir, 0o777);
    r = runProbe(home, { pathOverride: BIN, spawnOptions: { uid: 65534, gid: 65534 } });
  } else {
    fs.chmodSync(logPath(home), 0o000);
    r = runProbe(home, { withNode: false });
  }
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}`);
  assert.strictEqual(r.stderr, '', `the unreadable log made the probe speak: ${JSON.stringify(r.stderr)}`);
  assert.strictEqual(r.stdout, '', `the probe wrote to stdout: ${JSON.stringify(r.stdout)}`);
  fs.chmodSync(logPath(home), 0o600);
  assert.strictEqual(
    readLog(home), 'existing state\n',
    'the probe could not read the previous state but appended another one anyway'
  );
});

check('PATH entries containing wildcards and empty entries are recorded literally', () => {
  const home = sandbox();
  const wildcard = path.join(home, 'opt', 'a*');
  fs.mkdirSync(path.join(home, 'opt', 'aa'), { recursive: true });
  fs.mkdirSync(path.join(home, 'opt', 'ab'), { recursive: true });
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });

  const suppliedPath = `:${wildcard}::${BIN}:`;
  const r = runProbe(home, { pathOverride: suppliedPath });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}`);
  const line = readLog(home).trim();
  assert.ok(
    line.includes(`path=:~/opt/a*::${BIN}:`),
    `PATH was expanded or empty entries were dropped:\n        ${line}`
  );
  assert.ok(!line.includes('~/opt/aa') && !line.includes('~/opt/ab'), `wildcard entry expanded:\n        ${line}`);
});

check('an empty PATH keeps session ids separate without cat', () => {
  const home = sandbox();
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });

  for (const session of [SESSION, OTHER_SESSION, SESSION, OTHER_SESSION]) {
    const r = runProbe(home, { pathOverride: '', session });
    assert.strictEqual(r.status, 0, `session ${session} exited ${r.status}`);
    assert.strictEqual(r.stderr, '', `session ${session} spoke: ${JSON.stringify(r.stderr)}`);
  }

  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, `two broken sessions produced ${lines.length} lines:\n        ${lines.join('\n        ')}`);
  assert.ok(lines.some((line) => line.includes(`session=${SESSION} `)), 'the first session id was lost');
  assert.ok(lines.some((line) => line.includes(`session=${OTHER_SESSION} `)), 'the second session id was lost');
});

check('an empty PATH still produces a line, and still produces no noise', () => {
  // The worst machine this can run on, and the one it was written for: nothing
  // resolves, not even the utilities the probe itself calls. It used to say
  // three "No such file or directory" lines and record nothing, because
  // `mkdir -p || exit 0` gave up when mkdir was the thing that could not be
  // found, so the report was thrown away on the only machine that needed it.
  // printf is a builtin, so with the directory already there the line lands.
  const home = sandbox();
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });

  const r = runProbe(home, { pathOverride: '' });
  assert.strictEqual(r.status, 0, `the probe exited ${r.status}`);
  assert.strictEqual(r.stderr, '', `the probe spoke: ${JSON.stringify(r.stderr)}`);

  const line = readLog(home).trim();
  assert.ok(
    line.includes('MISSING') && line.includes('node'),
    `nothing was recorded on a machine where nothing resolves:\n        ${JSON.stringify(line)}`
  );
  assert.ok(
    !line.startsWith(' '),
    `the timestamp field is empty, so every field after it has shifted:\n        ${line}`
  );
});

check('an empty PATH records the fault once, not once per prompt', () => {
  // The check above runs the probe a single time, so it could not see this.
  // The change-of-state lookup was a grep and a tail, which is a probe asking
  // two external commands whether it has already reported that external
  // commands are missing. With them gone the lookup returned nothing, no line
  // ever matched, and the same line landed on every prompt: unreadable, on the
  // one machine the file was written for.
  const home = sandbox();
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });

  for (let i = 0; i < 4; i += 1) {
    const r = runProbe(home, { pathOverride: '' });
    assert.strictEqual(r.status, 0, `prompt ${i + 1} exited ${r.status}`);
    assert.strictEqual(r.stderr, '', `prompt ${i + 1} spoke: ${JSON.stringify(r.stderr)}`);
  }

  const lines = readLog(home).trim().split('\n').filter(Boolean);
  assert.strictEqual(
    lines.length, 1,
    `four prompts on a machine where nothing resolves produced ${lines.length} `
    + `lines:\n        ` + lines.join('\n        ')
  );
});

if (ran !== EXPECTED_CHECKS) {
  failed += 1;
  console.log(
    `  FAIL  the file runs the number of checks it expects to\n`
    + `        ran ${ran}, expected ${EXPECTED_CHECKS}. If you added or removed a `
    + `check, move EXPECTED_CHECKS. If you did not, one has gone missing.`
  );
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
