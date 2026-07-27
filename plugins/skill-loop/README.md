# skill-loop

The maintenance half of writing your own skills.

Writing a skill is the easy part. The work is noticing it did the wrong thing,
remembering that a week later when you have time to fix it, and knowing what
else you break when you do. Most people's skill libraries rot at exactly that
point, not at the authoring step.

This is the loop that stops it: log the correction the moment you notice it,
work the queue when you have time, and get told which other skills a fix puts
at risk before you change anything.

## The eight skills

**Catch it**

- `skill-flag-issue` — log what a skill got wrong, while the session that
  proves it is still in front of you. Pre-fills the skill name, what happened,
  and what you expected from the conversation, shows you a draft, and writes
  nothing until you confirm. Dedupes against the last ten minutes so a
  frustrated double-report does not become two entries.

**Work it**

- `skill-list-bugs` — what is open, grouped and readable.
- `skill-apply-fix` — take an entry, read the skill, propose one surgical
  change, and show a plain-language before and after. Nothing is written
  until you say yes. The fix is committed so it can be undone.
- `skill-verify-fix` — confirm a fix actually worked before closing it.
- `skill-revert-fix` — undo a fix that did not, with `git revert` rather than
  history rewriting, and put the entry back to open.

**Keep it honest**

- `skill-audit-deps` — scan every configured root and reconcile what is on
  disk against the dependency map.
- `skill-summarize` — a weekly view of what broke, what got fixed, and what
  keeps coming back.
- `skill-find` — route an intent to the right skill, by scanning what is
  actually installed rather than a list someone maintained by hand.

## Why a dependency map

The failure this is built around: you fix skill A, and skill B quietly breaks
because it depended on something A did. You find out weeks later.

`skill-flag-issue` reads the map after logging a correction and automatically
raises a review entry for each dependent. `skill-apply-fix` warns you before
touching anything with dependents. `skill-audit-deps` keeps the map true.

## Install

```
/plugin marketplace add sarahcallmesmadds/plugins
/plugin install skill-loop@smadds
```

Add the marketplace **by repository**, as above. Adding it by pasting a direct
URL to `marketplace.json` downloads only that one file, the plugin folders
never arrive, and the install fails.

## Where it keeps its state

Queue entries, the dependency map, and weekly summaries live in
`~/.claude/skill-loop/`. That directory is yours: it is per-machine, it is not
part of this plugin, and nothing here ever deletes it.

```
~/.claude/skill-loop/
  queue/          one JSON file per correction
  DEPS.json       the dependency map
  summaries/      weekly rollups
```

The entry and map formats are documented in `reference/SCHEMA.md` and
`reference/SCHEMA-DEPS.md`, which ship with the plugin.

## Configuration

Everything works with no configuration, against the skills installed at
`~/.claude/skills`.

If you also develop skills somewhere else, say a repository you edit and then
install from, tell it about both. Create `~/.claude/skill-loop.config.json`:

```json
{
  "skillRoots": [
    { "name": "personal", "path": "~/.claude/skills" },
    { "name": "work", "path": "~/src/team-skills" }
  ]
}
```

Each root needs a `name` and a `path`. The name is recorded on every queue
entry, so a fix is always committed in the repository the skill actually lives
in. Roots are searched in order. A skill found under none of them is recorded
as `unknown`, and the skills refuse to guess a repository rather than
committing somewhere arbitrary.

Within a root, both `<root>/<skill>/SKILL.md` and
`<root>/<skill>/skill/SKILL.md` are found, so a repository that nests the
definition one level deeper still works.

## What it will not do

**It never writes without asking.** Every skill that changes a file shows you
a draft or a diff first and stops. There is no silent-write path.

**It never pushes.** Fixes are committed locally. Pushing stays a deliberate
thing you do.

**It does not judge skill quality.** It records what you said was wrong. It has
no opinion about whether a skill is any good, and it will not rewrite one you
did not complain about.

## Codex

Codex plugins cannot register hooks, and this plugin does not use any, so both
runtimes get the same thing: eight skills you invoke. Nothing is degraded here.

## Licence

MIT. See `LICENSE` at the repository root.
