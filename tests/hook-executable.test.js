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
// tomorrow is covered without anyone remembering this exists. It reads the
// mode from the git index rather than from the filesystem, because the index
// is what other people clone: a chmod that is never committed fixes the
// machine it was run on and nothing else.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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

check('the hooks actually execute when run the way the harness runs them', () => {
  // The assertion the mode check exists for, made end to end: spawn each hook
  // as a bare path with no interpreter, exactly as a shell would, and require
  // it not to die on startup. Every hook here fails open, so a well-formed
  // event it does not care about is a clean exit 0.
  //
  // A file without the executable bit gives EACCES here, which is what the
  // whole suite missed by spawning `node <path>` instead.
  const event = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/nonexistent/probe.txt' },
  });

  const broken = [];
  for (const hook of declaredHooks().filter((h) => !h.viaInterpreter)) {
    const proc = spawnSync(path.join(ROOT, hook.file), [], { input: event, encoding: 'utf8' });
    if (proc.error) broken.push(`${hook.file}: ${proc.error.code || proc.error.message}`);
    else if (proc.status !== 0) broken.push(`${hook.file}: exited ${proc.status} ${(proc.stderr || '').trim().split('\n')[0]}`);
  }
  assert.deepStrictEqual(broken, [], `a hook cannot be executed as a command:\n        ${broken.join('\n        ')}`);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
