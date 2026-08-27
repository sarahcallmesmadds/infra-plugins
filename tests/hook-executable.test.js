#!/usr/bin/env node
// Every hook a hooks.json runs directly has to be executable.
//
// Run: node tests/hook-executable.test.js
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
// The guard cannot live in bin/hook-node, which is the obvious place for it.
// The launcher is inside the directory that vanished, so it is not there to
// run. It has to be in the command string, which the host builds from an
// environment variable it still holds.
//
// The exit code is 3, and which code it is decides whether any of this works.
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
// So the tested path varies per command and is required to equal that command's
// own first token. The message and the exit code stay identical everywhere. That
// is a stronger property than one shared string, because it couples each guard
// to the thing it guards rather than to its siblings.
//
// Two clauses, not one, because `[ -x ]` alone is false for two different
// reasons and they need different remedies.
//
// Every README that ships hooks has to carry this sentence.
//
const RUNS_IN_CODEX = 'These hooks run in both Claude Code and Codex.';

// Three clauses, not two. The third was added last and is the one the guard
// itself got wrong.
//
// The unset clause names no path, because there is no path to name: that is the
// whole condition. It also promises no remedy, because there is not one a reader
// can apply. Saying so is still better than blaming an update.
const GUARD_EXIT = 3;
const UNSET_MESSAGE = 'Plugin hooks are off because this host did not tell the hook where the plugin is installed. A restart will not help.';
const GONE_MESSAGE ='Plugin hooks are off in this session because a plugin was updated after it started. Restart to switch them back on.';
const notRunnableMessage = (target) => `Plugin hooks are off because ${target} is not executable. A restart will not help. Restore its execute bit with chmod +x.`;

// Escaping it in shell was the first answer and the wrong one. It needs sed,
// which means it needs PATH, and a broken PATH is a live case here rather than
// a hypothetical: bin/hook-node searches six places for node precisely because
// PATH cannot be trusted. With sed unreachable the escaped message came back
// empty, which is valid JSON carrying nothing, so the fix would have reproduced
// the fault it was written to cure.
//
// So nothing variable is announced at all. The announced message names the file
// relative to the plugin directory, which is fixed text in the manifest.
//
// A target that is not under the plugin directory has no relative form, so one
// message is used for both routes there. That is safe for the same reason: it is
// fixed text in the manifest either way. The recogniser accepts one argument or
// two for exactly this case, and the check below asserts the announced message
// carries no expansion, no backslash and no control character whichever it is.
const PLUGIN_ROOT_PREFIX = '${CLAUDE_PLUGIN_ROOT}/';
const announcedNotRunnable = (target) => (target.startsWith(PLUGIN_ROOT_PREFIX)
  ? notRunnableMessage(`${target.slice(PLUGIN_ROOT_PREFIX.length)} inside the plugin directory`)
  : notRunnableMessage(target));

// Both shapes are live while this rolls out one plugin at a time, so a hook
// carrying either is a guarded hook. A hook carrying neither is not.
// Which events can carry it at all, measured rather than assumed. Codex
// validates the announced event name, but a name matching its declaration is
// not the same question as whether that event delivers anything.
//
// PreToolUse, Stop and SessionStart are not on the list because they have not
// been measured, not because they are known to fail. Anything converting a hook
// under one of those measures it first and adds it here with the date.
const ANNOUNCING_EVENTS = ['UserPromptSubmit'];

const CODEX_EXIT = 0;

// PLUGIN_ROOT alone is not enough to identify the host. It carries no vendor
// prefix, so a shell profile that exports it, or any other tool that calls its
// own install directory that, would put a Claude Code hook on the Codex branch,
// where it exits 0 and writes to stdout. PostToolUse sends that to the debug
// log, so the sentence would reach nobody: the exact regression the exit-code
// reasoning above exists to prevent, arriving through a variable name instead
// of a number.
function sayFor(event) {
  return 'say(){ if [ -n "${PLUGIN_ROOT}" ] && [ "${PLUGIN_ROOT}" = "${CLAUDE_PLUGIN_ROOT}" ]; then printf '
    + `'{"hookSpecificOutput":{"hookEventName":"${event}","additionalContext":"%s"}}' "\${2:-$1}"; `
    + `exit ${CODEX_EXIT}; fi; printf '%s\\n' "$1" >&2; exit ${GUARD_EXIT}; }; `;
}

// The stderr-only branch below writes `printf`, as CLAUDE.md requires. It wrote
// `echo` until 2026-08-18, knowingly, because /bin/sh and /bin/zsh both read a
// backslash in an `echo` argument as an instruction, and that shape was carried
// by four other plugins that a single pull request is not allowed to touch.
//
// What changed is only which form this generator emits, and so which one the
// "Prefix each command with" hint teaches. GUARD_RE accepts both, so
// unconverted commands still parse as guards and are still checked. Queue entry
// 2026-08-17T18-32-15-hook-executable-test holds the agreement: each plugin's
// share lands in that plugin's next release, and slop-check's landed in the
// pull request that added the SubagentStop hook, where two reviewers
// independently flagged the twelfth `echo` being written.
function clausesFor(target, say) {
  const fire = (message, announced) => {
    if (!say) return `{ printf '%s\\n' "${message}" >&2; exit ${GUARD_EXIT}; }`;
    return announced && announced !== message ? `say "${message}" "${announced}"` : `say "${message}"`;
  };
  return `[ -n "\${CLAUDE_PLUGIN_ROOT}" ] || ${fire(UNSET_MESSAGE)}; `
    + `[ -e "${target}" ] || ${fire(GONE_MESSAGE)}; `
    + `[ -x "${target}" ] || ${fire(notRunnableMessage(target), announcedNotRunnable(target))}; `;
}

// event omitted gives the stderr-only shape, which is what the plugins that
// have not been converted yet still carry.
function guardFor(target, event) {
  return event ? sayFor(event) + clausesFor(target, true) : clausesFor(target, false);
}

// Either printing form, because both are live and neither is wrong to find.
// `printf '%s\\n'` is what CLAUDE.md requires of anything newly written. `echo`
// is what commands predating that rule may still carry, and they are
// converted a plugin at a time as each plugin's next release comes round rather
// than in one repo-wide change. Non-capturing on purpose: every group position
// below this line is counted on by matchGuard.
const PRINTER = "(?:echo|printf '%s\\\\n')";

// Deliberately loose about the messages and the codes, so that a guard carrying
// the wrong ones is still recognised as a guard and reported as wrong, rather
// than not matching and being reported as absent.
const GUARD_RE = new RegExp(
  '^\\[ -n "\\$\\{CLAUDE_PLUGIN_ROOT\\}" \\] \\|\\| \\{ ' + PRINTER + ' "([^"]*)" >&2; exit (\\d+); \\}; '
  + '\\[ -e "([^"]+)" \\] \\|\\| \\{ ' + PRINTER + ' "([^"]*)" >&2; exit (\\d+); \\}; '
  + '\\[ -x "([^"]+)" \\] \\|\\| \\{ ' + PRINTER + ' "([^"]*)" >&2; exit (\\d+); \\}; ',
);

// Same looseness for the newer shape, and the event name is captured rather
// than fixed so a hook declaring one event and announcing another is reported
// instead of silently accepted. Codex validates that name, so a wrong one is a
// hook whose message is thrown away for a second reason.
const SAY_GUARD_RE = new RegExp(
  '^say\\(\\)\\{ if \\[ -n "\\$\\{PLUGIN_ROOT\\}" \\] && \\[ "\\$\\{PLUGIN_ROOT\\}" = "\\$\\{CLAUDE_PLUGIN_ROOT\\}" \\]; then printf '
  + '\'\\{"hookSpecificOutput":\\{"hookEventName":"(\\w+)","additionalContext":"%s"\\}\\}\' "\\$\\{2:-\\$1\\}"; '
  + 'exit (\\d+); fi; printf \'%s\\\\n\' "\\$1" >&2; exit (\\d+); \\}; '
  + '\\[ -n "\\$\\{CLAUDE_PLUGIN_ROOT\\}" \\] \\|\\| say "([^"]*)"; '
  + '\\[ -e "([^"]+)" \\] \\|\\| say "([^"]*)"; '
  // Two arguments on this clause alone: the first names the absolute path and
  // goes to stderr, the second is what Codex is told and names no path. Both are
  // captured, because a guard that announced the path-carrying one would parse
  // here and break only on the plugin roots nobody tests with.
  + '\\[ -x "([^"]+)" \\] \\|\\| say "([^"]*)"(?: "([^"]*)")?; ',
);

// One reading for either shape, so every check below asks the same questions of
// both and a hook cannot escape a check by being written in the other one.
function matchGuard(command) {
  const say = SAY_GUARD_RE.exec(command);
  if (say) {
    const [matched, event, codexExit, exitCode, unset, gonePath, gone, execPath, notRunnable, execAnnounced] = say;
    return {
      matched, event, codexExit: Number(codexExit), announces: true,
      unsetMessage: unset, goneMessage: gone, execMessage: notRunnable,
      // One argument means the announced message is the same one, which is what
      // say() itself does with ${2:-$1}. Reading it the same way keeps this
      // object describing the shell's behaviour rather than the regex's shape.
      execAnnounced: execAnnounced === undefined ? notRunnable : execAnnounced,
      gonePath, execPath,
      unsetCode: Number(exitCode), goneCode: Number(exitCode), execCode: Number(exitCode),
    };
  }
  const legacy = GUARD_RE.exec(command);
  if (!legacy) return null;
  const [matched, unset, unsetCode, gonePath, gone, goneCode, execPath, notRunnable, execCode] = legacy;
  return {
    matched, event: null, codexExit: null, announces: false,
    unsetMessage: unset, goneMessage: gone, execMessage: notRunnable,
    execAnnounced: null,
    gonePath, execPath,
    unsetCode: Number(unsetCode), goneCode: Number(goneCode), execCode: Number(execCode),
  };
}

// `"${CLAUDE_PLUGIN_ROOT}"/bin/hook-node` and `"${CLAUDE_PLUGIN_ROOT}/bin/hook-node"`
// are the same path written two ways, and the two appear in the same command.
const unquote = (token) => token.replace(/"/g, '');

// What a hooks.json command actually asks the shell to do.
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
  const guard = matchGuard(command);
  const work = guard ? command.slice(guard.matched.length) : command;
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
    for (const [event, groups] of Object.entries(parsed.hooks || {})) {
      for (const group of groups) {
        for (const hook of group.hooks || []) {
          const command = hook.command || '';
          const named = command.match(/\/hooks\/([\w.-]+)/);
          if (!named) continue;

          found.push({
            manifest,
            pluginDir,
            command,
            event,
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
  const hooks = declaredHooks();
  assert.ok(hooks.length >= 13,
    `only ${hooks.length} hook commands found, so this is checking almost nothing`);

  const wrong = [];
  for (const h of hooks) {
    const where = `${h.file} in ${h.manifest}`;
    const guard = matchGuard(h.command);

    if (!guard) {
      wrong.push(`${where}: no guard, so it exits 127 with nothing and reads as an interpreter failure`);
      continue;
    }

    const {
      matched, unsetMessage, unsetCode, gonePath, goneMessage, goneCode, execPath, execMessage, execCode,
    } = guard;

    // The event a hook announces has to be the event it is declared under.
    // Codex validates the name, so getting it wrong throws the message away
    // again, and it would do so while every other assertion here still passed.
    if (guard.announces) {
      if (guard.event !== h.event) {
        wrong.push(`${where}: declared under ${h.event} but announces itself as ${guard.event}, so Codex discards the message`);
      }
      if (!ANNOUNCING_EVENTS.includes(guard.event)) {
        wrong.push(`${where}: announces under ${guard.event}, which is not measured to deliver anything in Codex, `
          + `so the sentence is discarded while the hook reports success. Measured to work: ${ANNOUNCING_EVENTS.join(', ')}`);
      }
      if (guard.codexExit !== CODEX_EXIT) {
        wrong.push(`${where}: the Codex branch exits ${guard.codexExit}, and Codex reads any non-zero exit as a failure and drops what the hook said`);
      }

      // The announced message is pasted into a JSON string by a shell that does
      // not know it is writing JSON, so two separate things can spoil it and
      // both are checked.
      for (const [which, announced] of [
        ['unset', guard.unsetMessage],
        ['gone', guard.goneMessage],
        ['not-runnable', guard.execAnnounced],
      ]) {
        if (/[$`]/.test(announced)) {
          wrong.push(`${where}: the ${which} message announced to Codex is ${JSON.stringify(announced)}, which the shell `
            + 'expands. Whatever the expansion holds is pasted in unescaped, so a quote breaks the JSON outright and a '
            + 'backslash or a control character corrupts the sentence, and Codex reports the hook Completed either way. '
            + 'Announce fixed text and keep the absolute path on the stderr line');
        }
        // eslint-disable-next-line no-control-regex
        if (/[\\\x00-\x1f]/.test(announced)) {
          wrong.push(`${where}: the ${which} message announced to Codex is ${JSON.stringify(announced)}, which holds a `
            + 'backslash or a control character. JSON reads it as an escape, so the sentence either fails to parse or '
            + 'parses into something other than what it says, and the second is worse because it looks delivered');
        }
      }

      if (guard.execAnnounced !== announcedNotRunnable(guard.execPath)) {
        wrong.push(`${where}: the not-runnable message announced to Codex is ${JSON.stringify(guard.execAnnounced)}, `
          + `rather than ${JSON.stringify(announcedNotRunnable(guard.execPath))}`);
      }
    }

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

  // The Codex branch inverts every one of those reasons, so it is stated here
  // rather than left as a number chosen inside a builder. A raised review of
  // the guard read exit 0 there as the fault this suite refuses above, which is
  // the right instinct and the wrong host: 0 buries the message on Claude Code
  // and is the only code that delivers it on Codex, which discards stderr on
  // every non-zero exit.
  //
  // What it costs is real and is accepted. Codex marks that hook as having run
  // fine when it did not. Nothing is hidden from the reader, who gets the
  // sentence, which is the entire point; what is lost is the `Failed` label,
  // and that label is what this whole change exists to stop relying on, since
  // it arrives as a bare number nobody can act on.
  assert.strictEqual(CODEX_EXIT, 0,
    `the Codex branch exits ${CODEX_EXIT}, and Codex discards what a hook said on any non-zero exit, `
    + 'so anything but 0 there is the silent failure this guard was written to end');
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
  // Claude Code uses `sh -c`. The docs are specific: "The `command` string is
  // passed to a shell: `sh -c` on macOS and Linux, Git Bash on Windows, or
  // PowerShell when Git Bash isn't installed." A user's login shell never sees
  // it, so fish and csh are not reachable on this host at all.
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

    // The newer shape, run rather than compared. Both branches matter and they
    // fail in opposite directions: the Codex branch going missing leaves the
    // reader on a bare number again, and the Codex branch firing everywhere
    // takes away the stderr line Claude Code does show. So each is asserted
    // under an environment that differs only by PLUGIN_ROOT.
    const EVENT = 'UserPromptSubmit';
    const sayProbe = `${guardFor('${CLAUDE_PLUGIN_ROOT}/bin/hook-node', EVENT)}echo RAN`;
    const sayRun = (env) => {
      const result = spawnSync(shell, ['-lc', sayProbe], { env, encoding: 'utf8' });
      if (result.error) throw new Error(`${shell} could not be run: ${result.error.message}`);
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
    // Deleted rather than left alone, because running this suite from inside a
    // Codex session would otherwise put PLUGIN_ROOT in both environments and
    // the two branches would stop being told apart.
    const withoutCodex = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'no-such-plugin-0.0.0') };
    delete withoutCodex.PLUGIN_ROOT;

    const elsewhere = sayRun(withoutCodex);
    assert.strictEqual(elsewhere.code, GUARD_EXIT,
      `${shell}: off Codex the announcing guard exited ${elsewhere.code} rather than ${GUARD_EXIT}, so Claude Code stops showing the line`);
    assert.strictEqual(elsewhere.err.trim(), GONE_MESSAGE,
      `${shell}: off Codex the announcing guard said ${JSON.stringify(elsewhere.err)} on stderr`);
    assert.strictEqual(elsewhere.out, '',
      `${shell}: off Codex the announcing guard wrote ${JSON.stringify(elsewhere.out)} to stdout, where the message is fed to the model instead of shown`);

    // A PLUGIN_ROOT that came from somewhere other than Codex. This is the
    // collision the two-name test exists to close, and with the old one-name
    // test it took the Codex branch and lost the line entirely.
    const collided = sayRun({ ...withoutCodex, PLUGIN_ROOT: '/opt/some-other-tool' });
    assert.strictEqual(collided.code, GUARD_EXIT,
      `${shell}: a PLUGIN_ROOT that disagrees with CLAUDE_PLUGIN_ROOT was read as Codex, and exiting ${collided.code} sends the sentence to the debug log`);
    assert.strictEqual(collided.err.trim(), GONE_MESSAGE,
      `${shell}: with an unrelated PLUGIN_ROOT the guard said ${JSON.stringify(collided.err)} on stderr`);
    assert.strictEqual(collided.out, '',
      `${shell}: with an unrelated PLUGIN_ROOT the guard wrote ${JSON.stringify(collided.out)} to stdout`);

    const inCodex = sayRun({ ...withoutCodex, PLUGIN_ROOT: path.join(os.tmpdir(), 'no-such-plugin-0.0.0') });
    assert.strictEqual(inCodex.code, CODEX_EXIT,
      `${shell}: under Codex the guard exited ${inCodex.code}, and Codex drops what a hook said on any non-zero exit`);
    assert.strictEqual(inCodex.err, '',
      `${shell}: under Codex the guard wrote ${JSON.stringify(inCodex.err)} to stderr, which Codex discards`);

    let announced;
    try {
      announced = JSON.parse(inCodex.out);
    } catch (error) {
      throw new Error(`${shell}: under Codex the guard wrote ${JSON.stringify(inCodex.out)}, which is not the JSON Codex parses: ${error.message}`);
    }
    assert.strictEqual(announced.hookSpecificOutput.hookEventName, EVENT,
      `${shell}: the announcement names ${announced.hookSpecificOutput.hookEventName}, and Codex rejects output whose event is not the one that fired`);
    assert.strictEqual(announced.hookSpecificOutput.additionalContext, GONE_MESSAGE,
      `${shell}: the announcement carried ${JSON.stringify(announced.hookSpecificOutput.additionalContext)} rather than the sentence`);

    // A plugin root the shell is happy with and JSON is not. Every character
    // here is legal in a POSIX path, and the three spoil the announcement in two
    // different ways, which is why the assertion below compares the delivered
    // sentence rather than only parsing it.
    //
    // The quote closes the string early and the raw tab is a control character
    // JSON forbids, so both make the output unparseable and Codex is handed
    // nothing. The backslash in `back\nbreak` begins a valid JSON escape, so that
    // one parses and delivers a path with a real line break inside it. Checking
    // only that it parsed would call that a pass. Run rather than reasoned about,
    // because the released 0.10.8 passed every other assertion in this suite
    // while doing both.
    for (const awkward of ['quote"root', 'back\\nbreak', 'tab\there']) {
      const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'odd-plugin-'));
      const oddRoot = path.join(odd, awkward);
      fs.mkdirSync(path.join(oddRoot, 'bin'), { recursive: true });
      const oddLauncher = path.join(oddRoot, 'bin', 'hook-node');
      fs.writeFileSync(oddLauncher, '#!/bin/sh\n');
      fs.chmodSync(oddLauncher, 0o644);
      try {
        const oddCodex = sayRun({ ...process.env, CLAUDE_PLUGIN_ROOT: oddRoot, PLUGIN_ROOT: oddRoot });
        assert.strictEqual(oddCodex.code, CODEX_EXIT,
          `${shell}: with ${JSON.stringify(awkward)} in the plugin root the guard exited ${oddCodex.code}, and Codex drops what a hook said on any non-zero exit`);

        let oddAnnounced;
        try {
          oddAnnounced = JSON.parse(oddCodex.out);
        } catch (error) {
          throw new Error(`${shell}: with ${JSON.stringify(awkward)} in the plugin root the guard wrote `
            + `${JSON.stringify(oddCodex.out)}, which Codex cannot parse, so it reports the hook Completed and the `
            + `reader is told nothing: ${error.message}`);
        }
        // Compared, not merely parsed. A backslash that begins a valid JSON
        // escape produces output that parses and says something else, and a test
        // that stopped at JSON.parse would pass over it.
        if (typeof oddAnnounced?.hookSpecificOutput?.additionalContext !== 'string') {
          throw new Error(`${shell}: with ${JSON.stringify(awkward)} in the plugin root the announcement carried no `
            + `sentence at all: ${JSON.stringify(oddCodex.out)}`);
        }
        assert.strictEqual(oddAnnounced.hookSpecificOutput.additionalContext, announcedNotRunnable('${CLAUDE_PLUGIN_ROOT}/bin/hook-node'),
          `${shell}: with ${JSON.stringify(awkward)} in the plugin root the announcement carried `
          + `${JSON.stringify(oddAnnounced.hookSpecificOutput.additionalContext)}`);

        // The stderr line still names the absolute path. That is what makes the
        // announced message allowed to drop it for the reader who does see this
        // line, which is the Claude Code one. The Codex reader does not, and this
        // assertion does not pretend otherwise: it runs the guard again with
        // PLUGIN_ROOT removed, which is the Claude Code environment.
        const oddStderr = sayRun({ ...withoutCodex, CLAUDE_PLUGIN_ROOT: oddRoot });
        assert.strictEqual(oddStderr.err.trim(), notRunnableMessage(oddLauncher),
          `${shell}: with ${JSON.stringify(awkward)} in the plugin root the stderr line was ${JSON.stringify(oddStderr.err)}, `
          + 'so Claude Code lost the path as well and nobody can act on it');
      } finally {
        fs.rmSync(odd, { recursive: true, force: true });
      }
    }

    // The unset state against the announcing shape, which the legacy probe
    // covers and this one did not until a review of #129 said so.
    for (const [what, extra] of [
      ['unset', {}],
      ['empty', { CLAUDE_PLUGIN_ROOT: '' }],
    ]) {
      const env = { ...process.env, ...extra };
      if (what === 'unset') delete env.CLAUDE_PLUGIN_ROOT;

      for (const [host, root] of [['off Codex', null], ['with PLUGIN_ROOT set', '/opt/some-other-tool']]) {
        const withHost = { ...env };
        delete withHost.PLUGIN_ROOT;
        if (root) withHost.PLUGIN_ROOT = root;

        const noRoot = sayRun(withHost);
        assert.strictEqual(noRoot.code, GUARD_EXIT,
          `${shell}: ${host}, with CLAUDE_PLUGIN_ROOT ${what}, the announcing guard exited ${noRoot.code} rather than ${GUARD_EXIT}`);
        assert.strictEqual(noRoot.err.trim(), UNSET_MESSAGE,
          `${shell}: ${host}, with CLAUDE_PLUGIN_ROOT ${what}, it said ${JSON.stringify(noRoot.err)}`);
        assert.strictEqual(noRoot.out, '',
          `${shell}: ${host}, with CLAUDE_PLUGIN_ROOT ${what}, it wrote ${JSON.stringify(noRoot.out)} to stdout`);
      }
    }

    // Healthy under Codex too. A guard that announces on every event would put
    // this line in front of the reader constantly and mean nothing when it is
    // real.
    const healthyInCodex = sayRun({ ...process.env, CLAUDE_PLUGIN_ROOT: healthyRoot, PLUGIN_ROOT: healthyRoot });
    assert.strictEqual(healthyInCodex.out.trim(), 'RAN',
      `${shell}: under Codex the guard blocked a hook whose plugin is present`);
    assert.strictEqual(healthyInCodex.code, 0,
      `${shell}: under Codex a healthy hook exited ${healthyInCodex.code}`);
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

    if (/`?node`? has to be on your/.test(text)) {
      problems.push(`${dir}/README.md still says node has to be on your PATH, which stopped being true`);
    }

    if (!/while a session is already open/i.test(text)) {
      problems.push(`${dir}/README.md does not say what happens when the plugin is updated mid-session`);
    }

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

  // Both guard shapes, built by the generator and read back by the recogniser.
  // Without this the two can drift by one character and nothing notices: a
  // converted hook stops matching, gets reported as unguarded, and worse, comes
  // back from parseCommand with executed: null, so every executable and shebang
  // check downstream goes green over an empty list. That is the failure this
  // file exists to keep out, and it would arrive through the parser rather than
  // through a manifest. Raised in review of the tests on 2026-08-17, when the
  // say shape existed in the generator and no assertion had ever read one.
  // Both targets, not just the one every manifest happens to use today. A target
  // outside the plugin directory has no relative form, so the generator writes
  // one argument to say() instead of two, and a recogniser that insisted on two
  // read it as no guard at all. That is the drift this loop exists to catch and
  // it was live in the first version of this change: the case is here because
  // review found it, not because the earlier loop could have.
  for (const [what, event] of [['announcing', 'PostToolUse'], ['stderr-only', undefined]]) {
    for (const [kind, target] of [
      ['under the plugin directory', '${CLAUDE_PLUGIN_ROOT}/bin/hook-node'],
      ['not under it', 'node'],
    ]) {
      const built = `${guardFor(target, event)}"\${CLAUDE_PLUGIN_ROOT}"/bin/hook-node "\${CLAUDE_PLUGIN_ROOT}"/hooks/x.js`;
      const read = matchGuard(built);
      assert.ok(read, `the ${what} guard the generator writes for a target ${kind} is not recognised by the `
        + 'guard reader, so a hook carrying it would be reported as having no guard at all');
      assert.strictEqual(read.announces, Boolean(event),
        `the ${what} guard for a target ${kind} was read back as announces:${read.announces}`);
      assert.strictEqual(read.goneMessage, GONE_MESSAGE,
        `the ${what} guard for a target ${kind} was read back carrying ${JSON.stringify(read.goneMessage)}`);
      assert.strictEqual(read.execMessage, notRunnableMessage(target),
        `the ${what} guard for a target ${kind} was read back with the stderr message `
        + `${JSON.stringify(read.execMessage)}`);
      if (event) {
        assert.strictEqual(read.event, event,
          `the ${what} guard for a target ${kind} was built for ${event} and read back as ${read.event}`);
        assert.strictEqual(read.execAnnounced, announcedNotRunnable(target),
          `the ${what} guard for a target ${kind} was read back announcing `
          + `${JSON.stringify(read.execAnnounced)}`);
      }
      assert.strictEqual(parseCommand(built, dir).executed, 'plugins/example/bin/hook-node',
        `the parser did not see through the ${what} guard for a target ${kind}, so the file it protects `
        + 'escapes every check built on the parser while those checks report a pass over nothing');
    }
  }

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


check('the guard survives a plugin root holding a backslash', () => {
  // The reason the printing form is a rule rather than a preference, exercised
  // rather than asserted. /bin/sh and /bin/zsh both let `echo` read a backslash
  // in its argument as an instruction, so a root named with one splits the
  // message in two. Claude Code shows the first line of stderr and drops the
  // rest, which means the reader is cut off before the part naming the file or
  // saying to run chmod.
  //
  // Queue entry 2026-08-17T18-32-15-hook-executable-test recorded this as live
  // and untested, because nothing here had ever been run against an awkward
  // root. This is that test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-awkward-'));
  const root = path.join(dir, 'awk\\nward');           // one literal backslash, then n
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const launcher = path.join(root, 'bin', 'hook-node');
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o644 });   // present, not executable

  const fire = (command) => spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: root }),
  });

  const good = fire(guardFor('${CLAUDE_PLUGIN_ROOT}/bin/hook-node'));
  const stderr = good.stderr.replace(/\n$/, '');

  assert.strictEqual(stderr.split('\n').length, 1,
    `the guard message split across lines, so the reader sees only "${stderr.split('\n')[0]}" `
    + 'and never reaches the file name or the chmod instruction');
  assert.ok(stderr.includes(root),
    'the guard message no longer carries the path it is about');
  assert.ok(stderr.includes('chmod +x'),
    'the guard message lost the instruction that tells the reader what to do');
  // A guard that printed the right sentence and then let the hook run would
  // pass every assertion above while guarding nothing.
  assert.strictEqual(good.status, GUARD_EXIT,
    'the guard printed its message and then exited on a code that stops nothing');

  // The other half, and the reason this file cannot simply be switched over.
  //
  // `guardFor` emits the converted shape now, so the three assertions above
  // exercise `printf` and nothing else. The defect being guarded against is
  // carried by commands that have not been converted, and running
  // the new shape says nothing about those. So the old shape is run here too,
  // and pinned to the behaviour that makes it a defect: it splits, and the
  // first line is all a reader ever sees.
  //
  // This is deliberately an assertion that the old form is broken rather than a
  // description of it. When a plugin converts, this fails and tells whoever did
  // it that the last echo is gone, which is a better prompt than a comment.
  const legacy = fire(guardFor('${CLAUDE_PLUGIN_ROOT}/bin/hook-node')
    .split(`printf '%s\\n' `).join('echo '));
  const legacyErr = legacy.stderr.replace(/\n$/, '');

  assert.strictEqual(legacyErr.split('\n').length, 2,
    'the echo form no longer splits on a backslash root. If every command has '
    + 'been converted, delete this half and the queue entry it belongs to');
  assert.ok(!legacyErr.split('\n')[0].includes('chmod +x'),
    'the echo form split somewhere harmless, so this no longer demonstrates the defect');

  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
