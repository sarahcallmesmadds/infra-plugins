---
name: to-build
type: human
description: The to-build list, at ~/.claude/build-loop/to-build/. With an argument it writes down something the user plans to build (a skill, hook, command, plugin, or loose script), showing a draft and waiting for confirmation before writing. With no argument it shows the list. Use when the user says "I want to build", "we should build", "add that to the to-build list", "put that on the list", "remind me to build", "what's on the to-build list", "what was I going to build", "what's left to build", or explicitly invokes /to-build. Pre-fills what and why from the current session. Never writes without confirmation.
argument-hint: "[what you want to build, or nothing to see the list]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*), Bash(mktemp:*), Bash(node:*)
---

You are working with the to-build list at `~/.claude/build-loop/to-build/`. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA-BUILD.md`. Read it if you have not already in this session.

This is the list of things the user plans to build. It is not the bug queue. The bug queue at `~/.claude/build-loop/queue/` records things that already exist and did something wrong, and it is reached with `/flag-issue` and `/list-bugs`. If what the user is describing is a thing that exists and misbehaved, say so and point them at `/flag-issue` rather than writing a to-build item.

> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

> **Every write to the to-build list goes through `scripts/queue.js`.** Adding
> an item uses `create`, changing one uses `update`. Both do the read, the check
> and the write inside one process holding a lock.
>
> This paragraph used to say creating was safe to do with the Write tool,
> because the filename is a fresh timestamped stem and there is no existing file
> to lose. That is true about half-written files and misses the other half: the
> duplicate check and the write are separate tool calls with a confirmation turn
> between them, so two sessions adding the same idea both look, both see
> nothing, and both write. The stem is timestamped to the second, so they can
> also land on the same filename.

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

## Step 0 — Decide which mode you are in

- **`$ARGUMENTS` is empty AND the user's message is asking what is on the list** ("what's on the to-build list", "what was I going to build"): go to **Mode L, show the list**.
- **`$ARGUMENTS` is empty and there is no clear question**: go to **Mode L**. Showing the list is the safe default, because it writes nothing.
- **`$ARGUMENTS` is non-empty, or the user's message describes something they want built**: go to **Mode A, add an item**.

---

# Mode A — add an item

## Step A1 — Work out the four things an item needs

Look at `$ARGUMENTS` and the last three to five exchanges in this session.

**1. title** — a short name for the thing, under about 60 characters. Take it from the user's own words where you can. "a plugin for git hygiene" becomes `git-hygiene plugin`.

**2. kind** — one of `skill`, `hook`, `command`, `plugin`, `script`, `other`. Infer it:

- The user said the word plugin, or described several commands shipped together: `plugin`
- They described something that fires automatically, blocks an action, or runs on an event: `hook`
- They described something they would invoke by name to do a task: `skill`
- They said slash command, or described a single prompt they want saved: `command`
- A standalone file they would run in a terminal: `script`
- Genuinely unclear after all of that: `other`

Do NOT ask about kind as its own question. It is a guess you show in the draft and they can correct there.

**3. what** — one or two sentences on what it should do, in plain language. If the user gave enough, use their words. If all you have is a bare name with no behaviour attached, ask ONE question:

> "What should it do? One line is fine."

**4. why** — the problem it solves. If they said it, capture it. If they did not, do NOT ask a second question. Leave it as an empty string and mention it in the draft, because a missing `why` is worth seeing but not worth blocking on.

Also try to fill, without asking:

- **where** — a marketplace, repository, or root name if one was named. Empty string otherwise.
- **source** — one filesystem path, if the user named material the build will read from: a spec, an existing implementation, a document. Empty string otherwise, which is the common case.
- **blocked_by** — free text if the user said something has to happen first. Empty string otherwise.

**`where` and `source` are not the same thing and must not be conflated.** `where` is the destination and routinely does not exist yet. `source` is material that has to exist for the item to be buildable, and it is the only one that gets path-checked. If the user names a single place that is both, record it as `where` and leave `source` empty; a destination that is missing is normal and warning about it would be noise.

Do not put a path in `source` that you inferred rather than heard. An empty `source` means "nothing extra to read", which is true of most items and is a better default than a guess that later reports itself broken.

Rule: ask at most ONE question in this whole step. If their last message already answered it, do not re-ask.

---

## Step A2 — Dedup check, before showing anything

Compute `dedup_key = "to-build::{slug(title)}"`. Slugify means lowercase, every non-alphanumeric character becomes `-`, trim leading and trailing dashes, truncate to 60 characters.

Run `ls ~/.claude/build-loop/to-build/*.json 2>/dev/null`. Read each file. Then check for a duplicate **twice**, because one of these catches what the other misses:

1. **Exact key match.** Any existing entry whose `dedup_key` equals the new one.

2. **Same thing, different words.** Read the `title` and `what` of every existing item and judge whether any of them describes the same piece of work as the one being added. This matters more than the key does. "git-hygiene plugin" and "git-hygiene plugin for stale branches" produce different keys and are obviously the same item, and the same idea described six weeks apart almost never produces the same words. Treat it as a duplicate when the two would be satisfied by building one thing.

   When only this second check fires, say which one it is and why you think they are the same, rather than asserting it:

   > "This looks like the same thing as {title}, from {date}, which says: {what}. Same item, or genuinely different?"

This check is NOT time-windowed. That is the point: writing the same idea down twice, months apart, is the normal failure of a wish list.

**If a match is found in status `Open` or `In Progress`:**

> "You already have this one, from {date}: {title}. It says: {what}. Add a note to it instead, or write a separate item anyway?"

If they want a note, write the text they gave you to a file in the scratch
directory and hand that over:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --list to-build --note-file {scratch}/note-{id}.txt
```

If it exits non-zero, say the note was not added and read out what it printed.
A refusal usually means another session holds the lock, so running it again is
the remedy. Do not tell the user the note was added.

`--note-file` rather than `--note` because this is text the user just typed. A
double quote, a backtick, a `$(...)` or a newline in it would end or extend the
shell argument, and this runs where `Bash(node:*)` is allowed. The file is named
after the item so two sessions writing notes at once cannot swap them.

That reads the item, appends to the `notes` already on it, and writes it back
under a lock, so a note added by another session in the meantime survives. This
used to say the note could not be appended from here at all, because the skill
could not safely do a replacing write by hand and was honest about it. It can
now, so it does.

**If a match is found in status `Dropped`:**

> "Careful, you already decided against this one on {date}. The reason recorded was: {what}. Do you want to reopen it, or has something changed that makes it worth doing now?"

Wait for an answer. Do not write until they say to.

**If a match is found in status `Built`:**

> "You already built this, on {date from the built object}. Is this a second version, or a different thing that needs a clearer name?"

**If no match:** continue to Step A3 silently.

---

## Step A3 — Show the draft and wait

Display exactly this shape:

```
I'll add this to the to-build list:

Title: {title}
Kind: {kind}
What: {what}
Why: {why, or "(not given)"}
Where: {where, or "(not decided)"}
Source: {source, or "(nothing to read)"}
Blocked by: {blocked_by, or "nothing"}

Write it? (y / edit / skip)
```

If `source` is non-empty, check it resolves before showing the draft, using the same command Step L4 uses:

```bash
node -e 'const fs=require("fs"),os=require("os"),h=os.homedir();for(const p of process.argv.slice(1)){const f=p.startsWith("~")?h+p.slice(1):p;console.log((fs.existsSync(f)?"OK  ":"GONE")+" "+p)}' {source, shell-quoted}
```

If it comes back `GONE`, show the draft with the path marked and let them decide:

> "Source not found: {source}. Writing it anyway is fine, and the list will keep showing this warning until the path resolves or the field is cleared."

Do not refuse the write and do not clear the field for them. A path that is right but not fetched yet is a normal state, and silently emptying a field the user typed is worse than carrying a visible warning.

On their response:

- `y`, `yes`, `sure`, `go`, or any clear affirmative: go to Step A4.
- `edit`, or any change request: apply the change, show the draft again, ask again.
- `skip`, `no`, or any negative: say "Skipped, nothing written." and stop.

**No silent writes. Ever.**

---

## Step A4 — Write the file

Compose the item. Every field per SCHEMA-BUILD.md v1:

```
$schema_version: 1
id:              {YYYY-MM-DDTHH-MM-SS}-{slug(title)}   <- must equal the filename stem
created_at:      current UTC time, ISO-8601
status:          "Open"
title:           {title}
kind:            {kind}
what:            {what}
why:             {why, or ""}
where:           {where, or ""}
source:          {source, or ""}
blocked_by:      {blocked_by, or ""}
session_id:      current session ID, or ""
session_cwd:     current working directory, or ""
dedup_key:       {dedup_key}
notes:           []
built:           null
```

Then:

1. Get the time: `date -u +"%Y-%m-%dT%H-%M-%S"` for the filename, `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` for `created_at`.
2. Build the `id` as `{YYYY-MM-DDTHH-MM-SS}-{slug(title)}`. It becomes the filename stem.
3. `mkdir -p ~/.claude/build-loop/to-build`
4. Write the item to a scratch file with the Write tool, pretty-printed, two-space
   indent, then hand it over:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" create {scratch}/{id}.json --list to-build --dedup-window all
   ```

   **If the user was warned about a duplicate in Step A2 and said to add it
   anyway, pass `--dedup-window 0` instead**, which skips the check. Without
   that, `--dedup-window all` refuses the very item they just approved and the
   skill reports a refusal for something nobody wanted refused. An item whose
   title slugs to an existing key could otherwise never be added at all.

   Do not write it into the to-build directory yourself. The exact-key half of
   the duplicate check in Step A2 happens again inside the lock, which is what
   makes it a guarantee rather than a look: that check and this write are
   separated by a confirmation turn, and another session can add the same item
   in between. Filenames are timestamped to the second, so two sessions adding
   the same title in the same second would otherwise overwrite one another
   outright.

   **Stop here unless it exited 0.** Exit 2 means an item with that `dedup_key`
   already exists, so say so and name what it printed rather than retrying. Exit
   1 is a real error, including the lock being held by another session, and its
   message is written to be read aloud.

   In either case do not go on to Step 5 and do not print the confirmation
   below. It says the item was added, and saying that about an item that was
   refused is worse than the refusal.

   The judgment half of Step A2, whether two differently worded items describe
   the same work, stays where it is. Nothing in a script can do it.
5. Count what is open, after the write above has landed:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" count --list to-build
   ```

   This used to be "read every file and count those with status `Open` or `In
   Progress`", which is the right question asked by hand. The command asks it
   in the one place both lists ask it, and it knows that `Built` and `Dropped`
   are what finished looks like here while `Resolved` and `Won't Fix` are what
   it looks like in the queue. Two hand-written definitions of open is how the
   two lists come to disagree about the word.

Confirm, quoting the line it printed as it came:

> "Added to the to-build list. {count}. Run `/to-build` to see them, or `/built-check` to close the ones you have already built."

---

# Mode L — show the list

## Step L1 — Read every item

```bash
ls ~/.claude/build-loop/to-build/*.json 2>/dev/null
```

If nothing comes back, print this and stop. Do NOT error:

> "The to-build list is empty. Run `/to-build <something you want to build>` to add the first item."

Read each file with the Read tool. Parse each as JSON.

If a file fails to parse, or fails to read, do NOT hide it. Show it as a row with title `(malformed)`, status `(error)`, and the filename in the What column, so it can be found and fixed.

## Step L2 — Filter

`$ARGUMENTS` may hold a filter. Match case-insensitively:

- empty: show `Open` and `In Progress`. This is the default, because the everyday question is what is left.
- `all`: every status.
- `open`: only `Open`.
- `built`: only `Built`.
- `dropped`: only `Dropped`.

Set `filter_label` to "Open + In Progress", "All", "Open only", "Built only", or "Dropped only" to match.

## Step L3 — Sort

1. By status: `Open`, then `In Progress`, then `Built`, then `Dropped`, then `(error)` last.
2. Within a status group, `created_at` ascending, so the oldest is first. Something written down months ago and still not built is the interesting row.

Items with a missing or unparseable `created_at` sort last within their group.

## Step L4 — Check recorded sources

Check the sources of items that survived the filter **and** hold status `Open` or `In Progress`. Skip `Built` and `Dropped` items even when the filter asked for them: their source material is expected to be gone or archived, and there is no future build for the warning to protect. Nothing about a settled item is made actionable by telling someone its spec moved.

Collect the paths into one command rather than one call per item, so a list of thirty does not cost thirty tool calls:

```bash
node -e 'const fs=require("fs"),os=require("os"),h=os.homedir();for(const p of process.argv.slice(1)){const f=p.startsWith("~")?h+p.slice(1):p;console.log((fs.existsSync(f)?"OK  ":"GONE")+" "+p)}' {each source path, shell-quoted}
```

This runs through `node` rather than `stat` or a shell `for` loop because `Bash(node:*)` is in this skill's `allowed-tools` and neither of those is. A step that names a command the skill cannot run reads perfectly and fails at the moment of use, which is the one failure mode this whole change exists to prevent. It also expands `~` in code rather than in the shell, where `[ -e "~/x" ]` is false for every path, and it echoes each path back exactly as recorded so the warning quotes the field rather than a rewritten form of it.

Read the result back and mark each item `source_ok` or `source_gone`. An item with an empty `source` is neither, and never appears in the warning block below.

Two rules about what this check may conclude:

- **Only `source` is checked.** Not `where`, not a path mentioned in `what` or `why`. `where` is a destination and is expected to be missing before the thing is built, so checking it would report the normal case as a fault.
- **A missing source does not change the item's status.** It is still `Open`, it is still shown in its usual place in the table, and it is still buildable, because most items carry enough in `what` to be built without the source. The warning says a recorded pointer went stale, not that the work is blocked. Use `blocked_by` when the work genuinely cannot start.

If the check itself fails to run, say so once and render the table without the warning block. An unreadable check is not evidence that a path is gone.

## Step L5 — Render

Count `N` after filtering. If `N` is zero, print "No {filter_label} items on the to-build list." and go to Step L6.

Otherwise:

```
## To build: {filter_label} ({N} items)

| Title | Kind | What | Status | Added |
|-------|------|------|--------|-------|
```

One row per item, up to 20:

- **Title**: the `title` field.
- **Kind**: the `kind` field, or `skill` if absent.
- **What**: `what` truncated to 60 characters with `...` appended if cut. Escape any literal `|` as `\|` so the table does not break.
- **Status**: the `status` field. If `blocked_by` is a non-empty string, append ` (blocked)`.
- **Added**: first 10 characters of `created_at`. Show `?` if missing.

If `N` is over 20, print:

`... and {N - 20} more. Run /to-build all to see every item, or open ~/.claude/build-loop/to-build/ directly.`

Then, if any shown item has a non-empty `blocked_by`, list those beneath the table so the reason is visible rather than just the flag:

```
**Blocked:**
- {title}: {blocked_by}
```

Then, if any item is marked `source_gone`, list those beneath the table too, whether or not it made the 20 rendered rows. Only `Open` and `In Progress` items carry that mark, per Step L4, so a `built` or `all` listing shows the block for its unfinished items and stays silent about the settled ones. One line per item, and nothing at all when every source resolves:

```
**Sources not found:**
- {title}: {source}
```

Follow that block with this line, once, whatever the count:

"A missing source does not block the item. Build it from its own description, or point it at something that exists."

Do not print the block, the heading, or a reassurance that everything resolved when no item is marked `source_gone`. Silence is the correct output for a healthy list, and a line saying all sources are fine on every single invocation trains the reader to skip the place the real warning appears.

The `Sources not found` list is not truncated at 20 the way the table is. It is short by nature, and an item cut from the bottom of the table can still have a dead source worth seeing.

## Step L6 — Footer

Always end with this line:

"Run `/to-build <thing>` to add an item. Run `/built-check` to close the ones you have already built. For something that exists and misbehaved, use `/flag-issue` instead."

---

## Failure handling

- If the Write tool fails, say exactly what failed. Do NOT retry silently.
- If the user will not answer the one question in Step A1, write `what` as `"(not provided)"` and still write the item. A vague item is better than a lost one. Flag it: "Added with no description. Edit it later at `{path}`."
- Never throw in Mode L. If every file fails to read, print the empty-list message rather than an error.
- If `title` is missing from an item, render it as `(untitled)` rather than crashing, and include the filename in the What column so it can be found.
