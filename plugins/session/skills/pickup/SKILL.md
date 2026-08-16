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
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js find "<slug>" --json
```

That returns the match and, when there is none, every path it tried plus a
`stale` object. Show the tried list if nothing matched; the search order is
exactly what someone needs to see at that moment.

**When `stale` is present, lead with it.** It holds the path the index recorded,
which is the only location nothing else can guess, and reporting the guesses alone
is how a moved project reads as a handoff that never existed. `stale.state` says
which it is, and there are three answers, not two:

- `gone` means the directory is still there and the document is not, so it was
  deleted or renamed.
- `unreachable` means the directory went too, so the project moved or its volume
  is not mounted, and you cannot tell which from here. Never describe an
  `unreachable` handoff as lost.
- `pending` means the note was written in the last few minutes and the document
  has not appeared yet. A wrap records where it will write before it writes, so
  this is what one looks like while it is still running. Say that, and say to let
  it finish and try again. **Never describe a `pending` handoff as deleted**: it
  is the one state where the handoff is most likely about to exist.

Read the state rather than assuming a missing document means a deleted one. This
list is the whole contract, so a state that is not on it is a state this skill has
not been taught, and the answer is to say the state is unrecognised rather than to
pick the nearest wording.

If the match is an archived handoff, open the summary with:

> This handoff was archived as finished or stale. Loading it anyway.

---

## Step 2: Read it

Read the matched file. Handoffs written by `/wrap` have known headings. Anything
else, take the structure as it comes and do not force it into the template.

### Then ask what still binds

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints --cwd "<the project directory>"
```

**Pass `--cwd` explicitly. Do not rely on where the session started.** Scope is
worked out from the working directory, and Step 4 is what moves to the project,
two steps after this. Run without the flag and it answers for wherever the
session opened, usually the home directory, which resolves to a different
project and reports no constraints. A confident "none" is the worst answer this
command can give, because it is indistinguishable from a project that genuinely
has none.

The project directory is the `**Working directory:**` line inside the handoff
you just read. Use that, not `dirname` of the handoff's own path: a central
handoff lives in the handoffs folder, which is nobody's project.

**Run it even when the handoff has a `## Constraints still in force` section.**
That section holds what the last session carried. This asks the project, across
every handoff written for it, including ones for other threads of work. A
constraint set on one thread governs the next one, and the thread that set it is
not the thread that breaks it.

If the two disagree, show both and say which came from where. Do not silently
prefer either: a constraint in the project but not in this handoff is the exact
shape of something that was dropped, and it is worth the user seeing that.

---

## Step 3: Surface it

```
Resuming from: {path}

**Still binding:**
{every constraint, verbatim, with the document each one names}

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

**"Still binding" is the exception, and it goes first.** It is dropped only when
the handoff and the project both genuinely have none, never shortened, never
summarized, and never moved below the next actions. A constraint paraphrased
into a gist stops being checkable, and one printed under the fold is one that
gets skimmed past on the way to the task. This section exists because an
approved design system sat in a document nobody opened for three days while a
page was built against nothing and then thrown away.

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

**A document named by a constraint is not on that list.** It is not context that
might be useful, it is the thing the work has to comply with, and treating it as
optional reading is how it gets skipped. Do not bulk-load it here either. Say
which it is and that it has to be read before work starts in the area it
governs:

> The design system at {path} governs anything under `site/`. I will read it
> before touching that, not now.

The distinction is worth holding on to. Everything else in a handoff describes
what happened, and can be caught up on lazily or never. A constraint describes
what is allowed, and being unaware of it does not make it stop applying.

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
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js recent
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
