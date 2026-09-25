---
name: pickup
description: Load a previous session's handoff and start where it left off. Takes a slug produced by /wrap, finds the matching handoff, and surfaces what was happening, what was decided and what is next. Use when the user says "/pickup <slug>", "pickup <slug>", "resume <slug>", "let's pick up <slug>", or "where was I on <slug>".
allowed-tools: Read, Write, Bash(node:*)
---

# Pickup

Load the context from a previous session so work can restart in minute one
rather than minute ten. Your past self briefing your future self.

The argument is the **slug**. `/wrap` prints it as the last line of every wrap,
so most pickups are a paste. In Codex there is no slash command: the same slug
is passed to this skill by asking for it, for example "pick up site-thread".

---

## Step 0: Check the scripts match this skill

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js capabilities --json
```

It has to print a JSON object whose `threads` is 1 or higher. Anything else,
including a list of commands or an error, means the scripts installed in this
host are older than this skill.
Stop and say so: "The installed session scripts are older than this skill;
update the session plugin in this host and start a new session." Do not carry
on with the older scripts. They accept the commands below and answer a
different question, so the result would look right and be wrong.

---

## Step 1: Find the handoff

**If the argument is a path to a file rather than a name**, which is how `/wrap`
ends for a project whose name belongs to a declared thread, skip `find`: the
name would open the thread. Open the path with the Read tool. If the read fails,
say nothing is there and stop. Otherwise it is a project handoff; carry on at
Step 2, and in its constraints step use the path's own **Working directory:**
line:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints --cwd "<its Working directory>" --json
```

That is the older pooled answer for the project's own scope, which is what binds
a project. If it answers with `refused`, say what it says and stop. If the file
has no Working directory line, say so and stop rather than answering for the
directory this session happens to be in.

Otherwise the argument is a slug:

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

### Thread or history

The same JSON says which kind of handoff this is.

- **`thread` is set.** This is a declared thread: one handoff per subject,
  rewritten in place at every wrap. If `thread.exists` is false its file is
  missing, and if `thread.unreadable` is true it cannot be read: say which and
  stop. Otherwise keep `thread.slug`, `thread.path`,
  `thread.rev` and `thread.generation`; Step 3 prints them. If
  `thread.conflicts` is not empty, two documents answer to this slug: show
  both paths and ask which is meant before going on.
- **`match.history` is true.** Threads are set up here, and this document is an
  older home handoff that is not one of them. It is kept as history and binds
  nothing. Say so, then run `cli.js threads` and offer the thread that covers
  this subject. If the user takes it, start this pickup again with that slug.
- **`listUncertain` is true.** The thread list cannot be read, and this
  handoff could be a thread, so which rules bind it cannot be told. Say so and
  stop; the list needs fixing first. That includes a repository's own
  `HANDOFF.md` whose name is also a central handoff's, because the name may
  belong to a thread. A repository handoff with a name of its own is never
  affected and carries on as below.
- **Neither.** Threads are not set up here yet (`mode: "pre-migration"`), or this
  is a project handoff kept beside its work. Carry on as below.

---

## Step 2: Read it

Read the matched file. Handoffs written by `/wrap` have known headings. Anything
else, take the structure as it comes and do not force it into the template.

### Then ask what still binds

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints --thread "<slug>" --json
```

Always the slug you were given, never the directory this session started in.
What comes back depends on how the handoff is kept, and the command decides,
not this skill:

- **A declared thread** (`binding: true` and `kind: "thread"`): the rules
  written in that thread's own file, and nothing else. That is the whole answer. Rules that apply to
  every thread live in the user's standing instructions and memory, not in
  other handoffs, so there is no second list to go and find.
- **Threads not set up yet, or a handoff outside the home directory** (a
  repository's `HANDOFF.md`, or one written from anywhere but home): the older
  pooled answer, every rule recorded by any handoff written from the same
  working directory as this one, exactly as before. A constraint set on one
  piece of work still governs the next there, and the list can be long; print
  it anyway. Show any `truncated`, `unreadable`, `unmatchedRetirements`,
  `nearDuplicates` or `gitDegraded` in the answer above the list, the way the command's plain
  output does: each means the list may be incomplete or doubled.
- **An `error`** (the handoff has no `**Working directory:**` line, or was not
  found): say that what binds could not be worked out, and why. Never answer
  for the directory this session happens to be in instead.
- **History** (`binding: false`): nothing binds. Say the document is history.

Two refusals stop the pickup rather than print a list:

- `refused: "migration-unfinished"`: a migration is part way through. Show the
  rules in `pending` that are still to be written into this thread, say that no
  thread's rules are given until it finishes, and name `cli.js migrate finish`.
- `refused: "registry-invalid"`, `"declared-missing"`, `"declared-unreadable"`,
  `"declared-no-directory"` or `"declared-out-of-scope"`: the thread list cannot
  be read, or names a file that is not there, cannot be read, has no
  `**Working directory:**` line, or was written outside the home directory. Say
  which and stop.

If the handoff's own `## Constraints still in force` section and the command
disagree, show both and say which came from where. For a declared thread they
should be identical apart from `Retired this session:` lines, which the command
leaves out, because they are the same file; any other difference means the file
changed since it was read.

## Step 3: Surface it

```
Thread: {slug} · {path} · rev {first 12 of rev} · generation {generation}
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

Print the `Thread:` line only for a declared thread, and keep it word for word
in any summary this conversation is later compressed into. Wrap reads it to know
which thread to save, and to notice whether another session saved it since this
pickup. A lost line means wrap has to work the thread out again.

When more than one opening note applies, the order is: the `Thread:` line, then
`Resuming from:`, then the archived note, then the age note.

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

**No slug given.** If threads are set up (`cli.js threads` lists them), show
that list first, since those are what a pickup should resume; offer the menu
below only for older history. Otherwise show a menu rather than guessing:

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
