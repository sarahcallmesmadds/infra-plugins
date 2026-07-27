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

## The ten commands

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

- `/audit-deps` — scan every configured root and reconcile what is on disk
  against the dependency map.
- `/whats-breaking` — a weekly view of what broke, what got fixed, and what
  keeps coming back.
- `/find-skill` — route an intent to the right skill, by scanning what is
  actually installed rather than a list someone maintained by hand.

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
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install build-loop@smadds
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that one file, the plugin folders
never arrive, and the install fails.

## Where it keeps its state

Queue entries, the to-build list, the dependency map, and weekly summaries live
in `~/.claude/build-loop/`. That directory is yours: it is per-machine, it is
not part of this plugin, and nothing here ever deletes it.

```
~/.claude/build-loop/
  queue/          one JSON file per correction
  to-build/       one JSON file per thing you plan to build
  DEPS.json       the dependency map
  summaries/      weekly rollups
```

The formats are documented in `reference/SCHEMA.md`, `reference/SCHEMA-BUILD.md`
and `reference/SCHEMA-DEPS.md`, which ship with the plugin.

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

**It never writes without asking.** Every command that changes a file shows you
a draft or a diff first and stops. There is no silent-write path.

**It never pushes.** Fixes are committed locally. Pushing stays a deliberate
thing you do.

**It never closes a to-build item on its own.** `/built-check` will tell you
what it found and name the file or the commit it found it in. Closing is your
answer, not its conclusion.

**It does not judge quality.** It records what you said was wrong. It has no
opinion about whether something is any good, and it will not rewrite anything
you did not complain about.

## Codex

Codex plugins cannot register hooks, and this plugin does not use any, so both
runtimes get the same thing: ten commands you invoke. Nothing is degraded here.

## Licence

MIT. See `LICENSE` at the repository root.
