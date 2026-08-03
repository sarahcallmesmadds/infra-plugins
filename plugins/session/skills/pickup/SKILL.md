---
name: pickup
description: Load a previous session's handoff and start where it left off. Takes a slug produced by /wrap, finds the matching handoff, and surfaces what was happening, what was decided and what is next. Use when the user says "/pickup <slug>", "pickup <slug>", "resume <slug>", "let's pick up <slug>", or "where was I on <slug>".
---

# Pickup

Load the context from a previous session so work can restart in minute one
rather than minute ten. Your past self briefing your future self.

The argument is the **slug**. `/wrap` prints it as the last line of every wrap,
so most pickups are a paste.

---

## Step 1: Find the handoff

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js find "<slug>" --json
```

That returns the match and, when there is none, every path it tried plus a
`stale` object. Show the tried list if nothing matched; the search order is
exactly what someone needs to see at that moment.

**When `stale` is present, lead with it.** It holds the path the index recorded,
which is the only location nothing else can guess, and reporting the guesses alone
is how a moved project reads as a handoff that never existed. `stale.state` says
which it is: `gone` means the directory is still there and the document is not, so
it was deleted or renamed; `unreachable` means the directory went too, so the
project moved or its volume is not mounted, and you cannot tell which from here.
Never describe an `unreachable` handoff as lost.

If the match is an archived handoff, open the summary with:

> This handoff was archived as finished or stale. Loading it anyway.

---

## Step 2: Read it

Read the matched file. Handoffs written by `/wrap` have known headings. Anything
else, take the structure as it comes and do not force it into the template.

---

## Step 3: Surface it

```
Resuming from: {path}

**Last session ({date}):**
{two or three sentences, paraphrased, not copied}

**Where we left off:**
{open loops, most important first, at most five}

**Next actions per the handoff:**
{the numbered list, verbatim}

**Files of interest:**
{paths only, at most eight}
```

Omit any section the handoff does not have. Do not fill a gap with a guess: a
fabricated "where we left off" is worse than an absent one, because it reads
exactly like a real one.

If the handoff is more than seven days old, open with:

> This handoff is {N} days old, so parts of it may no longer be true.

---

## Step 4: Move to the right directory

If the handoff sits in a project directory and that is not where you are, say
so and change to it. If you are already there, say nothing.

---

## Step 5: Do not load the referenced files

This is the step the skill exists for. Read nothing beyond the handoff itself.

Bulk-loading every file a handoff mentions is the single largest avoidable
context cost at the start of a session, and most of those files are not touched
before the conversation moves somewhere else. The summary is enough to decide
with.

End with one line:

> This references {N} files. Name the ones you want and I will open them.

Open a file only once it is named. Never open the list.

---

## Step 6: Hand back

Surface the top next action and ask:

> Ready to continue. Start with: **{first next action}**?

Follow whatever answer comes back, including a redirect to something else
entirely.

---

## Edge cases

**No slug given.** Show a menu rather than guessing:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js recent
```

List them newest first with their age, and ask which.

**The slug matches more than one.** Show every match with its path and date and
ask which. Never pick for them.

**No match.** If `stale` is set, say what it recorded and what state that path is
in first, per Step 1. Then show the paths that were tried, then the three most
recent handoffs as alternatives, and offer to take a direct path instead. A
recorded path that no longer resolves is a different situation from nothing having
been written, and the remedies differ: one wants `projectRoots` extended or the
entry forgotten, the other wants a new wrap.
