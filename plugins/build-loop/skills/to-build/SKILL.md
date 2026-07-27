---
name: to-build
type: human
description: The to-build list, at ~/.claude/build-loop/to-build/. With an argument it writes down something the user plans to build (a skill, hook, command, plugin, or loose script), showing a draft and waiting for confirmation before writing. With no argument it shows the list. Use when the user says "I want to build", "we should build", "add that to the to-build list", "put that on the list", "remind me to build", "what's on the to-build list", "what was I going to build", "what's left to build", or explicitly invokes /to-build. Pre-fills what and why from the current session. Never writes without confirmation.
argument-hint: "[what you want to build, or nothing to see the list]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*)
---

You are working with the to-build list at `~/.claude/build-loop/to-build/`. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA-BUILD.md`. Read it if you have not already in this session.

This is the list of things the user plans to build. It is not the bug queue. The bug queue at `~/.claude/build-loop/queue/` records things that already exist and did something wrong, and it is reached with `/flag-issue` and `/list-bugs`. If what the user is describing is a thing that exists and misbehaved, say so and point them at `/flag-issue` rather than writing a to-build item.

> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

> **This skill writes new items directly, on purpose.** Every write that REPLACES
> an existing file in this plugin goes through the `.tmp` plus parse-check plus
> `mv` sequence. This skill only ever creates brand-new items under a fresh
> timestamped filename, so there is no good file to lose, and `allowed-tools`
> above grants no `node` or `mv` accordingly. If this skill is ever changed to
> update an existing item, that stops being true and the atomic sequence becomes
> mandatory.

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
- **blocked_by** — free text if the user said something has to happen first. Empty string otherwise.

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

If they want a note, append `{ts, text}` to that item's `notes` array. That is a REPLACING write, so use the atomic sequence: write `{id}.json.tmp`, parse-check it with node, then `mv` it into place. Since this skill's `allowed-tools` grants neither `node` nor `mv`, say plainly that you cannot append the note from here and offer to write a fresh item instead.

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
Blocked by: {blocked_by, or "nothing"}

Write it? (y / edit / skip)
```

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
blocked_by:      {blocked_by, or ""}
session_id:      current session ID, or ""
session_cwd:     current working directory, or ""
dedup_key:       {dedup_key}
notes:           []
built:           null
```

Then:

1. Get the time: `date -u +"%Y-%m-%dT%H-%M-%S"` for the filename, `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` for `created_at`.
2. Build the filename `{YYYY-MM-DDTHH-MM-SS}-{slug(title)}.json`. The `id` MUST equal the stem.
3. `mkdir -p ~/.claude/build-loop/to-build`
4. Write the JSON with the Write tool, pretty-printed, two-space indent.
5. Count what is open: read every file in the directory and count those with status `Open` or `In Progress`.

Confirm:

> "Added to the to-build list. {N} open items. Run `/to-build` to see them, or `/built-check` to close the ones you have already built."

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

## Step L4 — Render

Count `N` after filtering. If `N` is zero, print "No {filter_label} items on the to-build list." and go to Step L5.

Otherwise:

```
## To build — {filter_label} ({N} items)

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

## Step L5 — Footer

Always end with this line:

"Run `/to-build <thing>` to add an item. Run `/built-check` to close the ones you have already built. For something that exists and misbehaved, use `/flag-issue` instead."

---

## Failure handling

- If the Write tool fails, say exactly what failed. Do NOT retry silently.
- If the user will not answer the one question in Step A1, write `what` as `"(not provided)"` and still write the item. A vague item is better than a lost one. Flag it: "Added with no description. Edit it later at `{path}`."
- Never throw in Mode L. If every file fails to read, print the empty-list message rather than an error.
- If `title` is missing from an item, render it as `(untitled)` rather than crashing, and include the filename in the What column so it can be found.
