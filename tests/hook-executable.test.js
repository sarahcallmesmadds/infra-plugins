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

// The guard every hook command carries in front of the work it does.
//
// The bug, on 2026-08-16: updating a plugin while a session is open kills every
// hook in that session until the host restarts. CLAUDE_PLUGIN_ROOT is resolved
// once at startup and carries the version, so it names .../build-loop/0.10.0.
// Codex deletes the old version directory on update rather than keeping it, the
// running session still holds the old path, and from then on the shell answers
// 127 for every hook. Claude Code is not exposed because it keeps every old
// version, which is the same fact failing in the opposite direction: there a
// running session quietly goes on using code that has been replaced.
//
// The guard cannot live in bin/hook-node, which is the obvious place for it.
// The launcher is inside the directory that vanished, so it is not there to
// run. It has to be in the command string, which the host builds from an
// environment variable it still holds.
//
// The exit code is 3, and which code it is decides whether any of this works.
//
// This was written as exit 0 first, and exit 0 makes the whole guard pointless.
// The hook docs are explicit: "Stderr from a hook that exits 0 goes to the debug
// log only, never the transcript, and Claude never sees it." The message would
// have gone nowhere, and the change would have been a no-op wearing the clothes
// of a fix. Caught in review on 2026-08-16, after being argued for in a commit
// message on the grounds that exiting 0 keeps the noise down. It does. It also
// keeps the message down.
//
// Putting it on stdout instead does not work either. For most events stdout on
// exit 0 also goes to the debug log rather than the transcript, and for the
// three where it is surfaced, UserPromptSubmit, UserPromptExpansion and
// SessionStart, it is added as context for Claude rather than shown to the
// reader. That would put this line into the model's context on every prompt and
// still not tell the person whose hooks are off.
//
// So it has to be a non-zero exit with the message on stderr, which the docs
// describe as a non-blocking error: "the action proceeds, and the transcript
// shows a `<hook name> hook error` notice followed by the first line of stderr".
// Hence one line, and the message first.
//
// Not 2, which is the one non-zero code that would do real damage. Exit 2 is a
// blocking error, and guardrails declares three PreToolUse hooks, where exit 2
// blocks the tool call. A plugin update would then refuse every Bash, Write and
// Edit for the rest of the session rather than merely failing to guard them.
//
// Not 127 either, which is the code this entry exists because of: the shell says
// it when it cannot find a command, and bin/hook-node deliberately reuses it for
// its own interpreter-not-found failure. A third meaning would make the
// ambiguity that cost four diagnosis rounds worse rather than better.
//
// This does not keep the guardrails working. They are already off. It replaces
// a bare code with a line naming the cause and the remedy.
//
// What the guard tests is the file the command is about to run, not the plugin
// directory holding it.
//
// It tested the directory first, on the reasoning that a deleted directory is
// the failure being fixed and one identical wording everywhere is easy to check.
// Both halves were wrong. A directory that survives while the launcher inside it
// does not, from a partial update or an interrupted install, passes a directory
// test and then answers 127 with no explanation, which is precisely the
// ambiguity this exists to remove. And byte-identity was the weaker check
// anyway: it proves thirteen commands say the same thing, not that any of them
// says the right thing about itself.
//
// So the tested path varies per command and is required to equal that command's
// own first token. The message and the exit code stay identical everywhere. That
// is a stronger property than one shared string, because it couples each guard
// to the thing it guards rather than to its siblings.
//
// Two clauses, not one, because `[ -x ]` alone is false for two different
// reasons and they need different remedies.
//
// The file being gone is the mid-session update, and a restart fixes it. The
// file being there but not runnable is a checkout that dropped its modes, a zip
// download, a noexec mount or an interrupted install, and a restart fixes
// nothing. A single -x test conflates them and the one message then states a
// cause confidently and sometimes wrongly, sending somebody to restart when the
// answer is chmod. This repository has already had the second case for real: on
// 2026-08-04 consistency-lint.js shipped at mode 100644 and the shell refused
// it, which is the bug at the top of this file.
//
// Handing back a confident wrong cause is the exact failure this whole guard
// exists to end, so it would have been a poor thing to reintroduce while fixing
// it. Caught in review on 2026-08-16.
//
// The not-runnable message names the path, which the shell expands, because
// unlike "restart" the remedy needs to say what to chmod.
// Every README that ships hooks has to carry this sentence.
//
// Three of them said the opposite until 2026-08-16: that Codex plugins cannot
// register hooks, so the hooks are Claude Code only. build-loop said it twice,
// in opposite directions. The inference behind it every time was that
// `.codex-plugin/plugin.json` has no hooks field, therefore Codex ignores
// hooks, which reads the manifest and calls it the host. A probe hook added to
// the Codex-installed copy showed Codex reading each plugin's hooks/hooks.json
// and running the commands.
//
// It mattered most in guardrails, which told a reader they had no automatic
// protection in a host where the guards do fire. That is the wrong direction to
// be wrong about a plugin whose job is to stop things.
const RUNS_IN_CODEX = 'These hooks run in both Claude Code and Codex.';

// Three clauses, not two. The third was added last and is the one the guard
// itself got wrong.
//
// With CLAUDE_PLUGIN_ROOT unset or empty, the earlier two-clause guard tested
// `[ -e "/bin/hook-node" ]`, which fails, and told the reader a plugin had been
// updated and to restart. A restart does not fix a host that never set the
// variable. That is a confident wrong cause, which is the exact failure this
// whole guard exists to end, reintroduced by the guard.
//
// Worse than an oversight: the shell probe below already exercised the unset
// state and deliberately asserted only the exit code, so the wrong message was
// covered by a test that had been written not to look at it. Caught in review
// on 2026-08-16. The probe now asserts the message in every state.
//
// The unset clause names no path, because there is no path to name: that is the
// whole condition. It also promises no remedy, because there is not one a reader
// can apply. Saying so is still better than blaming an update.
const GUARD_EXIT = 3;
const UNSET_MESSAGE = 'Plugin hooks are off because this host did not tell the hook where the plugin is installed. A restart will not help.';
const GONE_MESSAGE ='Plugin hooks are off in this session because a plugin was updated after it started. Restart to switch them back on.';
const notRunnableMessage = (target) => `Plugin hooks are off because ${target} is not executable. A restart will not help. Restore its execute bit with chmod +x.`;

function guardFor(target) {
  return `[ -n "\${CLAUDE_PLUGIN_ROOT}" ] || { echo "${UNSET_MESSAGE}" >&2; exit ${GUARD_EXIT}; }; `
    + `[ -e "${target}" ] || { echo "${GONE_MESSAGE}" >&2; exit ${GUARD_EXIT}; }; `
    + `[ -x "${target}" ] || { echo "${notRunnableMessage(target)}" >&2; exit ${GUARD_EXIT}; }; `;
}

// Deliberately loose about the messages and the codes, so that a guard carrying
// the wrong ones is still recognised as a guard and reported as wrong, rather
// than not matching and being reported as absent.
const GUARD_RE = new RegExp(
  '^\\[ -n "\\$\\{CLAUDE_PLUGIN_ROOT\\}" \\] \\|\\| \\{ echo "([^"]*)" >&2; exit (\\d+); \\}; '
  + '\\[ -e "([^"]+)" \\] \\|\\| \\{ echo "([^"]*)" >&2; exit (\\d+); \\}; '
  + '\\[ -x "([^"]+)" \\] \\|\\| \\{ echo "([^"]*)" >&2; exit (\\d+); \\}; ',
);

// `"${CLAUDE_PLUGIN_ROOT}"/bin/hook-node` and `"${CLAUDE_PLUGIN_ROOT}/bin/hook-node"`
// are the same path written two ways, and the two appear in the same command.
const unquote = (token) => token.replace(/"/g, '');

// What a hooks.json command actually asks the shell to do.
//
// The shell executes the first token. Everything after it is an argument, and
// an argument is read rather than executed, so the permission bit and the
// shebang belong to the first token alone. Since 2026-08-13 that token is
// bin/hook-node with the hook file passed to it, which is the point of the
// launcher: the file carrying the shebang becomes one this repository controls.
//
// Split out from declaredHooks so the three forms can be exercised against
// input this file makes up, rather than only against whatever the repository
// happens to contain today. A parser tested only on its own repository agrees
// with itself and proves nothing about the form nobody has written yet, which
// is where the next instance of this bug will arrive.
function parseCommand(command, pluginDir) {
  // Step over the guard before tokenising. Without this the first token is `[`,
  // which resolves to no file in the repository, so `executed` comes back null
  // and every check built on it passes by having nothing to look at. That is
  // not hypothetical: adding the guard turned eight of these checks green while
  // they examined an empty list, and only the launcher check, which asserts it
  // found at least five, noticed. Checks that pass by finding nothing are the
  // failure this suite exists to prevent, so the parser has to see through the
  // guard rather than be defeated by it.
  const guard = GUARD_RE.exec(command);
  const work = guard ? command.slice(guard[0].length) : command;
  const tokens = work
    .replace(/"?\$\{CLAUDE_PLUGIN_ROOT\}"?/g, '<ROOT>')
    .split(/\s+/).filter(Boolean);
  const first = tokens[0] || '';
  const inRepo = (t) => (t.startsWith('<ROOT>/')
    ? path.posix.join(pluginDir, t.slice('<ROOT>/'.length))
    : null);

  return {
    // The file the shell hands to execve. null when the command names a bare
    // interpreter, `node x.js`, which the host resolves from PATH and this
    // repository has no file for.
    executed: inRepo(first),
    // True for that same case. It is not a safe form: it is the original bug
    // wearing different clothes, since the node it finds is whatever PATH
    // happens to hold, which under a GUI-launched host is nothing.
    viaInterpreter: /^(node|sh|bash|python3?)$/.test(first),
  };
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
            pluginDir,
            command,
            file: path.posix.join(pluginDir, 'hooks', named[1]),
            ...parseCommand(command, pluginDir),
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
  // Two forms fail this, and the second is the one that got away. A command
  // written `node "${CLAUDE_PLUGIN_ROOT}"/hooks/x.js` has no repository file in
  // its first token, so `executed` is null and an earlier version of this check
  // skipped it entirely. It resolves node from PATH exactly as the shebang did,
  // which is the whole defect this file exists to keep out, so it has to fail
  // here rather than pass by not being noticed.
  const direct = declaredHooks()
    .filter((h) => h.file.endsWith('.js'))
    .flatMap((h) => {
      if (h.executed === h.file) return [`${h.file} is executed directly by ${h.manifest}`];
      if (h.viaInterpreter) return [`${h.file} is run by a bare interpreter in ${h.manifest}`];
      return [];
    });

  assert.deepStrictEqual(direct, [],
    'a JavaScript hook depends on node being on PATH:\n        '
    + `${direct.join('\n        ')}\n        Use: "\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/<file>`);
});

// Spawn calls, wherever the first argument sits. Written to run over the whole
// source rather than line by line, because a call whose arguments are wrapped
// onto separate lines is still a call, and a detector that only sees one-liners
// teaches people the wrong lesson about where the rule applies.
const SPAWN_CALL = /\b(?:exec|execFile|execFileSync|spawn|spawnSync)\(\s*([^,)]+?)\s*,/g;

check('no test suite depends on node being on PATH either', () => {
  // The same rule as the two checks above, applied to the suites rather than to
  // the hooks, and it lives here so there is one statement of it rather than
  // two that can disagree.
  //
  // Measured on 2026-08-15 by running all 42 suites under BARE_PATH: four
  // failed, at 22 sites. Nineteen in stale-branches, one each in slop-check and
  // skill-md-check, all spawning the interpreter by the name `node`, and one in
  // resource-ownership executing a hook file so the kernel read its
  // `#!/usr/bin/env node` and searched PATH. Seventeen suites already used
  // process.execPath and were unaffected, so the rule was being followed by
  // most of the repository and written down nowhere.
  //
  // This is the fourth instance of a suite answering by machine rather than by
  // the work, after the bash-guard suite in #102, built-check, and the probe
  // suite in #103. The first three were each found by accident, one at a time,
  // which is the argument for a check rather than another fix.
  //
  // process.execPath is the interpreter already running this suite, so it needs
  // no search and cannot be a different node from the one under test. It is
  // also what bin/hook-node arranges in production: find an interpreter, then
  // exec it with the script.
  //
  // The limit, stated rather than left to be discovered: this reads the text,
  // so it sees a call written the way every call in this repository is written
  // and would miss one made through a renamed binding or a name built at run
  // time. That is worth knowing before trusting a pass here as proof of
  // absence. The check that cannot be fooled is running the suite under
  // BARE_PATH, which is slow enough that it is not done on every run.
  const dir = path.join(ROOT, 'tests');
  const offenders = [];

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');

    // Constants naming a JavaScript file in this repository. Passing one as the
    // command means executing it, which hands the interpreter question to the
    // shebang and so to PATH. A .sh file is deliberately allowed: /bin/sh is on
    // every machine that can run a hook at all, which is why the probe is
    // written in it.
    const jsFileConsts = new Set();
    for (const line of source.split('\n')) {
      const declared = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=.*\.js['"]/.exec(line);
      if (declared) jsFileConsts.add(declared[1]);
    }

    for (const call of source.matchAll(SPAWN_CALL)) {
      const command = call[1].trim();
      const line = source.slice(0, call.index).split('\n').length;
      if (/^['"]node['"]$/.test(command)) {
        offenders.push(`${file}:${line} starts the interpreter as "node", which has to be found on PATH`);
      } else if (jsFileConsts.has(command)) {
        offenders.push(`${file}:${line} executes ${command}, so its shebang resolves node from PATH`);
      }
    }
  }

  assert.deepStrictEqual(offenders, [],
    'a suite resolves node from PATH, so it passes or fails by where node is '
    + `installed rather than by the work:\n        ${offenders.join('\n        ')}\n`
    + '        Use process.execPath as the command and pass the script in the argument array.');
});

check('every hook command guards the file it is about to run', () => {
  // Without this the guard is thirteen strings with nothing holding them
  // together, and the next hook somebody adds gets none. The suite already walks
  // every manifest, so a hook added tomorrow is covered without anyone
  // remembering this exists.
  //
  // The strong part is the last assertion, that the guarded path is the
  // command's own first token. A guard naming some other path still reads as a
  // guard, still passes any check that only looks for the words, and protects
  // nothing. That is not hypothetical either: the first version of this guarded
  // the plugin directory for every command, which is a path no command runs, and
  // so let a present-but-incomplete install through to a bare 127.
  const hooks = declaredHooks();
  assert.ok(hooks.length >= 13,
    `only ${hooks.length} hook commands found, so this is checking almost nothing`);

  const wrong = [];
  for (const h of hooks) {
    const where = `${h.file} in ${h.manifest}`;
    const guard = GUARD_RE.exec(h.command);

    if (!guard) {
      wrong.push(`${where}: no guard, so it exits 127 with nothing and reads as an interpreter failure`);
      continue;
    }

    const [matched, unsetMessage, unsetCode, gonePath, goneMessage, goneCode, execPath, execMessage, execCode] = guard;

    if (unsetMessage !== UNSET_MESSAGE) wrong.push(`${where}: the unset message is ${JSON.stringify(unsetMessage)}`);
    if (Number(unsetCode) !== GUARD_EXIT) wrong.push(`${where}: the unset clause exits ${unsetCode}, not ${GUARD_EXIT}`);
    if (goneMessage !== GONE_MESSAGE) wrong.push(`${where}: the gone message is ${JSON.stringify(goneMessage)}`);
    if (execMessage !== notRunnableMessage(execPath)) {
      wrong.push(`${where}: the not-runnable message is ${JSON.stringify(execMessage)}, which does not name ${execPath}`);
    }
    if (Number(goneCode) !== GUARD_EXIT) wrong.push(`${where}: the gone clause exits ${goneCode}, not ${GUARD_EXIT}`);
    if (Number(execCode) !== GUARD_EXIT) wrong.push(`${where}: the not-runnable clause exits ${execCode}, not ${GUARD_EXIT}`);

    // Both clauses have to watch the same file, and it has to be the one the
    // command runs. Two clauses is two chances to point somewhere else.
    const runs = unquote(h.command.slice(matched.length).split(/\s+/)[0]);
    if (gonePath !== runs) wrong.push(`${where}: the gone clause watches ${gonePath} but the command runs ${runs}`);
    if (execPath !== runs) wrong.push(`${where}: the not-runnable clause watches ${execPath} but the command runs ${runs}`);
  }

  assert.deepStrictEqual(wrong, [],
    `a guard does not match the command it protects:\n        ${wrong.join('\n        ')}\n`
    + `        Prefix each command with: ${guardFor('<the command\'s own first token>')}`);
});

check('the guard exits on a code that reaches the reader and blocks nothing', () => {
  // This is the check that would have caught the bug, and the reason it is
  // written as a constraint on the number rather than folded into the probe
  // below. The probe builds its command from GUARD, which embeds GUARD_EXIT, so
  // asserting that the command exits with GUARD_EXIT only proves the shell
  // honours `exit N`. It cannot say whether N was the right choice, and it
  // passed contentedly while N was 0.
  //
  // Three values are wrong, each for its own reason, so each is refused by name.
  assert.notStrictEqual(GUARD_EXIT, 0,
    'exit 0 sends stderr to the debug log and nowhere else, so the message reaches nobody '
    + 'and the guard becomes a no-op that looks like a fix');
  assert.notStrictEqual(GUARD_EXIT, 2,
    'exit 2 is a blocking error. guardrails declares PreToolUse hooks, where it blocks the '
    + 'tool call, so a plugin update would refuse every Bash, Write and Edit for the rest of '
    + 'the session rather than merely failing to guard them');
  assert.notStrictEqual(GUARD_EXIT, 127,
    'exit 127 is what the shell says when it cannot find a command and what bin/hook-node '
    + 'deliberately says for its own interpreter-not-found failure. Reusing it here adds a '
    + 'third meaning to the ambiguity that cost four rounds to diagnose');

  assert.ok(Number.isInteger(GUARD_EXIT) && GUARD_EXIT > 0 && GUARD_EXIT < 126,
    `${GUARD_EXIT} is not a plain non-zero exit status a shell will report unchanged`);
});

check('the guard actually fires, and only when it should', () => {
  // The assertion above passes on a healthy tree whether the guard works or
  // not: it compares two strings and never asks a shell what they do. This runs
  // the real thing under the three states that matter.
  //
  // More than one shell, because the guard is read by whichever one the host
  // uses and they are not the same program. bin/hook-node's own shebang is
  // #!/bin/sh, which on a Linux runner is dash and on macOS is not.
  //
  // Which shell each host uses, looked up rather than assumed, because a review
  // on 2026-08-16 raised that this guard would be a syntax error in fish and
  // csh and so would switch off hooks that had been working:
  //
  // Claude Code uses `sh -c`. The docs are specific: "The `command` string is
  // passed to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or
  // PowerShell when Git Bash isn't installed." A user's login shell never sees
  // it, so fish and csh are not reachable on this host at all.
  //
  // Codex uses `$SHELL -lc`, established from its binary on 2026-08-16, so a
  // login shell does read it there. That is the case worth naming rather than
  // waving away, and it is almost certainly already broken for a reason older
  // than this guard: every command in these manifests, before and after, writes
  // `${CLAUDE_PLUGIN_ROOT}`, and fish has no `${VAR}` form. Its equivalent is
  // `{$VAR}`. csh and tcsh do not accept `-lc` at all, measured here. So a
  // non-POSIX login shell could not have run these hooks before either.
  //
  // "Almost certainly" is doing real work in that sentence. It is an inference
  // from fish's documented syntax, not a measurement, because fish is not
  // installed on this machine. Anyone who does have it can settle it in one
  // line. It is recorded as unproven rather than folded into the reasoning as
  // though it were checked.
  //
  // Which shells exist is a property of the machine, not of the work. Naming
  // /bin/zsh unconditionally failed CI on 2026-08-16, because the Ubuntu runner
  // does not have it. So the list is filtered by what is installed, and the two
  // ways that could quietly go wrong are both closed: /bin/sh is required
  // outright, since a machine without it cannot run a hook at all and a run
  // that skipped everything would otherwise report a pass, and whatever was
  // skipped is printed. A check that silently examines an empty list is the
  // failure this suite exists to prevent, and it does not stop being that
  // because the empty list came from a missing shell.
  //
  // The states are four, not three. The fourth, a plugin directory that is still
  // there while the launcher inside it is not, is the one a directory test
  // passed and this exists to catch: a partial update, an interrupted install,
  // or a file renamed between versions. It is built here rather than described,
  // by pointing the guard at a name inside a directory that really does exist.
  const probe = `${guardFor('${CLAUDE_PLUGIN_ROOT}/bin/hook-node')}echo RAN`;
  const CANDIDATES = ['/bin/sh', '/bin/zsh', '/bin/bash'];
  const shells = CANDIDATES.filter((s) => fs.existsSync(s));
  const absent = CANDIDATES.filter((s) => !fs.existsSync(s));

  assert.ok(shells.includes('/bin/sh'),
    '/bin/sh is not on this machine, so the guard was not exercised at all');
  if (absent.length) console.log(`        (not installed here, so unchecked: ${absent.join(', ')})`);

  for (const shell of shells) {
    // Exit code, stdout and stderr all three, because which stream the message
    // lands on is the difference between a working guard and a silent one, and
    // an earlier version of this check read only stdout and so would have passed
    // just as happily while the message went to the debug log and nowhere else.
    const run = (env) => {
      const result = spawnSync(shell, ['-lc', probe], { env, encoding: 'utf8' });
      if (result.error) throw new Error(`${shell} could not be run: ${result.error.message}`);
      return { code: result.status, out: result.stdout, err: result.stderr };
    };

    const gone = run({ ...process.env, CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'no-such-plugin-0.0.0') });
    assert.strictEqual(gone.out, '',
      `${shell}: stdout was ${JSON.stringify(gone.out)} with the plugin directory gone. Either the `
      + 'hook body ran anyway, or the message is going to stdout, where most events send it to the '
      + 'debug log and the three that surface it feed it to Claude as context instead of showing it');
    assert.strictEqual(gone.code, GUARD_EXIT,
      `${shell}: the guard exited ${gone.code} rather than ${GUARD_EXIT}. Exit 0 sends stderr to the `
      + 'debug log and nowhere the reader will see it, and exit 2 blocks the tool call on PreToolUse');
    assert.strictEqual(gone.err.trim(), GONE_MESSAGE,
      `${shell}: stderr was ${JSON.stringify(gone.err)}, and only its first line is surfaced`);

    // Two states inside one real directory, and they must not give the same
    // answer. Missing means a restart helps; present but not runnable means it
    // does not, and telling someone to restart then is a confident wrong cause,
    // which is the failure this guard exists to end.
    const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-plugin-'));
    const launcher = path.join(partial, 'bin', 'hook-node');
    fs.mkdirSync(path.join(partial, 'bin'));
    try {
      const incomplete = run({ ...process.env, CLAUDE_PLUGIN_ROOT: partial });
      assert.strictEqual(incomplete.out, '',
        `${shell}: the hook body ran with the plugin directory present but bin/hook-node missing`);
      assert.strictEqual(incomplete.code, GUARD_EXIT,
        `${shell}: a half-installed plugin exited ${incomplete.code} rather than ${GUARD_EXIT}, so a `
        + 'partial update still fails with nothing said');
      assert.strictEqual(incomplete.err.trim(), GONE_MESSAGE,
        `${shell}: a half-installed plugin said ${JSON.stringify(incomplete.err)}`);

      // There, and not executable. The mode this repository actually shipped by
      // accident on 2026-08-04.
      fs.writeFileSync(launcher, '#!/bin/sh\n');
      fs.chmodSync(launcher, 0o644);
      const notRunnable = run({ ...process.env, CLAUDE_PLUGIN_ROOT: partial });
      assert.strictEqual(notRunnable.out, '',
        `${shell}: the hook body ran with a launcher that has no execute bit`);
      assert.strictEqual(notRunnable.code, GUARD_EXIT,
        `${shell}: a launcher with no execute bit exited ${notRunnable.code} rather than ${GUARD_EXIT}`);
      assert.strictEqual(notRunnable.err.trim(), notRunnableMessage(launcher),
        `${shell}: a launcher with no execute bit said ${JSON.stringify(notRunnable.err)}`);
      assert.notStrictEqual(notRunnable.err.trim(), GONE_MESSAGE,
        `${shell}: a launcher that is present but not executable was blamed on a plugin update, so `
        + 'the reader is sent to restart when the answer is chmod');
    } finally {
      fs.rmSync(partial, { recursive: true, force: true });
    }

    // Unset, and empty, which are different inputs that must not produce
    // different answers. This used to assert the exit code and nothing else,
    // which let the guard blame an update for a variable the host never set and
    // kept a wrong cause covered by a test written not to look at it.
    for (const [what, env] of [
      ['unset', (() => { const e = { ...process.env }; delete e.CLAUDE_PLUGIN_ROOT; return e; })()],
      ['empty', { ...process.env, CLAUDE_PLUGIN_ROOT: '' }],
    ]) {
      const noRoot = run(env);
      assert.strictEqual(noRoot.out, '',
        `${shell}: the hook body ran with CLAUDE_PLUGIN_ROOT ${what}`);
      assert.strictEqual(noRoot.code, GUARD_EXIT,
        `${shell}: the guard exited ${noRoot.code} rather than ${GUARD_EXIT} with the variable ${what}`);
      assert.strictEqual(noRoot.err.trim(), UNSET_MESSAGE,
        `${shell}: with the variable ${what} the guard said ${JSON.stringify(noRoot.err)}`);
      assert.notStrictEqual(noRoot.err.trim(), GONE_MESSAGE,
        `${shell}: a host that never set CLAUDE_PLUGIN_ROOT was told a plugin had been updated and to `
        + 'restart, which will not help and is the wrong cause this guard exists to stop handing back');
    }

    // One line, because the transcript shows the first line of stderr and
    // discards the rest. A message that grew a second line would lose it here
    // with nothing to say so.
    assert.strictEqual(gone.err.trimEnd().split('\n').length, 1,
      `${shell}: the message is ${gone.err.trimEnd().split('\n').length} lines and only the first is shown`);

    // A real plugin directory, so the guarded path is a launcher that is really
    // there. The repository root is not one: it has no bin/hook-node, which is
    // the point of the copies.
    const healthyRoot = path.join(ROOT, 'plugins', 'build-loop');
    assert.ok(fs.existsSync(path.join(healthyRoot, 'bin', 'hook-node')),
      'the healthy case points at a directory with no launcher in it, so it proves nothing');
    const healthy = run({ ...process.env, CLAUDE_PLUGIN_ROOT: healthyRoot });
    assert.strictEqual(healthy.out.trim(), 'RAN',
      `${shell}: the guard blocked a hook whose plugin directory is present, so it would switch every hook off`);
    assert.strictEqual(healthy.code, 0,
      `${shell}: a healthy hook exited ${healthy.code}, so every hook would report an error on every event`);
    assert.strictEqual(healthy.err, '',
      `${shell}: a healthy hook wrote ${JSON.stringify(healthy.err)} to stderr, which the transcript would show as an error`);
  }
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

check('every plugin that ships a JavaScript hook documents how node is found', () => {
  // The 2026-08-13 review: $CLAUDE_HOOK_NODE shipped as a user-facing setting
  // documented nowhere, while two READMEs still told people node had to be on
  // PATH or the hooks would fail silently. Both halves were wrong at once, so
  // somebody following the instructions would neither find the supported way
  // to point at their Node nor understand why it worked without it.
  //
  // CONTRIBUTING.md requires each plugin README to cover configuration and
  // runtime limits. How a hook finds its interpreter is both of those.
  const dirs = [...new Set(declaredHooks()
    .filter((h) => h.file.endsWith('.js'))
    .map((h) => h.pluginDir))];

  const problems = [];
  for (const dir of dirs) {
    const readme = path.join(ROOT, dir, 'README.md');
    if (!fs.existsSync(readme)) { problems.push(`${dir}/README.md does not exist`); continue; }
    const text = fs.readFileSync(readme, 'utf8');

    const absent = ['CLAUDE_HOOK_NODE', 'bin/hook-node'].filter((s) => !text.includes(s));
    if (absent.length) problems.push(`${dir}/README.md never mentions ${absent.join(' or ')}`);

    // The claim that replaced. It is worse than silence, because it sends
    // somebody to fix a PATH that was never the problem.
    if (/`?node`? has to be on your/.test(text)) {
      problems.push(`${dir}/README.md still says node has to be on your PATH, which stopped being true`);
    }

    // The guard is a runtime side effect a reader meets without asking for it:
    // a line in the transcript, once per hook per event, after an update they
    // may not connect it to. CONTRIBUTING requires READMEs to cover exactly
    // that. Added after review found the guard shipped documented nowhere while
    // build-loop's README still promised its probe "prints nothing to the
    // conversation", which the guard had just made false.
    if (!/while a session is already open/i.test(text)) {
      problems.push(`${dir}/README.md does not say what happens when the plugin is updated mid-session`);
    }

    // The claim that Codex does not run these hooks. It has been written into
    // build-loop's README twice, in opposite directions, and into three others
    // once each, always from the same inference: `.codex-plugin/plugin.json`
    // has no hooks field, therefore Codex ignores hooks. That reads the manifest
    // and calls it the host. A probe hook added to the Codex-installed copy on
    // 2026-08-16 showed Codex reading each plugin's hooks/hooks.json and running
    // the commands.
    //
    // It matters most in guardrails, where it told a reader they had no
    // automatic protection in a host where they had it, which is the wrong
    // direction to be wrong about a plugin whose job is to stop things.
    //
    // Checked rather than trusted to stay fixed, because it came back once
    // already while being corrected.
    //
    // Stated as something each README must say, not as a phrase it must avoid.
    // The banning form was tried first and was wrong: these READMEs keep the
    // superseded claim on the record on purpose, so "Codex plugins cannot
    // register hooks" appears in all four as a sentence about what they used to
    // say. A blanket ban cannot tell an assertion from a quotation and failed
    // against the very correction it was written to protect.
    // One exact sentence rather than a pattern over prose. The pattern version
    // was tried and made the test the author of the documentation: three
    // READMEs said the right thing in their own words and failed anyway, and
    // the way to pass would have been to bend each one's wording to suit a
    // regex. A single required sentence is checkable without deciding how the
    // rest of the page reads.
    if (!text.includes(RUNS_IN_CODEX)) {
      problems.push(`${dir}/README.md does not carry the sentence "${RUNS_IN_CODEX}", which a probe `
        + 'established on 2026-08-16 and which three of these READMEs previously denied');
    }
  }

  // The same claim as a section heading rather than a sentence. Kept as a ban
  // because a heading is an assertion in a way a sentence need not be, and no
  // historical note needs to be phrased as one.
  const guardrailsReadme = path.join(ROOT, 'plugins', 'guardrails', 'README.md');
  if (fs.existsSync(guardrailsReadme)) {
    const text = fs.readFileSync(guardrailsReadme, 'utf8');
    if (/^#+ .*Codex gets advice/m.test(text)) {
      problems.push('plugins/guardrails/README.md still headlines that Codex gets advice rather than '
        + 'enforcement, which tells a reader they are unprotected in a host where the guards do fire');
    }
  }

  // build-loop's probe is the one hook whose README promised silence outright,
  // so the promise is checked in the form the guard made it need.
  const probeReadme = path.join(ROOT, 'plugins', 'build-loop', 'README.md');
  if (fs.existsSync(probeReadme)) {
    const text = fs.readFileSync(probeReadme, 'utf8');
    if (/probe prints nothing to the\nconversation and never blocks/.test(text)) {
      problems.push('plugins/build-loop/README.md still promises the probe prints nothing to the '
        + 'conversation, which the guard made untrue when the probe file itself is missing');
    }
  }

  assert.deepStrictEqual(problems, [],
    `a plugin ships hooks whose interpreter resolution is undocumented or described wrongly:\n        ${problems.join('\n        ')}`);
});

check('the three command forms are told apart', () => {
  // The checks above read the repository, so they only ever see the form the
  // repository currently uses. These are the forms somebody could write next,
  // fed straight to the parser, so the bare-interpreter case is covered before
  // a manifest contains one rather than after.
  const dir = 'plugins/example';
  const launched = parseCommand('"${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "${CLAUDE_PLUGIN_ROOT}"/hooks/x.js', dir);
  assert.strictEqual(launched.executed, 'plugins/example/bin/hook-node',
    'the launcher form does not resolve to the launcher, so the wrong file is being checked');
  assert.strictEqual(launched.viaInterpreter, false);

  const directly = parseCommand('"${CLAUDE_PLUGIN_ROOT}"/hooks/x.js', dir);
  assert.strictEqual(directly.executed, 'plugins/example/hooks/x.js',
    'a directly-invoked hook does not resolve to itself, so it escapes the shebang checks');
  assert.strictEqual(directly.viaInterpreter, false);

  const bare = parseCommand('node "${CLAUDE_PLUGIN_ROOT}"/hooks/x.js', dir);
  assert.strictEqual(bare.executed, null,
    'a bare interpreter resolved to a repository file, which it is not');
  assert.strictEqual(bare.viaInterpreter, true,
    'the bare-interpreter form was not recognised, so it escapes the launcher check '
    + 'while resolving node from PATH, which is the defect this file exists to keep out');

  // Each form again behind the guard, which is how all thirteen are written. A
  // parser that stopped seeing through it would report `executed: null` for
  // everything, and the checks built on that would go green over an empty list
  // rather than fail. The bare-interpreter case matters most: it is the one the
  // guard could hide, because it is caught by recognising the first token
  // rather than by finding a file that is missing.
  const launchGuard = guardFor('${CLAUDE_PLUGIN_ROOT}/bin/hook-node');
  const guardedLaunch = parseCommand(`${launchGuard}"\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(guardedLaunch.executed, 'plugins/example/bin/hook-node',
    'the guard hid the launcher from the parser, so every check built on it examines nothing');
  assert.strictEqual(guardedLaunch.viaInterpreter, false);

  const directGuard = guardFor('${CLAUDE_PLUGIN_ROOT}/hooks/x.js');
  const guardedDirect = parseCommand(`${directGuard}"\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(guardedDirect.executed, 'plugins/example/hooks/x.js',
    'a guarded directly-invoked hook escaped the shebang and permission checks');

  const guardedBare = parseCommand(`${guardFor('node')}node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(guardedBare.viaInterpreter, true,
    'a guarded bare interpreter was not recognised, so adding the guard would have '
    + 'reopened the PATH defect while every check reported clean');

  // A guard whose message or exit code is wrong is still a guard, and has to be
  // stepped over so the check above can report it as wrong rather than absent.
  const wrongEverything = parseCommand(
    `[ -n "\${CLAUDE_PLUGIN_ROOT}" ] || { echo "nope" >&2; exit 7; }; `
    + `[ -e "\${CLAUDE_PLUGIN_ROOT}/bin/hook-node" ] || { echo "other" >&2; exit 9; }; `
    + `[ -x "\${CLAUDE_PLUGIN_ROOT}/bin/hook-node" ] || { echo "different" >&2; exit 8; }; `
    + `"\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(wrongEverything.executed, 'plugins/example/bin/hook-node',
    'a guard with the wrong messages and codes was not recognised as a guard, so the command '
    + 'behind it would be reported as unguarded rather than as misconfigured');

  // A guard that lost its second clause is not a guard this repository writes,
  // and must not be stepped over as though it were. Otherwise the command
  // behind a half-guard parses fine and the missing clause is never reported.
  const halfGuard = parseCommand(
    `[ -n "\${CLAUDE_PLUGIN_ROOT}" ] || { echo "${UNSET_MESSAGE}" >&2; exit ${GUARD_EXIT}; }; `
    + `[ -e "\${CLAUDE_PLUGIN_ROOT}/bin/hook-node" ] || { echo "${GONE_MESSAGE}" >&2; exit ${GUARD_EXIT}; }; `
    + `"\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(halfGuard.executed, null,
    'a guard missing its not-runnable clause was treated as complete, so the command behind it '
    + 'would be reported as fine rather than as half-guarded');

  // And missing the first clause, which is the one that was absent for four
  // rounds and whose absence produced a confidently wrong cause.
  const noUnsetClause = parseCommand(
    `[ -e "\${CLAUDE_PLUGIN_ROOT}/bin/hook-node" ] || { echo "${GONE_MESSAGE}" >&2; exit ${GUARD_EXIT}; }; `
    + `[ -x "\${CLAUDE_PLUGIN_ROOT}/bin/hook-node" ] || { echo "${notRunnableMessage('${CLAUDE_PLUGIN_ROOT}/bin/hook-node')}" >&2; exit ${GUARD_EXIT}; }; `
    + `"\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`, dir);
  assert.strictEqual(noUnsetClause.executed, null,
    'a guard with no unset clause was treated as complete, so an unset CLAUDE_PLUGIN_ROOT would be '
    + 'blamed on a plugin update with nothing reporting it');
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
