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

- `/devin-review-response` — work one complete Devin review round: classify
  every finding, map dependencies before editing, sweep paired files, validate
  the round record, and ship one atomic commit rather than a trail of point
  fixes.
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

## Upgrading to 0.8.1

`/address-devin-review` is now `/devin-review-response`, paired by name with
the planned `/devin-review` persona reviewer. Update saved prompts and muscle
memory to use the new command; the old command name is not retained as an alias.

## Upgrading to 0.3.1

One fewer status. `fix attempted / unresolved` is retired.

Rejecting a fix at the verify gate used to move the entry to that status. It
means "the fix did not land and the file is unchanged", which is an open bug by
any reading, and **no `/list-bugs` filter reached it.** Not the default, not
`open`, not `in progress`. So saying no to a diff removed the entry from every
view that lists outstanding work. It stayed on disk, still counted by
`/whats-breaking`, and invisible to the person who filed it.

A rejected fix now stays `Open`, and the attempt is written to `notes`. Same for
a write that fails partway: the entry stays `Open` with the error in `notes`.
Nothing is lost, because a note is visible in a place a status was not.

The oldest version of this skill, before it was a plugin, did show the status in
its default view, and said why: failed fixes need re-attention so they stay
beside open work. The behaviour and the sentence explaining it were dropped
together in a rewrite, which is why nothing left could say it had been deliberate.

**Nothing to do on upgrade.** Readers still accept the old value, so an entry
written by an earlier version keeps working, and `/apply-fix` treats it as open.
The schema stays at v5: the change is compatible in both directions, and bumping
it would signal a migration that does not exist.

`tests/queue-status-reachable.test.js` now asserts the general rule, that any
status a skill writes is either shown by the default view or marked terminal in
the schema, so this cannot come back under a different name.

## Upgrading to 0.3.0

The first hook in this plugin. `skill-md-check` runs after any Write or Edit,
and when the file is a `SKILL.md` it checks five things and reports back into
the conversation. It never blocks and it never writes.

| Checked | Why |
|---|---|
| Frontmatter is present and closed | Without it the file is markdown, not a skill, and nothing loads it |
| `name:` is set | Required by the loader |
| `name:` matches its directory | The failure this plugin already works around |
| `description:` is set | This is the discovery surface; an undescribed skill never triggers |
| `type:` is `human` or `agent`, **when present** | Validated, not required |

The name-versus-directory check is the reason the hook is worth having. The
directory name is what `/audit-deps` keys on and what `/flag-issue` resolves to
a file. The frontmatter name is what the model reads. While the two disagree
both are correct and neither resolves, so a fix filed against one silently
misses the other. `/audit-deps` carries a `notes` field to record this after the
fact; the hook catches it at the moment of writing instead.

`type:` is checked rather than required on purpose. 10 of the 24 skills
here do not set it, and reporting 10 files that are fine is how a check
teaches you to ignore it.

Nothing to do on upgrade. The hook registers itself and stays quiet on a
well-formed file.

## Upgrading to 0.2.6

The other half of the window bug from 0.2.1. That release gave the cutoff a time
so git would stop filling in the current hour. It still had no timezone, and
git reads an unzoned timestamp as **local time** while the cutoff is computed
with `date -u`.

Measured on a machine at UTC-4, at 19:53 local:

```
--since="2026-07-27 21:53:54"    ->  0 commits   the UTC string, read as local, still in the future
--since="2026-07-27 17:53:54"    -> 13 commits   the same instant written in local time
--since="2026-07-27T21:53:54Z"   -> 13 commits   the same instant, said unambiguously
```

So the window started four hours late here, and would start early east of UTC.
Every count it produced was plausible.

The cutoff is now `YYYY-MM-DDT00:00:00Z`, which also matches the `created_at`
written on every queue and to-build item, so the cutoff and the thing it gets
compared against are finally in the same units.

Found by `/built-check` noticing mid-run that its own window had come back
empty and correcting for the offset by hand. It reported the discrepancy in its
own output.

## Upgrading to 0.2.5

`/built-check` decided where to look on disk purely from an item's `kind`, and
for kind `other` the answer was that disk evidence is not available at all. So
an item whose own text names the file it produced was told there was no sign of
it, even with the file sitting exactly where the item said it would be.

It now reads the item's text first. If `what` or `why` names an explicit
filesystem path, that path is checked whatever the `kind` is, and the kind
conventions are the fallback for items that name nothing. The rule that
evidence must be newer than the item still applies, so a file that was already
there does not close anything.

`reference/SCHEMA.md` changed in the same commit, because it stated the same
rule in different words. "No convention" means there is no layout to guess
from, not that a path is unreachable.

Found by driving `/built-check` during an audit of the skills that had never
been run. It reached the right answer on an item of kind `other` by reading a
path out of the item's text, which nothing in the spec told it to do, so the
next run was free not to.

## Upgrading to 0.2.4

Twenty-four output templates across seven skills told the model to print an em
dash. `slop-check` ships a Stop hook that blocks exactly that, so a skill would
produce its message, the hook would block it, and the model would rewrite it.
Every single time.

Nobody noticed because the rewrite succeeds and the answer still arrives, just
after an extra round trip. The plugins were failing a rule their sibling plugin
enforces.

Two kinds of place had them.

**Quoted messages**, in `flag-issue`, `apply-fix`, `verify-fix`, `revert-fix`,
`list-bugs` and `audit-deps`. The messages say the same things now with a comma
or a full stop.

**Display templates**, the fenced blocks a skill reproduces line for line. These
were missed on the first pass, on the reasoning that a `##` line is a heading
and headings are structure. True of a section heading in a SKILL.md, false
inside a display template: `/list-bugs` printed its table header verbatim on
every single run, and so did `/to-build`. `/built-check` did the same with its
numbered findings, `/find-skill` with its routing list, `/whats-breaking` with
its weekly report, and `/stale-branches` with its per-repository line. Those are
now a plain hyphen or a colon, which the hook does not touch since it blocks
only the em dash character itself.

Prose and section headings keep theirs. Those reach nobody, and rewriting them
would churn a lot of files to fix nothing.

`tests/output-templates.test.js` keeps new ones out, checking both kinds. It is
still not exhaustive: a value written into a file that gets displayed later,
such as a queue entry's `what_expected`, has no syntax marking it as output, and
reaching those means flagging prose. A linter that cries wolf gets switched off.

## Upgrading to 0.2.3

0.2.2 gave the composite key a plugin segment and stopped there. The
**dependency edges** that point at those keys were left as they were, and they
have no way to name a plugin.

An edge is `{target, kind, repo, reason}`. Under a `plugin-repo` root that is
ambiguous, because `cli`, `config`, `hook-io` and `patterns` each exist in more
than one plugin, so an edge naming `cli` cannot say which one is at risk. That is
the same ambiguity the composite key was introduced to remove, still present one
field along.

Edges now carry `plugin` as a **separate field**, with `target` staying bare:

```json
{ "target": "hook-io", "plugin": "guardrails", "kind": "script", "repo": "plugins" }
```

**Folding the plugin into `target` looks equivalent and is not.** `/flag-issue`
copies an edge's `target` verbatim into the `target` field of the dep-review
entry it writes, and a queue entry's `target` is a name on disk that
`/apply-fix` later has to resolve to a file. An edge saying
`"target": "guardrails/hook-io"` produces a queue entry for something called
`guardrails/hook-io`, and nothing on disk is called that.

So the edge needs both halves, because two readers want different things from
it: the key wants the plugin, and the queue entry must not have it.

An existing map keeps working. An edge with no `plugin` resolves through the
same ordered lookup as a key, and one with a slashed `target` is split on the
last `/`. Run `/audit-deps` to rewrite them properly.

## Upgrading to 0.2.2

Two faults, both found the first time `/audit-deps` was run against a real
`plugin-repo` checkout.

**`scripts/` was invisible to every search.** The plugin-repo lookup covered
`skills/`, `hooks/` and `commands/`, and stopped there. In a well-built plugin
the hook and the skill are thin wrappers and the logic sits in `scripts/`, so
that is the file a fix edits. `/flag-issue hook-io` could not resolve and fell
through to asking for a path by hand. Two of the four `guardrails` bugs fixed on
2026-07-27 were in `scripts/`, so this was the ordinary case rather than the
edge. `/flag-issue`, `/audit-deps` and `/built-check` all search it now.

**`DEPS.json` keys collided.** The rule was `{repo}:{name on disk}`, which
assumes the root name tells two things apart. Under a `plugin-repo` root it does
not, because one root holds many plugins. A single root named `plugins` produced:

```
plugins:cli       <- 3 different files
plugins:config    <- 2
plugins:hook-io   <- 2
plugins:patterns  <- 2
```

Later entries overwrote earlier ones, so the map described the wrong file and a
fix to one plugin would flag another plugin's dependents for review.

Under a `plugin-repo` root the key is now `{repo}:{plugin}/{name}`, so
`plugins:guardrails/hook-io` and `plugins:slop-check/hook-io` are separate. The
plugin's own entry keeps a bare key and cannot collide with anything inside it,
since everything inside carries a `/`. `DEPS.json` is now schema v3.

**Lookups fall back rather than failing quietly.** A map can be older or newer
than the reader, so both directions are handled. Readers try the exact key
first, then the bare `{repo}:{target}`, which is what a pre-v3 map stored, then a
match on any key ending `/{target}`, which covers a bare lookup against an
already-qualified map. More than one match is reported as ambiguous rather than
guessed at, because picking sends a fix to the wrong plugin.

A lookup that silently finds nothing is indistinguishable from a target with no
dependents, and those two needed to stay different.

If you already have a `DEPS.json`, it keeps working, via the bare-key step. That
step matches on name alone, so on a pre-v3 map, which is exactly the file where
`plugins:cli` meant three different things, the entry it finds may describe a
different plugin. Readers say so when it happens rather than presenting it as
exact. Run `/audit-deps` to rebuild the keys and the caveat goes away.

## Upgrading to 0.2.1

**If you are on 0.2.0, `/built-check` never read the git log.** It gathered
evidence from three places and one of them silently returned nothing on every
run, so work that was committed hours earlier came back as "no sign of it".

The cutoff was built as a bare `YYYY-MM-DD` and handed to `git log --since=`.
Given a date with no time, git fills in the **current clock time** rather than
midnight. Measured in a real repository on 2026-07-27 at 16:53:

```
--since="2026-07-27"           ->  0 commits
--since="2026-07-27 00:00:00"  -> 39 commits
--since="2026-07-27 16:53"     ->  0 commits
```

So it dropped every commit made before whatever time of day you ran it. Run it
in the morning and most of the boundary day is there. Run it after lunch and it
is gone. For anything added to the list today, the git evidence was empty every
time.

The cutoff now carries an explicit `00:00:00`.

Disk evidence and session evidence were never affected, which is why this was
not obvious: `/built-check` still found things, just never from the log.

**It also now says when the window comes back empty.** Every way that step can
fail, a malformed cutoff, the wrong `date` flag, or a root that is not a
repository, ends at the same place: no commits, and a confident "no sign of it".
One line saying the log returned nothing is the only thing that separates
"nothing was built" from "nothing was looked at".

## Codex

Codex plugins cannot register hooks, and this plugin does not use any, so both
runtimes get the same thing: eleven commands you invoke. Nothing is degraded here.

## Licence

MIT. See `LICENSE` at the repository root.
