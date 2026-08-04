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
          found.push({
            manifest,
            file: path.posix.join(pluginDir, 'hooks', named[1]),
            // `node x.js` reads the file rather than executing it, so the bit
            // does not matter. Anything else is handed to a shell.
            viaInterpreter: /^\s*(node|sh|bash|python3?)\b/.test(command),
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

check('every directly-invoked hook is executable in the git index', () => {
  const notExecutable = declaredHooks()
    .filter((h) => !h.viaInterpreter)
    .filter((h) => indexMode(h.file) !== '100755')
    .map((h) => `${h.file} is ${indexMode(h.file)}, should be 100755`);

  assert.deepStrictEqual(notExecutable, [],
    'a hook is run as a shell command but is not executable, so it fails with '
    + '"Permission denied" and Claude Code discards the error:\n        '
    + `${notExecutable.join('\n        ')}\n        Fix with: chmod +x <file> && git add <file>`);
});

check('every directly-invoked hook starts with a shebang', () => {
  // The bit without the line is the same failure. The shell would run the file
  // as a shell script, and the first line of JavaScript is not a shell command.
  const noShebang = declaredHooks()
    .filter((h) => !h.viaInterpreter)
    .filter((h) => fs.existsSync(path.join(ROOT, h.file)))
    .filter((h) => !fs.readFileSync(path.join(ROOT, h.file), 'utf8').startsWith('#!'))
    .map((h) => h.file);
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
  for (const hook of declaredHooks().filter((h) => !h.viaInterpreter)) {
    const full = path.join(ROOT, hook.file);
    if (!fs.existsSync(full)) continue;   // reported by its own check above
    try {
      fs.accessSync(full, fs.constants.X_OK);
    } catch {
      notExecutable.push(`${hook.file} is not executable on disk`);
    }
  }
  assert.deepStrictEqual(notExecutable, [],
    `the shell would refuse to run a hook this repository declares:\n        ${notExecutable.join('\n        ')}`);
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
