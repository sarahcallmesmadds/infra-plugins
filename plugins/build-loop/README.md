# build-loop

The maintenance half of building your own tooling.

Writing a skill is the easy part. The work is noticing it did the wrong thing,
remembering that a week later when you have time to fix it, and knowing what
else you break when you do. Most people's libraries rot at exactly that point,
not at the authoring step.

This is the loop that stops it: log the correction the moment you notice it,
work the queue when you have time, and get told what else a fix puts at risk
before you change anything.

It covers everything you build, not only skills. A hook, a slash command, a
whole plugin, and a loose script are all things that can misbehave, and all of
them are things you forget you meant to fix.

## The eleven commands

**Catch it**

- `/flag-issue` — log what something got wrong, while the session that proves
  it is still in front of you. Pre-fills the name, what happened, and what you
  expected from the conversation, shows you a draft, and writes nothing until
  you confirm. Dedupes against the last ten minutes so a frustrated
  double-report does not become two entries.

**Work it**

- `/list-bugs` — what is open, grouped and readable.
- `/apply-fix` — take an entry, read the file, propose one surgical change, and
  show a plain-language before and after. Nothing is written until you say yes.
  The fix is committed so it can be undone.
- `/verify-fix` — confirm a fix actually worked before closing it.
- `/revert-fix` — undo a fix that did not, with `git revert` rather than
  history rewriting, and put the entry back to open.

**Remember what you meant to build**

- `/to-build` — write down something you plan to build, or run it with nothing
  after it to see the list. A wish list nobody reads is worse than no list, so
  every item records what it is and why you wanted it.
- `/built-check` — go and look at whether any of it actually got built, and
  offer to close the finished items in one answer. It reads the git log of every
  configured root, checks what is on disk, and shows you the evidence for each
  one before closing anything. Meant for the end of a session.

**Keep it honest**

- `/devin-review-response` — work one complete Devin review round across the
  GitHub app and every known proactive CLI run for the same commit. A clean
  result from one source cannot erase findings from another; the skill then
  classifies every finding, validates the PR branch and every push destination,
  ships one atomic commit when needed, and asks before posting the disposition
  table.
- `/audit-deps` — scan every configured root and reconcile what is on disk
  against the dependency map.
- `/flag-patterns` — a weekly view of what broke, what got fixed, and what
  keeps coming back. It also reports a pushback rate, described below.
- `/find-skill` — route an intent to the right skill, by scanning what is
  actually installed rather than a list someone maintained by hand.

## The pushback rate

The queue records what you noticed and took the trouble to log. It misses the
other half: the times an answer did not land and you said so in the conversation
rather than filing anything. Those are already written down, because Claude Code
keeps a transcript of every session on disk.

`/flag-patterns` reads them and reports one number, pushbacks per hundred
eligible typed messages, broken down by kind. Pasted material and messages over
the detector's 800-character classification boundary are excluded from both
sides; the report states how many long messages it skipped. You can also run it directly:

```bash
node plugins/build-loop/scripts/pushback.js --days 7
```

**That number is the scoreboard for any rule about how answers get written.** A
rule that does not move it is not working, and writing more rules will not
change a flat line.

Three things it is careful about, because each one is a way this could quietly
lie to you:

**It counts only what was said.** Giving up on an answer and working around it
leaves no trace, so every figure is a floor rather than a measurement. The report
says this itself.

**It is measured against your own words, not against a demo.** The detector is
checked with `--selftest` against a labelled set of your real messages kept at
`~/.claude/build-loop/pushback-fixture.json`, which never enters this repository.
The test suite here proves the script is wired up and deliberately does not claim
to prove it is accurate, because a public repository is the wrong home for
somebody's unguarded messages. A catch rate under about 90 per cent means the
patterns have drifted from how you write and the weekly number is understating
things.

**Your quotes stay on your machine, and getting that wrong takes effort.** Add
`--quotes` and the report includes your own messages, which is what makes a
pattern worth acting on when you are the one reading it. Leave it off, which is
the default, and you get the rate and the counts and none of the words. The
skill uses the plain form for anything it posts, the direct message included.

The first version had this backwards. Quoting was on by default and one string
comparison stood between a private message and a Slack post, and review found
three ways past it in a single pass. A control that fails by publishing somebody's
messages has to fail closed, so now there is no format string to misspell: a typo,
a wrong flag or a half-remembered option gets you counts or an error, never the
quotes.

## Why a dependency map

The failure this is built around: you fix A, and B quietly breaks because it
depended on something A did. You find out weeks later.

`/flag-issue` reads the map after logging a correction and automatically raises
a review entry for each dependent. `/apply-fix` warns you before touching
anything with dependents. `/audit-deps` keeps the map true.

The edge that gets missed most often crosses kinds. A hook writes a file a skill
reads, neither file mentions the other, and nothing connects them until
something breaks. The map is where that gets written down.

## Install

```
/plugin marketplace add sarahcallmesmadds/infra-plugins
/plugin install build-loop@infra-plugins
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that one file, the plugin folders
never arrive, and the install fails.

**Requires Node.js.** The hooks are plain Node scripts with no dependencies
to install, and `node` does not have to be on your `PATH`. Each hook is
started by `bin/hook-node`, which tries `$CLAUDE_HOOK_NODE`, then your
`PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and
`/usr/bin`, and uses the first one it finds.

`/devin-review-response` also requires the GitHub CLI (`gh`) to be installed and
authenticated for the repository it reviews. Run
`gh auth login --hostname github.com` yourself once if needed. The skill checks
`gh auth status --hostname github.com` before starting and stops plainly
when GitHub evidence cannot be read; other Build Loop commands do not require
this setup.

That list exists because an app launched from the Dock never reads your shell
profile, so it starts with a bare `PATH` that has none of those directories
on it. Before 0.9.8 every hook here exited 127 under Codex for that reason,
and silently, because a failed hook does not interrupt your session.

These hooks run in both Claude Code and Codex.

Updating a plugin while a session is already open stops the hooks a second
way, unrelated to finding Node. The session is still pointing at the version
folder it started in, and Codex deletes that folder on update, so every hook in
that session fails until you restart. Each hook now checks that the file it is
about to run is still there. If it has gone, it prints one line saying hooks
are off until you restart, and steps aside. That does not keep the hooks
working, which nothing in the plugin can do from a folder that has been
deleted, but it tells you why they stopped instead of leaving you a bare error
code. If the file is there and has simply lost its execute bit, which a zip
download or a checkout without file modes can do, it says that instead and
names the file, because a restart will not fix that one. The line shows up in
the transcript once per hook per event, and blocks nothing.

If your Node is somewhere else, name it:

```
export CLAUDE_HOOK_NODE=/path/to/node
```

Name the node program itself, not the directory holding it. When that variable
is set it is the only interpreter tried, and a value that is not an executable
file is an error rather than a reason to look elsewhere. Naming an interpreter
and silently getting a different one hides the mistake, and a directory passes
an executable check while starting nothing. If
nothing is found, the hook exits 127 and `hook-health-probe.sh` records a line
in `~/.claude/build-loop/hook-health.log` naming what was searched.

## Where it keeps its state

Queue entries, the to-build list, the dependency map, and weekly summaries live
in `~/.claude/build-loop/`. That directory is yours: it is per-machine, it is
not part of this plugin, and nothing here ever deletes it.

```
~/.claude/build-loop/
  queue/              one JSON file per correction
  to-build/           one JSON file per thing you plan to build
  DEPS.json           the dependency map
  summaries/          weekly rollups
  hook-health.log     written only when a hook's interpreter goes missing
```

The formats are documented in `reference/SCHEMA.md`, `reference/SCHEMA-BUILD.md`
and `reference/SCHEMA-DEPS.md`, which ship with the plugin.

**`hook-health.log` is the one file written without you asking, and on most
machines it never appears at all.** The `hook-health-probe` hook runs on every
prompt, checks that the commands the other hooks need can still be found, and
writes nothing while they can. A hook that fails with exit code 127 leaves no
record anywhere in Claude Code, so this exists to name the missing command at
the moment it goes missing rather than a week later.

It writes one line when something breaks, nothing more while it stays broken,
and one line when it comes back. A failure line carries the `PATH` that was
searched, because "not found" is a question about where the search looked, with
your home directory reduced to `~` so the line describes the search rather than
the machine. It is still a diagnostic, so read it before pasting it somewhere
public, the same as you would any other. The probe prints nothing to the
conversation while it can run, and never blocks a prompt whatever happens. The
one exception to its silence is the guard described above: if the probe file
itself has gone because the plugin was updated mid-session, you get that one
line instead of nothing. Deleting the log is safe: nothing reads it but you.

## Configuration

Everything works with no configuration, against three default locations:
skills at `~/.claude/skills`, hooks at `~/.claude/hooks`, and commands at
`~/.claude/commands`.

If you also develop somewhere else, say a repository you edit and then install
from, tell it about that too. Create `~/.claude/build-loop.config.json`:

```json
{
  "roots": [
    { "name": "personal", "path": "~/.claude/skills",   "kind": "skill" },
    { "name": "hooks",    "path": "~/.claude/hooks",    "kind": "hook" },
    { "name": "commands", "path": "~/.claude/commands", "kind": "command" },
    { "name": "work",     "path": "~/src/team-skills",  "kind": "skill" },
    { "name": "plugins",  "path": "~/src/my-plugins",   "kind": "plugin-repo" }
  ]
}
```

Each root needs a `name`, a `path`, and a `kind` of `skill`, `hook`, `command`,
or `plugin-repo`. The kind decides how a name is turned into a file: a skill
root is searched for `<name>/SKILL.md`, a hook root for `<name>` or `<name>.*`,
and a command root for `<name>.md`.

**If you write your skills inside plugins rather than loose in `~/.claude`,
`plugin-repo` is the one you want.** It points at a checkout of a marketplace
repository and looks one level deeper, at
`plugins/<plugin>/skills/<name>/SKILL.md` and the `hooks/` and `commands/`
directories beside it. What kind a thing is then comes from which of those it
was found in.

Point that root at the checkout you actually edit, never at
`~/.claude/plugins/marketplaces/`. That tree is the plugin manager's cache and
it is overwritten on the next update, so a fix committed there disappears with
no warning. The commands refuse to record a path inside it for that reason.

None of the three default locations existing is normal on a machine where
everything is installed from marketplaces. Nothing will resolve automatically
until you add a root, and the commands say so once instead of asking you for a
path every time.

The name is recorded on every queue entry, so a fix is always committed in the
repository the file actually lives in. Roots are searched in order. Anything
found under none of them is recorded as `unknown`, and the commands refuse to
guess a repository rather than committing somewhere arbitrary.

Within a skill root, both `<root>/<name>/SKILL.md` and
`<root>/<name>/skill/SKILL.md` are found, so a repository that nests the
definition one level deeper still works.

An older config using `skillRoots` instead of `roots` still works and is read as
a list of skill roots. You do not need to change it.

## What it will not do

**No command writes without asking.** Every command that changes a file shows
you a draft or a diff first and stops. Writing an edge means writing the
sentence explaining why two things are connected, and that is a judgment
`/audit-deps` still takes to you for approval.

**One file is still written unattended, and it is not a command.**
`hook-health.log` is written by a hook, only when a hook's interpreter goes
missing, and it is described under "Where it keeps its state" above. It is the
only such file.

There used to be a second: `deps-watch` stamped a machine-check date onto a
`DEPS.json` entry after an ordinary edit. That stamp was removed on 2026-08-15
because nothing read it, so the hook now only reports, in the conversation, when
a file calls something the map does not record.

**It never pushes.** Fixes are committed locally. Pushing stays a deliberate
thing you do.

**It never closes a to-build item on its own.** `/built-check` will tell you
what it found and name the file or the commit it found it in. Closing is your
answer, not its conclusion.

**It does not judge quality.** It records what you said was wrong. It has no
opinion about whether something is any good, and it will not rewrite anything
you did not complain about.

`type:` is checked rather than required on purpose. 11 of the 23 skills
here do not set it, and reporting 11 files that are fine is how a check
teaches you to ignore it.

## Codex

**The eleven commands are identical on both runtimes.** Everything you invoke by
name behaves the same way, reads the same queue, and writes the same files.

**The hooks run in Codex too.** This section has now been wrong twice in
opposite directions, which is worth leaving on the record rather than tidying
away. It first said the plugin used no hooks, which stopped being true at 0.3.0.
It was then corrected to say the hooks are Claude Code only, because Codex
plugins cannot register them. That is also wrong, and it was wrong from the day
it was written.

The mistake both times was reading the manifest instead of the host.
`.codex-plugin/plugin.json` has no hooks field, and the inference drawn was that
Codex therefore ignores hooks. Measured on 2026-08-16 with a probe hook added to
the Codex-installed copy: Codex has its own hooks engine, reads each installed
plugin's `hooks/hooks.json`, knows the full event vocabulary including
`SessionStart`, `UserPromptSubmit` and `PostToolUse`, and runs every command
through a login shell. All five hooks fire.

A table used to sit here listing what a Codex user should do by hand instead of
each hook. Every row answered a question that does not arise, so it is replaced
rather than corrected. What the hooks are, on both runtimes:

| Hook | What it does |
|---|---|
| `skill-md-check` | Checks a `SKILL.md` you just wrote or edited against the frontmatter rules, and says what is wrong. |
| `notice-correction` | Notices when you have corrected something you built and suggests `/flag-issue` once, at the end. It only suggests; it never writes. |
| `capture-event` | Records the shape of the hook payloads it sees, so a test fixture can be a real captured event rather than one written from memory. |
| `deps-watch` | Reports in the conversation when a file calls a mapped target with no recorded edge. It never writes an edge itself; `/audit-deps` is the only way to record one. |
| `hook-health-probe` | Runs on every prompt and names the interpreter a hook could not find, at the moment it goes missing rather than a week later. |

**What is actually different is updating, not hooks.** Codex replaces a plugin's
version folder on update, so a session that was already open points at a folder
that has gone and every hook in it stops until you restart. Claude Code keeps
old versions, so that session instead carries on running the code it started
with, which is the same fact failing in the other direction. Since 0.10.7 the
hooks say which has happened rather than failing with a bare error code.

The two hosts need that sentence delivered differently, so since 0.10.8 the
hooks that run on every prompt check which one they are in. Claude Code shows
the first line a hook writes to stderr when it exits non-zero, so that is what
it gets. Codex discards stderr on any non-zero exit and shows a bare number
instead, so there it gets the one route Codex does surface: a zero exit carrying
the sentence as structured output. The two are told apart by `PLUGIN_ROOT` and
`CLAUDE_PLUGIN_ROOT` both being set and agreeing, since Codex sets the pair to
the same value and Claude Code sets only the prefixed one. Both are required
because `PLUGIN_ROOT` carries no vendor prefix, so alone it would put a Claude
Code hook on the Codex branch and lose the sentence.

Only the prompt hooks. Codex was measured on 2026-08-17 to deliver that
structured output for `UserPromptSubmit` and to discard it for `PostToolUse`,
where the hook is reported as having completed and the message goes nowhere. So
this plugin's `PostToolUse` hooks keep the stderr form, as do the other plugins,
and any future conversion measures its own event first.

The sentence Codex is told names no path, and since 0.10.10 that is deliberate.
The structured output is JSON built by pasting the message into a `printf`
format, and the shell has no idea it is writing JSON, so anything expanded into
it can break the syntax. A plugin directory holding a double quote, a backslash,
a tab or a newline all do, and they spoil it in two ways. A quote, or a raw
control character, or a backslash that begins no JSON escape, make the output
unreadable, so Codex is handed nothing. A backslash that does begin one, and
`\n`, `\t` and `\b` in a path all do, produces output that reads perfectly and
says something other than what was written: a directory named `back\nbreak`
announced a path with a real line break inside it. Either way the hook is
reported as having completed, and the second is the worse of the two because it
looks delivered. That is the failure this whole guard exists to end.

Escaping it in the shell was the first answer and the wrong one, because it needs
`sed`, which needs `PATH`, and a broken `PATH` is one of the things these hooks
have to be able to complain about. So the sentence Codex is told names the file
relative to the plugin directory, which is fixed text in the manifest and cannot
be corrupted by whatever the directory happens to be called.

**A Codex reader does not get the absolute path at all, and that is the cost.**
The Codex branch exits as soon as it has written its JSON, so it never reaches
the stderr line, and the only field Codex surfaces is the sentence itself. What
that reader gets is the file's name and its place inside the plugin directory,
which is enough to find it, and not the full path they could paste into a `chmod`.
Claude Code, which reads the stderr line, still gets the whole path. The trade is
deliberate: on the Codex side the alternative was not a longer message but no
message, since that is what a malformed announcement delivers.

The stderr line in these two hooks uses `printf` rather than `echo` for a related
reason. `/bin/sh` and `/bin/zsh` both interpret a backslash in `echo`'s argument,
so a plugin directory named `back\nbreak` reached the reader with a real line
break in the middle of the path, and only the first line of stderr is shown.
**This is fixed in the two prompt hooks only.** The `PostToolUse` hooks here, and
the guards in the other four plugins, still use `echo` and still mangle a path
holding a backslash. Changing those means changing five plugins at once, so it is
not in this version.

## Licence

MIT. See `LICENSE` at the repository root.
