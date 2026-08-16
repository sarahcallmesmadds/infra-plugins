---
name: built-check
type: human
description: Cross-checks the to-build list at ~/.claude/build-loop/to-build/ against what has actually been built, and offers to close the finished items in one step. Looks for evidence in the git log of every configured root, on disk, and in the current session. Use at the end of a session, when wrapping up, or when the user asks "what did I ship", "did I build any of this", "close the ones I've done", "is anything on the list done", or explicitly invokes /built-check. Shows the evidence for each item and closes nothing without an explicit yes.
argument-hint: "[optional: number of days back to look, default 90]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mktemp:*), Bash(mv:*), Bash(rm:*), Bash(node:*), Bash(git:*), Bash(find:*), Bash(stat:*)
---

You are reconciling the to-build list against reality. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA-BUILD.md`. Read it if you have not already in this session.

The problem this solves: things get built and the list never gets updated, so the list slowly stops being true and then stops being read. This closes that gap by going and looking.

Two rules that do not bend:

1. **Evidence before verdict.** Never mark something built because it sounds like it was probably built. Name the file, the commit, or the directory you found.
2. **Nothing closes without an explicit yes.** The user can close several items in one answer, which is the point, but the yes is still theirs.

> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

---

**Scratch files go in a private directory, made once per run.** Before the first
hand-off, create it and reuse it for the rest of the run:

```bash
mktemp -d "${TMPDIR:-/tmp}/build-loop.XXXXXX"
```

Written out in full rather than as `mktemp -d -t build-loop`, which is BSD only.
GNU coreutils wants at least six `X` characters in the template and exits 1 on
the short form, so on Linux the directory is never created and every hand-off
that reads from it fails. `built-check` pairs `date -u -v-{days}d` with a
`date -u -d` fallback for the same reason.

Use the path it prints, written as `{scratch}` below. Never a fixed name under
`/tmp`. Two reasons, and the second is the one that bites on this machine. A
fixed name is world-readable and another local user can replace it between the
Write and the call, so what lands in the list is not what was composed. And a
fixed name is shared between sessions: with two in flight, which is the premise
of this whole change, one session's Write lands between the other's Write and
its call, and the wrong text is recorded against the wrong item.

---

## Step 1 — Load the open items

```bash
ls ~/.claude/build-loop/to-build/*.json 2>/dev/null
```

If nothing comes back:

> "The to-build list is empty, so there is nothing to reconcile. Run `/to-build <something>` to add an item."

Stop.

Read each file. Keep only items with status `Open` or `In Progress`. Skip `Built` and `Dropped` silently, they are already settled.

If every item is already settled:

> "Nothing open on the to-build list. {N} built, {M} dropped."

Stop.

Skip any file that fails to parse, and count them. Report the count at the end rather than stopping.

---

## Step 2 — Work out the window

`$ARGUMENTS` may hold a number of days. Default to 90 if it is empty or not a number.

Compute the cutoff date. Never look further back than the oldest open item's `created_at`, since evidence older than the item cannot be evidence for it:

```bash
date -u -v-{days}d +"%Y-%m-%dT00:00:00Z" 2>/dev/null || date -u -d "{days} days ago" +"%Y-%m-%dT00:00:00Z"
```

**Both the time and the `Z` are load-bearing.** Drop either and the window silently starts somewhere other than where you meant, which reads as "nothing was built".

**The time.** Given a date with no time at all, `git log --since=` fills in the *current clock time* rather than midnight. So a bare date drops every commit made before the hour you happen to run this: at 09:00 most of the boundary day is there, at 17:00 it is gone.

**The `Z`.** Given a timestamp with no zone, git reads it as **local time**, and this cutoff is computed in UTC. Measured on a machine at UTC-4, at 19:53 local:

```
--since="2026-07-27 21:53:54"          ->  0 commits    UTC string, read as local, still in the future
--since="2026-07-27 17:53:54"          -> 13 commits    the same instant written in local time
--since="2026-07-27T21:53:54Z"         -> 13 commits    the same instant, said unambiguously
```

A UTC cutoff handed over bare starts the window four hours late here, and further east it starts it early. Either way the count is plausible and wrong. The `Z` form also matches the `created_at` written on every queue and to-build item, so the cutoff and the thing it is compared against are finally in the same units.

The two `date` implementations disagree too. BSD and macOS take `-v`, GNU and Linux take `-d`. Running the wrong one alone fails the same silent way.

All three faults land in the same place: a window that is not the window you asked for, and no error. That is why Step 7 reports an empty log as its own line.

Both faults land on the same result: an empty window that reads exactly like a clean "nothing was built". Whenever this step returns no commits at all across every root, say so as its own line in Step 7 rather than folding it into the verdicts, so an empty window is visible as an empty window:

> `Note: the git log returned nothing for any root in this window. If that looks wrong, the window may be the problem rather than the work.`

---

## Step 3 — Gather evidence

Collect from three places. Gather all three before judging anything, because the strongest evidence for a given item is often not in the first place you look.

### 3a — The git log of every configured root

Read the roots from `~/.claude/build-loop.config.json`. With no config file, use the three defaults from SCHEMA.md: `personal` at `~/.claude/skills` (kind `skill`), `hooks` at `~/.claude/hooks` (kind `hook`), and `commands` at `~/.claude/commands` (kind `command`). If the config has `skillRoots` and no `roots`, read those as roots of kind `skill`.

Check they exist before reading any git log:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check
```

- Exit 0, carry on.
- Exit 3, a root someone configured is gone. Relay what it said and use the
  roots that remain.
- Exit 5, only default locations are absent. Nobody configured those paths, so
  do not lead with it and do not stop. Carry on, and mention it only if the
  search then finds no evidence, where it is the explanation.
- Exit 4, relay it, add that you only have this session to go on, and carry on
  with session evidence alone.
- Exit 1, the config itself could not be read. Relay what it said and carry on
  with session evidence alone, saying that is all you have.

Every one of those messages arrives on stdout, including exit 1.

Whichever of these applies, do not report "no sign of it" for everything as
though you had looked, when there was nowhere to look.

That covers the case where a root is missing. Step 3d covers the other half,
where every root is healthy and the search runs correctly, and the item points
somewhere no root reaches. Both end in the same wrong sentence.

For each root that is a git repository:

```bash
git -C <root.path> log --since="{cutoff}" --pretty=format:"%h %ad %s" --date=short --name-status
```

`{cutoff}` arrives from Step 2 as `YYYY-MM-DDT00:00:00Z`. Pass it through untouched. Trimming the time, or dropping the `Z`, is the bug described there, and both fail as a plausible-looking count rather than an error.

If a root is not a git repository, skip it silently. That is normal, not an error.

Count the commits this returns, across all roots, and keep the total. Step 7 needs it to tell an empty window apart from a genuinely quiet one.

### 3b — What is on disk now

**Read the item's own text first.** If `what` or `why` names an explicit filesystem path, `stat` that path and use it as evidence, whatever the item's `kind` is. An item that names a path has already said where to look, so the conventions below are the fallback for items that do not. This is the only disk evidence available for kind `other`, and it also catches items whose title slug does not match the filename that actually got built.

**`source` is excluded from this sweep, deliberately.** It names material the build reads from, so it is a path that exists *before* the work starts and says nothing about whether the work happened. Stat'ing it and counting it as evidence would mark an item built the moment its spec was written. `where` is excluded for the mirror reason: it is a destination, and its existence is already covered by the kind conventions below rather than by the item's free text. Only `what` and `why` are read for paths here.

Treat text as naming a path when it carries a `~/`, `/` or `./` prefix, or a bare filename with an extension. Expand `~` before the `stat`. When the path is a JSON file, read it and quote something from inside, since "the file exists" and "the file holds what the item asked for" are different findings. When nothing exists at the named path, that is a real "no sign of it" for that item rather than a reason to fall back to guessing.

Then, for each open item, check whether something with its name exists in a plausible place. Use the item's `kind` to decide where to look, following the same conventions the bug queue uses:

- `skill`: `<root>/<slug>/SKILL.md` and `<root>/<slug>/skill/SKILL.md`, in roots of kind `skill`
- `hook`: `<root>/<slug>` and `<root>/<slug>.*`, in roots of kind `hook`
- `command`: `<root>/<slug>.md`, in roots of kind `command`
- `plugin`: `<root>/plugins/<slug>/` containing a `.claude-plugin` directory
- `script`: `<root>/<slug>` and `<root>/<slug>.*`, in roots of kind `hook` or `script`, plus the `plugin-repo` search below. A script inside a plugin lives in `scripts/` and is findable, so this is not a "no convention" case.
- `other`: no convention to guess from, so the explicit-path rule above is the only disk evidence there is. When the text names no path, say that disk evidence is not available and rely on 3a and 3c.

Also search every root of kind `plugin-repo`, whatever the item's `kind`, since that layout nests one level deeper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" layout --root <root.path> --slug <slug>

# The plugin row above resolves to the manifest, which is what a plugin row
# records everywhere else. This skill also needs the bare directory, because
# a directory with no manifest is the difference between started and built.
ls -1d <root.path>/plugins/<slug> 2>/dev/null
```

**The listings are generated rather than written here**, and `/audit-deps` reads
the same list for its own scan. They used to be a copy each, in prose, and `bin/`
was added to the repository on 2026-08-14 and to neither copy. The two that are
easy to leave out are still the last two: `statusline/` is another place a plugin
keeps executable code, and `tests/` sits at the root of the repository rather
than inside a plugin, so a glob anchored at `plugins/*/` never reaches it. A
to-build item satisfied by a test suite looks unbuilt without that line, and a
directory nobody remembered looks unbuilt for the same reason. Add a directory to
`PLUGIN_LAYOUT` in `roots.js` and both skills have it.

A plugin counts as built only when its directory holds a `.claude-plugin/plugin.json`. An empty directory with the right name is a `started`, not a `looks built`.

Derive `<slug>` from the item's `title` the same way the id was built, and also try the most distinctive word in the title. A title of "git-hygiene plugin" should find a directory called `git-hygiene`.

Record the modification time of anything found:

```bash
stat -f %m <path> 2>/dev/null || stat -c %Y <path>
```

A file that exists but predates the item's `created_at` is NOT evidence that the item was built. It usually means the name was taken already, which is worth mentioning to the user but is not a reason to close anything.

### 3c — This session

Look back over the current session. If something on the list was built in this conversation, that is the strongest evidence available and it will not be in the git log yet if nothing has been committed. Note it as session evidence and say plainly that it is uncommitted.

### 3d — Which items could be looked for at all

The three sweeps above search the configured roots. An item whose home is a
repository that is not a configured root is searched in the wrong places, finds
nothing, and comes out looking identical to an item that was searched properly
and genuinely is not built. Those two findings call for opposite responses, so
ask the question before judging rather than after. For each item, write the
`where` field verbatim with the Write tool to `{scratch}/where-{number}.txt`,
where `{number}` is its position in this run, then pass the file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" covers --where-file "{scratch}/where-{number}.txt"
```

The file hand-off is required because `where` is free text. Never interpolate
it into a shell command: a double quote, backtick, `$(...)` or newline would end
or extend the argument in a context where `Bash(node:*)` is allowed. An empty
field is an empty file and produces the ordinary `no-destination` answer.

One line comes back, and it always exits 0 because all six are ordinary
answers:

- `covered {rootname}` — a configured root holds that destination. Judge normally.
- `not-covered` — the destination names somewhere no configured root reaches.
- `no-destination` — the item never recorded where it was going. The configured
  roots were still searched, so judge it normally and carry this answer only
  for the informational count in Step 7.
- `unqualified` — the field contains prose but no path, owner/repository pair or
  configured root name that the tool can resolve. The configured roots were
  still searched, so judge it normally. Do not claim the prose names an
  unconfigured repository.
- `root-missing {rootname}` — the right root is configured and is not on disk.
- `default-missing {rootname}` — the destination names a built-in fallback
  location that is absent on a machine with no config file. It was not searched,
  but there is no configured path to repair.

The last two are different missing-root cases arriving per item. Keep all three
unsearchable answers apart in the report: `not-covered` wants a root adding to
the config, `root-missing` wants a configured path repairing, and
`default-missing` means no setting is broken at all. Telling somebody to repair
or add a root in the wrong case sends them to change the one thing that is not
wrong.

A destination is read four ways, in this order: as a path when it is anchored
at `~/`, `/` or `./`; as an owner-qualified repository, with a readable git
remote authoritative over a same-named checkout; as a configured root name; or
as unqualified prose. A folder-style pair such as `Projects/name` may match a
configured plugin repository, and a missing or non-git checkout may fall back
to its configured name because no remote contradicts it. All four are ordinary
things to find in this field, because `where` is free text. Dates, `and/or` and
single-word slash commands are prose, not destinations. A bare `/`, `~/`, `./`
or `../` is ignored: it names no particular destination and must not resolve to
the process working directory, home, or parent directory.

Pass an empty file for an item whose `where` is empty. An empty value is an
answer rather than a mistake.

Record the answer for every item alongside the other evidence. Run it for all of
them, including ones you already have evidence for, since it costs nothing and
the count in Step 7 has to be out of the whole list to mean anything.

**Whole segments, not substrings, and that is deliberate.** A root called
`skills` is not satisfied by `hq-skills` or by `_work-skills-rebuild-ref`. The
matching lives in `roots.js` rather than in this file for the same reason the
plugin layout does: a rule re-derived by reading prose on every run is a rule
that drifts, and this one decides whether a confident sentence is earned.

---

## Step 4 — Judge each open item

For each item, land on exactly one of four verdicts. When the evidence is mixed, take the lower verdict. A wrong "looks built" quietly deletes work from the list, and a wrong "no sign of it" costs one line of the user's attention.

| Verdict | When |
|---|---|
| **looks built** | Something matching the item exists on disk and was created or last changed after the item was added, OR a commit after the item was added clearly does the thing the item describes, OR it was built in this session. |
| **started** | Partial evidence. A directory exists but is empty or has no manifest, or a commit mentions it as work in progress. |
| **not searched** | Step 3d came back `not-covered`, `root-missing` or `default-missing`, and 3a, 3b and 3c all found nothing. Carry which of the three it was, since the report separates them. |
| **no sign of it** | Searched, and nothing found. |

**Evidence beats 3d, always.** An item can name a destination nobody has checked
out and still turn up in a configured root, because plans change and the `where`
field is not updated when they do. If any sweep found something, judge it on
what was found and never move it to "not searched". This verdict is for the case
where nothing was found *and* nothing could have been.

**"Not searched" is not a softer "no sign of it", it is a different claim.** One
says the work is still outstanding. The other says this tool cannot see that
repository and may be reporting finished work as outstanding. Collapsing them is
the failure this skill was written to avoid, and on 2026-08-14 it is the failure
it produced: all 12 open items reported as "no sign of it", seven of which had
never been looked for.

Write one line of evidence for every verdict that is not "no sign of it". Name the actual path or commit. "Looks done" is not evidence, `plugins/git-hygiene/plugin.json, added in a1b2c3d on 2026-08-01` is. For "not searched" the evidence line is the destination itself, quoted from the item, or "none recorded" where there is none.

---

## Step 5 — Show the findings and ask

If every item comes back "no sign of it", with none "not searched":

> "Checked {N} open items against the last {days} days. No sign that any of them have been built yet. Nothing to close."

When `{D}` of those items returned `no-destination`, append: "{D} record no
destination, but they were searched across every configured root." They are
ordinary searched items here, not a reason to switch to the unsearched branch.

Stop. Do not ask a question that has only one answer.

If every item is either "no sign of it" or "not searched", give both numbers and
name the repositories, then stop:

> "Checked {N} open items against the last {days} days. {U} of them could not be searched: {X} name a destination no configured root reaches ({repositories}), {G} name a configured root that has moved, and {A} name an absent built-in default nobody configured. The other {Q} were searched and show no sign of being built. {D} of those record no destination. Nothing to close."

**Both halves of that sentence, every time.** A run where nothing could be
searched and a run where nothing has been built produce the same silence, and
the first one is a broken tool reporting on itself. This is the exact output
that went out on 2026-08-14 as a flat "no sign that any of them have been built",
for a list that was more than half unsearchable.

Otherwise show this:

```
Checked {N} open items against the last {days} days.

Looks built:
  1. {title} - {evidence}
  2. {title} - {evidence}

Started, not finished:
  3. {title} - {evidence}

No sign of it yet:
  - {title}
  - {title}

Not searched, nothing could look for these:
  - {title} - destination: {the where field, or "none recorded"} ({the 3d answer})
  - {title} - destination: {...}

Close the built ones? (all / a list of numbers like "1,3" / none)
```

Omit any of the four groups that is empty. Do not print an empty heading.

**"Not searched" items are never numbered and never closeable.** Numbers exist so
the user can close something, and closing an item nobody looked for is how a
piece of outstanding work disappears off the list on no evidence at all. If they
ask for one by title anyway, say what it would be closing on and make them say it
again.

On their response:

- `all`: close every item under "Looks built". Items under "Started" are NOT included in `all`, because `all` should never mean more than what you offered.
- a list of numbers: close exactly those, whichever group they came from. If a number belongs to a "Started" item, that is a deliberate choice by the user and it is fine.
- `none`, `no`, or any negative: say "Nothing closed." and go to Step 7.
- Anything ambiguous: ask once more rather than guessing. Closing the wrong item silently loses the record of work that is still outstanding.

For any "Started" item the user did NOT close, offer once:

> "Want me to mark {title} as In Progress so it is obvious next time?"

Only change status on a yes.

---

## Step 6 — Write the closures

Each closure replaces an existing file, so it goes through `queue.js`, which
does the read and the write inside one process holding a lock. Per item:

1. Write the `built` block to a scratch file:

```json
{
  "ts": "{ISO-8601 now}",
  "evidence": "{the evidence line you showed the user, verbatim}",
  "commit": "{commit hash if the evidence came from a git log, else empty string}",
  "confirmed_by": "user"
}
```

2. Close the item:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --list to-build \
  --status Built --json built={scratch}/built-{id}.json
```

   `--json` sets a field from a JSON file, so `built` lands as an object rather
   than as the characters that spell one. Use `--field key=value` for plain
   strings. Nothing else changes: `created_at`, `title`, `what`, `why` and `notes` all stay as they are, which
   is not something you have to be careful about here: `queue.js` reads the item
   from disk and changes only what you named, so anything you did not mention
   cannot be dropped.

3. If a call exits non-zero, report the failure for that item and carry on with
   the remaining ones. One bad write must not abandon the rest. Nothing partial
   is left behind, and an exit usually means another session holds the lock, so
   the remedy is to run that one again.

Marking something `In Progress` from Step 5 uses the same sequence, setting only `status`.

---

## Step 7 — Report

```
Closed {K} items: {titles}.
{M} still open. {J} started but not finished. {U} not searched.
```

Drop the last sentence when `{U}` is zero, and never fold those items into
`{M}`. "Still open" is a claim about the work. "Not searched" is a claim about
this tool, and a reader adding the numbers up should not have to guess which
they are looking at.

Add these lines only when they apply:

- `Note: {X} of {N} items name a destination that is not a configured root, so they were not searched: {repositories}. Add it to ~/.claude/build-loop.config.json to include them.`
- `Note: {G} of {N} items name a root that is configured but not on disk, so they were not searched: {roots}. That is the same fault Step 3a reported; fix the path rather than adding one.`
- `Note: {A} of {N} items name a built-in default location that is absent, so they were not searched: {roots}. No configuration entry is broken; add a root only if you want that location included.`
- `Note: {D} of {N} items record no destination at all, so there was nowhere in particular to look. They were searched across every configured root, which may not be where they were going.`
- `{F} files failed to parse and were skipped: {filenames}`

- `Note: {title} was closed on session evidence and is not committed yet.`
- `Note: something called {slug} already existed before {title} was added. Worth a look, the name may be taken.`
- `Note: the git log returned nothing for any root in this window. If that looks wrong, the window may be the problem rather than the work.`

That last line matters more than it looks. Every way this step fails, a malformed cutoff or the wrong `date` flag or a root that is not a repository, ends at the same place: no commits, and a confident "no sign of it". Saying the log came back empty costs one line and is the only signal that separates "nothing was built" from "nothing was looked at".

**Every count in this step has its own letter, and they are not interchangeable.**
`{U}` is every item that was not searched, and `{X}`, `{G}` and `{A}` are the
three reasons, which add up to it. `{D}` is the separately counted group with no
destination: they were searched, remain in `{M}` when still open, and stay
numbered and closeable. `{F}` is files that could not be read and never joins
either total. This is spelled out
because `{P}` briefly stood for all four at once, and the templates here are
filled in by reading them, so a symbol standing for more than one quantity
prints one of them where another was meant, with nothing to catch it.

End with:

"Run `/to-build` to see the full list."

---

## Called from a wrap-up

This skill is meant to be run at the end of a session as well as on its own, and the flow is the same either way. When it is called as part of wrapping up, two things change:

- Session evidence from Step 3c matters more, because the work just happened and is probably uncommitted.
- Keep Step 5 to the findings and the one question. A wrap-up is not the moment for a long report, and the user can run `/to-build` if they want the whole list.

---

## Failure handling

- Never throw. If the git log fails in one root, note it and use the other roots.
- If `~/.claude/build-loop/to-build/` does not exist, treat it as an empty list, not an error.
- If an item has no `kind`, treat it as `skill` for the disk check in Step 3b.
- If an item has no `created_at`, skip the "newer than the item" test for it and say so in the evidence line, because without that date you cannot tell new work from old.
- Never close an item on the strength of its title appearing in a commit message alone. A commit that says "still need to do git-hygiene" mentions the title and is evidence of the opposite.
