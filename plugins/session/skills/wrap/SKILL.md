---
name: wrap
description: End-of-session wrap. Writes down what was decided, what was built and what is next, into a handoff document the next session can load. Use at the end of a working session, or when the user says "wrap", "let's wrap", "wrap up", "wrap this session", "close out", or invokes /wrap. Pairs with /pickup, which reads what this writes.
---

# Wrap

Close the loop before closing the laptop. Your job is to make sure nothing from
this session is lost, and that the next one starts with context instead of
starting from scratch.

The output is one handoff document. Write it for a reader who was not here.

---

## Step 0: Sweep old handoffs out of the way

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js archive
```

This moves handoffs untouched for 30 days into an `archived/` folder. It moves,
never deletes, and `/pickup` still finds archived documents by name.

If it reports moving anything, mention it in the Step 4 summary under "Filed
away". If it reports nothing, say nothing about it.

---

## Step 1: Review the session

Read back over the whole conversation and pull out:

1. **What was worked on.** The actual subject, not the list of tools used.
2. **Decisions made.** Anything settled that constrains future work: a name, a
   format, an approach chosen over another. Record why, because the why is what
   stops the decision being reopened next week.
3. **Files created or changed**, with paths and one line each on what they do.
4. **Open loops.** Raised and not resolved, deferred on purpose, or asked and
   never answered.
5. **Next actions.** Concrete enough to start on without rereading anything.

Then collect what is still binding from before this session:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints
```

**A decision made in an earlier session does not stop applying because this
session was about something else.** Scope is the repository, so a worktree
inherits from its main checkout.

- **It lists constraints.** Carry every one into the new handoff, verbatim.
  **The bullet holds the constraint and nothing else.** No "(from HANDOFF-x)",
  no date, no note about why it is being carried. Matching is on the text, so
  an added annotation makes the copy a different constraint from the original:
  both then show as live, the list grows a near duplicate at every wrap, and a
  later retirement quoting one of them silently leaves the other in force. The
  command already reports where each came from on its own line.
- **It lists none, and names the handoffs it found for this project.** Those
  documents predate the section. Read them, pull out anything binding, and
  propose it to the user before writing:

  > These look like they still apply. Carrying them into the handoff unless you
  > say otherwise:
  > - the constraint, and which handoff it came from

  A constraint is anything that governs work not finished yet: an approved
  design or standard, a path that must be read first, a deploy restriction,
  something declared off limits. Not a completed decision, which belongs under
  "Decisions made".
- **It warns that the scan was truncated, or that a retirement matched
  nothing.** Both mean the list is not trustworthy as given. Resolve it before
  writing rather than carrying a list you have been told is wrong.

**Dropping one requires saying so.** If this session retired a constraint,
record it as retired with the reason:

```
- Retired this session: <the constraint, quoted exactly as it was written>, because <reason>.
```

**The quote has to match the original.** Retirement works by matching that text
against the bullet in the earlier handoff, so an approximation retires nothing
and the constraint keeps coming back. `cli.js constraints` says so when a
retirement matches nothing, and that warning means the wording, not the
decision, is wrong.

Silence is not retirement. A constraint that vanishes without a line explaining
why is indistinguishable from one that was forgotten, which is how the
AlwaysAllow design system was lost between the 2026-08-05 handoff and the
2026-08-08 one that superseded it.

**Never edit an old handoff to backfill this.** Handoffs are owned by this skill
and are a record of what was true when they were written. The new document is
the carrier.

**Prefer what was verified over what was intended.** A version number, a
manifest and a passing manifest entry all report intent. Only running something
reports behaviour. Where the two differ in this session, write down which is
which. That distinction is the single most useful thing a handoff carries, and
it is the first thing lost when the session is summarized casually.

---

## Step 2: Write the handoff

Ask where it goes:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js target "<short topic>" --json
```

It returns the path, the kind, and the slug `/pickup` will need. A directory
with its own work scope gets `HANDOFF.md` alongside the work. Anywhere else,
including the home directory, gets a topic-named file in the central handoffs
folder, so that separate threads of work do not overwrite each other.

Write this, filling every section that has content and dropping any that does
not:

```markdown
# Session Handoff
**Date:** [today's date, from the session start note]
**Working directory:** [path]

## What was worked on
[Two or three sentences. The subject, not the activity.]

## Constraints still in force
- [what governs future work, and nothing else on the line]
- Retired this session: [the constraint, quoted exactly], because [reason].

## Decisions made
- [Decision, and why]

## Files created or changed
| File | What it does |
|---|---|
| [path] | [one line] |

## Verified vs assumed
- [Claim, and how it was checked. Say plainly which claims were not.]

## Open loops
- [Unfinished or deferred, with enough detail to pick up cold]

## Next actions
1. [First concrete step]

## Context to reload
[Specific files or notes worth opening next time. Name them, do not attach them.]
```

Do not invent content to fill a section. An empty section is information. A
padded one is noise that costs tokens at every future pickup.

### Then confirm it is actually there

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js find "<slug>" --json
```

Writing the file and recording where it went are two different things, and
`cli.js target` does the second before the first. It notes the intended path so
`/pickup` can find it later, and that note survives whether or not anything was
ever written there.

So the index saying a handoff exists is not evidence that it does. This command
checks the file itself, and a null match means nothing was written, whatever the
step above reported.

Carry the result into Step 4. It decides what that step is allowed to say.

---

## Step 3: Update the durable notes, if this project has them

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js memory --json
```

If that returns a directory, this project keeps notes that load at the start of
every session. Update them with anything from today that stays true beyond this
week, and only that.

Rules, because this file is read every session and grows forever if nobody
guards it:

- Read what is there before writing. You are editing, not appending.
- Only touch entries related to this session's work.
- Do not remove earlier entries unless they are now resolved or wrong.
- Never rewrite the whole thing.
- Prefer replacing a stale line to adding a second line beside it. Two entries
  that disagree cost more than either one alone, and the reader cannot tell
  which is current.

If it returns nothing, skip this step. Do not create the directory. It belongs
to the harness, not to this plugin.

**Skip this step entirely if the session was empty.** An empty session must
never overwrite durable notes.

### Then measure what you just wrote to

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js memory-check
```

Everything above this line is advice, and advice is what every component in this
library has now been caught failing at. This is the number.

It changes nothing and deletes nothing. Surface whatever it reports in the Step
4 summary, and stay silent when it reports nothing.

| What it says | What it means |
|---|---|
| `oversize-live` | A file meant to be replaced has been grown instead. Something in it already happened and can go |
| `oversize-durable` | Long enough to be worth splitting, though length here is allowed |
| `over-budget` | The directory as a whole. Each file is pulled in whenever it looks relevant, so the cost is paid repeatedly |
| `unlisted` | Nothing in the index points at it, so it may never be recalled |
| `dangling-index` | The index points at a file that is not there |
| `broken-link` | A `[[link]]` resolves to nothing |

**Do not act on these unprompted.** Report them and let her decide. Trimming
somebody's notes because a number went over is exactly the behaviour a check
like this must never have.

**If something is flagged `oversize-live`, check its declared type before
trimming.** A file that has quietly become durable reference should be retyped
rather than cut. The first real run of this check flagged two files and one of
them was simply mislabelled.

---

## Step 4: Show the summary

```
## Session wrapped

### What we did
- [bullet]

### Decisions captured
- [bullet]

### Files written
- [path], [what it is]

### Next time
1. [first next action]

### Filed away
[Only if Step 0 moved something. List the slugs. Otherwise omit the heading.]
```

How that ends depends on the check at the end of Step 2, and there is no
version of it that does not.

**Where the check returned a match**, close with:

```
Handoff saved to [path].

/pickup [slug]
```

**Where it returned nothing**, close with this instead and stop:

```
Handoff was NOT written to [path]. Nothing to pick up.
```

Do not print the `/pickup` line in that case. A slug that resolves to no file
sends the next session looking for something that was never there, and the one
after that starts from nothing with no sign anything went wrong.

The two endings are kept out of the template above on purpose. An earlier
version of this step had the saved line and the `/pickup` line sitting inside
it, with the condition written underneath as prose. That is the same shape as
the bug this step exists to prevent: the part read first states the good
outcome plainly, and the qualification arrives afterwards, where it is easy to
skim past. A template that cannot be copied without deciding is better than a
correct sentence below one that can.

Where the handoff was saved, the `/pickup [slug]` line goes last, always, on
its own. It gets copied straight into the next session, so anything printed
after it has to be scrolled past.

---

## Notes

**Small sessions still get wrapped.** One decision in twenty minutes is still
the thing the next session needs.

**If asked for a "quick wrap":** write the files, confirm the path, skip the
summary.

**If there is genuinely nothing to capture**, a fresh session with nothing
discussed, say "Nothing to wrap, the session was empty" and write nothing at
all. Do not touch the durable notes.
