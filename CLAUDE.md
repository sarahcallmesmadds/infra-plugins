# infra-plugins

Claude Code plugins, published from this repository to a marketplace. One folder per plugin
under `plugins/`, each installable on its own.

**How to build, structure and release a plugin: read `CONTRIBUTING.md`.** It is the only home
for that. Restating it here is how three copies of the filing rule in the always-allow repo
drifted into three different answers.

## Layout

- `plugins/<name>/`: one plugin. Skills, hooks, scripts, its own README and two manifests
- `plugins/<name>/bin/hook-node`: the launcher every JS hook is started through
- `tests/`: one suite per subject, all of them run by `tests/run-all.js`
- `.claude-plugin/marketplace.json`: the published catalogue

## Rules that are not obvious from the code

**A fix for one plugin never rides along in a pull request for another.** It costs an extra
pull request and it is worth it. Two plugins in one change means two version bumps and a title
that lies about half its content.

**The launcher is copied into every plugin on purpose.** Plugins install independently and one
cannot reach into another, so a single shared copy at the repository root would be absent for
anyone who installed a single plugin. `tests/hook-executable.test.js` asserts the copies stay
byte-identical, which is what makes the duplication safe rather than a liability.

**Anything written into a user's own `settings.json` names an absolute interpreter, never a
path inside the installed plugin directory.** That directory carries a version number and is
replaced on update, so a setting pointing into it rots silently: the file is still there, the
setting still looks right, and nothing runs.

**This checkout can be shared by more than one live session.** Use a `git worktree` for branch
work rather than `git checkout -b` in the shared tree. Two sessions on one working tree means
either can overwrite the other's edits without seeing them.

**A merged fix is not a running fix.** Before running a skill whose behaviour just changed,
look at the installed copy under `~/.claude/plugins/cache/` and confirm the change is visibly
in it. Trusting the version number is how a fix gets verified against code that is not the
code running. The same applies to any script this repository ships: run it from the newest
installed copy, not from whichever copy the current session happens to have loaded.

**`memoryBudget.totalWords` is not enforced, and must not be made enforceable again.** A
directory of individually compliant files exceeds any fixed total once there are enough of
them. Enforcing it produces a warning nobody can clear, and a warning nobody can clear gets
the whole check switched off, which costs more than the thing it was measuring.

**Write a comment for someone who does not know the code ever behaved differently.** A
comment earns its place by naming a way this code has failed or can fail, together with
whatever makes that warning believable instead of ignorable: "strip the guard first" gets
ignored, "strip it, or eight checks pass over an empty list" does not. A comment that only
records which pull request found something, who caught it, or on what date does not earn its
place, because git keeps all three. **When it is not clear which of the two a comment is, keep
it.** Deleting is the direction that loses information, so it carries the burden of proof, and
the first pass at this rule cut two warnings that a reviewer had to put back.

**A hook that needs to warn the reader writes one line to stderr and exits 3.** Claude Code
surfaces the first line of stderr and nothing else, so that line carries the whole message. Any
non-zero code works except two: 2 is a blocking error and blocks the tool call on `PreToolUse`,
and 127 is what the shell says for a command it cannot find, which is also what `bin/hook-node`
reports for its own interpreter failure. Exiting 0 on this route sends the message to the debug
log, where nobody reads it.

**Codex never sees a stderr warning.** It discards stderr on every non-zero exit and prints the
number alone. The one route it surfaces is `hookSpecificOutput.additionalContext` on stdout with
exit 0, and only for events measured to deliver it. Measure the event before converting a hook
to announce under it: `UserPromptSubmit` was measured on 2026-08-17 to deliver it and
`PostToolUse` to discard it while still reporting the hook `Completed`, which is worse than a
failure because both the reader and the test suite read it as working. `PreToolUse`, `Stop` and
`SessionStart` are unmeasured rather than known to fail.

**Identify the host by `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` both being set and agreeing.**
Codex sets the pair to the same value and Claude Code sets only the prefixed one. Both halves of
the test are load-bearing, because `PLUGIN_ROOT` carries no vendor prefix, so reading it alone
puts a Claude Code hook on the Codex branch and loses the message entirely.

**Nothing the shell expands may reach an announced message.** That JSON is built by pasting, so
a plugin directory holding a quote or a control character breaks the syntax and Codex is handed
nothing, and one holding a valid JSON escape such as `\n` parses and delivers a corrupted
sentence, which is worse because it looks delivered. Keep the absolute path on the stderr line,
which only Claude Code reads, and have the announced sentence name the file relative to the
plugin directory as fixed text. Print it with `printf`, never `echo`, which `/bin/sh` and
`/bin/zsh` both let mangle a backslash.

**Release notes go in the plugin's `CHANGELOG.md`, never in its README.** A README is what
somebody reads to install and use the plugin, and upgrade notes for versions nobody is running
push that to the bottom of a long file. build-loop is the worked example. `guardrails` and
`git-hygiene` still keep theirs in the README and want the same treatment.

**Nothing personal belongs in this repository, because it is public.** That covers the
maintainer's own vocabulary, worked examples and transcripts. A test fixture is a publishing
surface like any other file here, so fixtures are written for the test rather than lifted from
real material. Any labelled set of real messages stays outside the repository and is never
committed.

## Verifying a change

`node tests/run-all.js` runs every suite. Continuous integration runs the same command on
Linux and macOS, and that run is the checkable evidence for a pull request, since a local
result cannot be reproduced by a reviewer.
