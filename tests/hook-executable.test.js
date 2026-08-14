#!/usr/bin/env node
// Every hook a hooks.json runs directly has to be executable.
//
// Run: node tests/hook-executable.test.js
//
// The bug, on 2026-08-04: consistency-lint.js shipped at mode 100644 while
// every other hook in the repository was 100755. A hooks.json entry of
// `"${CLAUDE_PLUGIN_ROOT}"/hooks/x.js` is a shell command, so it needs the
// executable bit and a shebang. Without the bit the shell answers "Permission
// denied", Claude Code discards the failure, and the hook does nothing for its
// whole life while every test passes.
//
// It passed because the suite spawned the hook as `node <path>`, which is the
// one way of running it that never consults the permission bit. That is the
// same fault as the guardrails release that blocked nothing: the thing under
// test and the thing the user runs were two different programs.
//
// This walks every hooks.json rather than naming files, so a hook added
// tomorrow is covered without anyone remembering this exists. It checks the
// mode in the git index and on disk: the index is what other people clone, so
// a chmod that is never committed fixes one machine, and the working tree is
// what the shell here will actually consult.
//
// Nothing in this file executes a hook. An earlier version did, and running
// session-start.js runs its whole main(), which reads ~/.claude, shells out to
// git across every configured root, and can leave a detached process behind.
// A unit suite has no business reaching outside the repository, and none of
// that was needed: fs.accessSync with X_OK asks the operating system the same
// question the shell asks before running a file.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

function tracked(pattern) {
  return execFileSync('git', ['ls-files', pattern], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function indexMode(file) {
  const out = execFileSync('git', ['ls-files', '-s', file], { cwd: ROOT, encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/)[0] : null;
}

// Every (file, invoked-directly?) pair named by any hooks.json in the repo.
function declaredHooks() {
  const found = [];
  for (const manifest of tracked('*/hooks/hooks.json')) {
    const pluginDir = path.dirname(path.dirname(manifest));
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(ROOT, manifest), 'utf8'));
    } catch (error) {
      throw new Error(`${manifest} is not valid JSON: ${error.message}`);
    }
    for (const groups of Object.values(parsed.hooks || {})) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          const command = hook.command || '';
          const named = command.match(/\/hooks\/([\w.-]+)/);
          if (!named) continue;

          // What the shell executes is the first token. Everything after it is
          // an argument, and an argument is read rather than executed, so the
          // permission bit and the shebang belong to the first token alone.
          // Since 2026-08-12 that token is usually bin/hook-node with the hook
          // file passed to it, which is the point of the launcher: the file
          // carrying the shebang becomes one this repository controls.
          const tokens = command
            .replace(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?/g, '<ROOT>')
            .split(/\s+/).filter(Boolean);
          const first = tokens[0] || '';
          const inRepo = (t) => (t.startsWith('<ROOT>/')
            ? path.posix.join(pluginDir, t.slice('<ROOT>/'.length))
            : null);

          found.push({
            manifest,
            pluginDir,
            file: path.posix.join(pluginDir, 'hooks', named[1]),
            // The file the shell hands to execve. null when the command names a
            // bare interpreter, `node x.js`, which the host resolves and this
            // repository has no file for.
            executed: inRepo(first),
            viaInterpreter: /^(node|sh|bash|python3?)$/.test(first),
          });
        }
      }
    }
  }
  return found;
}

check('the sweep finds the hooks it is supposed to be checking', () => {
  // A sweep that matches nothing passes forever. If a rename or a manifest
  // change makes every hook invisible to this, that has to fail loudly rather
  // than report a clean run over an empty list.
  const hooks = declaredHooks();
  console.log(`        (${hooks.length} hooks declared across the repository)`);
  assert.ok(hooks.length >= 8, `only ${hooks.length} hooks found, so the walk has stopped matching`);
});

check('every hook file named by a manifest exists', () => {
  const missing = declaredHooks()
    .filter((h) => !fs.existsSync(path.join(ROOT, h.file)))
    .map((h) => `${h.file} (named in ${h.manifest})`);
  assert.deepStrictEqual(missing, [], `a manifest names a hook that is not there:\n        ${missing.join('\n        ')}`);
});

// The files a shell is actually asked to execute, deduplicated. One launcher
// serves every hook in its plugin, so it appears once here rather than once
// per hook that uses it.
function executedFiles() {
  return [...new Set(declaredHooks().filter((h) => h.executed).map((h) => h.executed))];
}

check('every directly-invoked hook is executable in the git index', () => {
  const notExecutable = executedFiles()
    .filter((file) => indexMode(file) !== '100755')
    .map((file) => `${file} is ${indexMode(file)}, should be 100755`);

  assert.deepStrictEqual(notExecutable, [],
    'a hook is run as a shell command but is not executable, so it fails with '
    + '"Permission denied" and Claude Code discards the error:\n        '
    + `${notExecutable.join('\n        ')}\n        Fix with: chmod +x <file> && git add <file>`);
});

check('every directly-invoked hook starts with a shebang', () => {
  // The bit without the line is the same failure. The shell would run the file
  // as a shell script, and the first line of JavaScript is not a shell command.
  const noShebang = executedFiles()
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .filter((file) => !fs.readFileSync(path.join(ROOT, file), 'utf8').startsWith('#!'))
    .map((file) => file);
  assert.deepStrictEqual(noShebang, [], `a directly-invoked hook has no shebang:\n        ${noShebang.join('\n        ')}`);
});

check('a matcher that only lists tool names uses the exact-string form', () => {
  // The matcher has two evaluation paths, and which one applies is decided by
  // the characters in it. Letters, digits, `_`, `-`, spaces, `,` and `|` only:
  // read as a list of exact names. Anything else: an unanchored JavaScript
  // regex.
  //
  // So `Write|Edit` matches those two tools and nothing else, while a regex
  // `Edit` would also match NotebookEdit. This slot was briefly written as
  // `^(Write|Edit)$` to close a gap that the exact-string path had already
  // closed, which made one manifest differ from every other for no gain.
  //
  // Anchoring is not wrong and a real regex may be wanted one day. This exists
  // so that reaching for one is a decision somebody makes on purpose rather
  // than a habit picked up from another language's matcher.
  const EXACT_FORM = /^[\w\-, |]+$/;
  const regexy = declaredHooks()
    .map((h) => JSON.parse(fs.readFileSync(path.join(ROOT, h.manifest), 'utf8')))
    .flatMap((parsed) => Object.entries(parsed.hooks || {})
      .flatMap(([event, groups]) => groups
        .filter((g) => typeof g.matcher === 'string' && !EXACT_FORM.test(g.matcher))
        .map((g) => `${event}: ${JSON.stringify(g.matcher)}`)));

  assert.deepStrictEqual([...new Set(regexy)], [],
    'a matcher uses regex syntax where a plain list of names would do. If the regex is '
    + 'deliberate, say so where it is declared and add it here:\n        '
    + `${[...new Set(regexy)].join('\n        ')}`);
});

check('every directly-invoked hook is executable on disk as well as in the index', () => {
  // The index mode is what other people clone; this is what the shell on this
  // machine will actually consult. Both, because a chmod that is never
  // committed fixes one machine, and a committed mode that a checkout did not
  // apply fixes none.
  //
  // This replaced a version that spawned every hook for real, which was a bad
  // idea in a way that had nothing to do with what it was testing. Running
  // session-start.js runs its whole main(): it reads ~/.claude, shells out to
  // git across every configured root, and can leave a detached mcp-refresh
  // behind. A unit suite reached outside the repository and could leave a
  // process running on the developer's machine, and it was slow and
  // non-deterministic with it.
  //
  // fs.accessSync with X_OK asks the operating system the same question the
  // shell asks before it runs the file, which is the whole of what the old
  // check was for, without executing anything.
  const notExecutable = [];
  for (const file of executedFiles()) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;   // reported by its own check above
    try {
      fs.accessSync(full, fs.constants.X_OK);
    } catch {
      notExecutable.push(`${file} is not executable on disk`);
    }
  }
  assert.deepStrictEqual(notExecutable, [],
    `the shell would refuse to run a hook this repository declares:\n        ${notExecutable.join('\n        ')}`);
});

// The PATH a process gets when nothing has read a login shell. macOS hands
// this to anything launched from the Dock or by launchd, which is every GUI
// host: Codex, and any other app started outside a terminal.
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function shebangInterpreter(file) {
  const first = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')[0];
  if (!first.startsWith('#!')) return null;
  const parts = first.slice(2).trim().split(/\s+/);
  // `#!/usr/bin/env node` names env as the interpreter and node as its
  // argument, and it is node that has to be found. Every other form names an
  // absolute path, which needs no search.
  return parts[0].endsWith('/env') ? parts[1] : parts[0];
}

function resolvesOnBarePath(interpreter) {
  if (!interpreter) return true;                       // no shebang: its own check
  if (interpreter.startsWith('/')) return fs.existsSync(interpreter);
  try {
    execFileSync('sh', ['-c', `command -v ${interpreter}`],
      { env: { PATH: BARE_PATH }, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

check('every executed hook names an interpreter a GUI-launched host can find', () => {
  // The bug, on 2026-08-12: every hook here began `#!/usr/bin/env node`, and
  // node on this machine lives at ~/.local/bin/node, put on PATH by a single
  // line in ~/.zshrc. Codex is launched from the Dock and so never reads that
  // file. env could not find node, the shell answered 127, Claude Code
  // discarded the failure, and twelve of the thirteen declared hooks did
  // nothing at all in that host for their whole life.
  //
  // This is the same shape as the 2026-08-04 permission-bit bug one level
  // down. That one was "the shell may refuse to run this file"; this one is
  // "the shell may not find what the file asks to be run by". The check above
  // it asserts a shebang is present, which was true throughout and never the
  // question.
  const unresolvable = executedFiles()
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .map((file) => ({ file, interpreter: shebangInterpreter(file) }))
    .filter(({ interpreter }) => !resolvesOnBarePath(interpreter))
    .map(({ file, interpreter }) => `${file} asks for "${interpreter}"`);

  assert.deepStrictEqual(unresolvable, [],
    'a hook names an interpreter that is not on the PATH a GUI-launched host gets, '
    + `so it exits 127 there and the failure is discarded:\n        ${unresolvable.join('\n        ')}\n`
    + '        Invoke it through bin/hook-node instead of naming node in the shebang.');
});

check('every JavaScript hook is invoked through the launcher, not directly', () => {
  // The fix for the above, stated as a rule rather than left to whoever adds
  // the next hook. A .js file invoked directly is a file whose shebang has to
  // find node, which is the failure. Through bin/hook-node the shebang is
  // `#!/bin/sh`, which is on every PATH there has ever been, and the search
  // for node happens in a file this repository controls.
  const direct = declaredHooks()
    .filter((h) => h.file.endsWith('.js'))
    .filter((h) => h.executed === h.file)
    .map((h) => `${h.file} is invoked directly by ${h.manifest}`);

  assert.deepStrictEqual(direct, [],
    'a JavaScript hook is executed directly, so it depends on node being on PATH:\n        '
    + `${direct.join('\n        ')}\n        Use: "\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/<file>`);
});

check('every launcher copy is identical', () => {
  // Five copies, because plugins install independently and one cannot reach
  // into another, so a single shared copy at the repository root would be
  // absent for anyone who installed one plugin. Copies drift, so this is what
  // stops them.
  const launchers = executedFiles().filter((file) => file.endsWith('/bin/hook-node'));
  assert.ok(launchers.length >= 5,
    `only ${launchers.length} launchers are referenced by a manifest, so the copies have stopped being used`);

  const distinct = new Set(launchers.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')));
  assert.strictEqual(distinct.size, 1,
    `the launcher copies have drifted apart, ${distinct.size} distinct versions across:\n        ${launchers.join('\n        ')}`);
});

check('an unfindable interpreter is actually caught', () => {
  // The assertion above passes on a healthy tree whether it works or not, so
  // it is exercised against shebangs built to fail and to pass. Nothing in the
  // repository is touched.
  assert.strictEqual(resolvesOnBarePath('definitely-not-a-real-interpreter'), false,
    'an interpreter that exists nowhere was reported as findable, so the check above proves nothing');
  assert.strictEqual(resolvesOnBarePath('sh'), true,
    'sh was reported as unfindable, so the check above would fail on a healthy tree');
  assert.strictEqual(resolvesOnBarePath('/bin/sh'), true,
    'an absolute interpreter path that exists was reported as unfindable');
});

check('a hook with no executable bit is actually caught', () => {
  // The assertion above passes on a healthy tree whether it works or not, so
  // it is exercised here against a file built to fail it. Nothing in the
  // repository is touched: this is a throwaway in a temp directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-mode-'));
  const file = path.join(dir, 'probe.js');
  fs.writeFileSync(file, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });

  assert.throws(() => fs.accessSync(file, fs.constants.X_OK),
    'accessSync did not refuse a file with no executable bit, so the check above proves nothing');

  fs.chmodSync(file, 0o755);
  assert.doesNotThrow(() => fs.accessSync(file, fs.constants.X_OK),
    'accessSync refuses a file that is executable, so the check above would fail on a healthy tree');

  fs.rmSync(dir, { recursive: true, force: true });
});


console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
