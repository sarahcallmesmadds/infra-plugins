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

**Write a comment for someone who does not know the code ever behaved differently.**
Keep one if a reader who ignores it would break something: a warning earns its place, and so
does the evidence that makes anyone believe it, as in "strip the guard first, or eight checks
silently passed over an empty list". Delete one if ignoring it would only leave the reader
less informed. Which pull request found it, who caught it and on what date belong in the
commit message, where git already keeps them. On 2026-08-17 one test file held 663 lines of
comment against 670 of code, and half of it was the file narrating its own past.

**Release notes go in the plugin's `CHANGELOG.md`, never in its README.** A README is what
somebody reads to install and use the plugin. build-loop's had grown to 844 lines of which 456
were upgrade notes for twelve past versions, so a new reader opened a changelog. guardrails and
git-hygiene still carry theirs in the README and want the same treatment.

**Nothing personal belongs in this repository, because it is public.** That covers the
maintainer's own vocabulary, worked examples and transcripts. A test fixture is a publishing
surface like any other file here, so fixtures are written for the test rather than lifted from
real material. Any labelled set of real messages stays outside the repository and is never
committed.

## Verifying a change

`node tests/run-all.js` runs every suite. Continuous integration runs the same command on
Linux and macOS, and that run is the checkable evidence for a pull request, since a local
result cannot be reproduced by a reviewer.
