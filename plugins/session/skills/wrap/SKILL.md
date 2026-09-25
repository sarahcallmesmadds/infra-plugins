---
name: wrap
description: End-of-session wrap. Writes down what was decided, what was built and what is next, into a handoff document the next session can load. Use at the end of a working session, or when the user says "wrap", "let's wrap", "wrap up", "wrap this session", "close out", or invokes /wrap. Pairs with /pickup, which reads what this writes.
allowed-tools: Read, Write, Edit, Bash(node:*)
---

# Wrap

Close the loop before closing the laptop. Your job is to make sure nothing from
this session is lost, and that the next one starts with context instead of
starting from scratch.

The output is one handoff document. Write it for a reader who was not here.

**Two ways handoffs are kept, and this skill does both.** Where threads are set
up, a handoff written from the home directory belongs to a thread: one document
per subject, rewritten in place every wrap, and the only place that thread's
rules live. Everywhere else, and anywhere threads are not set up yet, each wrap
writes as it always has. Step 1 says which applies.

---

## Step 0: Check the scripts, then sweep

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js capabilities --json
```

It has to print a JSON object whose `threads` is 1 or higher. Anything else,
such as a list of commands or an error, means the scripts installed in this host
are older than this skill. Stop and say: "The installed session
scripts are older than this skill; update the session plugin in this host and
start a new session." Wrapping against older scripts writes a new document per
session, which is the behaviour this skill was changed to end.

Then sweep:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js archive
```

This moves handoffs untouched for 30 days into an `archived/` folder. It moves,
never deletes, and `/pickup` still finds archived documents by name. It never
moves a declared thread or a handoff listed as protected in the user's config,
and it never renames over a document already in the archive.

If it says the sweep was skipped because another session holds the lock, that
is fine: the next wrap sweeps. If it says the sweep was refused, the protected
list or the thread list cannot be read; say so in the summary, because until
that is fixed nothing that writes a handoff will run.

If it reports moving anything, mention it in the Step 4 summary under "Filed
away". If it reports nothing, say nothing about it.

### Then check the folder still agrees with the index

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js reconcile
```

Read-only. It changes nothing here, and it is run at the start rather than the
end so that a slug returning the wrong document is known before this session
records another one.

**Only one of its findings is urgent.** A slug reported as returning the wrong
handoff means `/pickup` opens a different document and says nothing, so surface
that immediately and name both paths. It is not repaired automatically because
choosing between two real documents is the user's call, not this skill's.

Duplicated slugs, dead entries and unlisted documents are untidiness. None of
them stops anything being found, so mention them in one line in the Step 4
summary under "Filed away" and move on.

**Entries it reports as recorded in the last few minutes are not findings at
all.** That is another session's wrap in flight, quite possibly one running
beside this one. Do not offer to clear them and do not repeat them as a problem.
The same goes for an entry whose directory could not be read, which may be a disk
that is not plugged in.

Do not run `--fix` as part of a wrap: it writes to the index, and a wrap is
already the one command most likely to be running in another session at the same
time.

If it reports that the index and the folder agree, say nothing about it.

---

## Step 1: Review the session

### First, which thread this is

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js threads --json
```

**Threads apply only when this session's working directory is the home
directory.** Anywhere else, including a repository that has no `HANDOFF.md` yet,
write as Step 2 describes for everywhere threads do not apply, whatever `mode`
says. A thread's `save` refuses a draft whose `**Working directory:**` is not
the home directory, so routing anything else to it writes nothing.

- **`mode: "pre-migration"`**: threads do not apply. Skip to the review below.
- **`mode: "invalid"`**, or `pending` is not zero: stop. Say the thread list
  cannot be read, or that a migration is part way through and needs
  `cli.js migrate finish`, and write nothing.
- **`mode: "threads"`**: this wrap saves exactly one thread. Decide which, in
  this order, and never start a new one just because the first answer was
  missing:
  1. The user named one.
  2. A `Thread:` line printed by a pickup in this conversation, or kept in its
     summary. Check its subject still matches what this session did. If there
     is more than one such line, or the work moved on to something else after
     the pickup, ask which thread this wrap belongs to.
  3. The list above: pick the thread whose subject covers this session, and
     say which one in a line before going on. If more than one fits, ask.
  4. None fits: propose a name for the subject, never for the last thing
     shipped. Run `cli.js find "<name>" --json` first; if anything matches,
     pick another name, or ask whether to adopt that document as the thread
     with `cli.js declare`. Then ask the user to confirm the name in one line.
     That becomes a new thread in Step 2.

  If the session did real work on two threads, say so and offer to run the wrap
  again for the other one. Never fold two threads into one document.

  **For an existing thread, get the revision first, then read.** Run
  `cli.js find "<slug>" --json` and keep `thread.rev` and `thread.generation`,
  then read the whole document at `thread.path`. Never the other way round: a
  revision taken after reading can belong to a save this session never saw,
  and the save would then overwrite it without a conflict. If a `Thread:` line
  from this conversation shows a rev that is not the start of `thread.rev`,
  another session saved this thread since the pickup: say so, and read what
  changed before rewriting.

  **For a new thread** there is nothing to read. Take `generation` from the
  `threads --json` output above and use `--base none` in Step 2.

### Then review

Read back over the whole conversation and pull out:

1. **What was worked on.** The actual subject, not the list of tools used.
2. **Decisions made.** Anything settled that constrains future work: a name, a
   format, an approach chosen over another. Record why, because the why is what
   stops the decision being reopened next week.
3. **Files created or changed**, with paths and one line each on what they do.
4. **Open loops.** Raised and not resolved, deferred on purpose, or asked and
   never answered.
5. **Next actions.** Concrete enough to start on without rereading anything.

Then collect what is still binding from before this session. For an existing
thread:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints --thread "<slug>"
```

That is the thread's own rules, and it is the whole list. Carry them into the
rewrite, add what this session decided, and remove what it retired. Nothing from
any other handoff binds a thread, so nothing from any other handoff is carried
into it. A new thread skips this: it starts with only the constraints this
session set.

If two of a thread's rules read as one rule in two wordings, keep the current
wording, delete the other, and add one `Retired this session:` line for it. For
a thread the check is the draft, not the command, which reads the saved file
and keeps reporting both until the save.

Everything from here to the end of this step is about handoffs outside threads:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js constraints
```

**Outside threads, a decision made in an earlier session does not stop applying
because this session was about something else.** Scope is the repository, so a
worktree inherits from its main checkout.

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
- **It warns that two constraints look like one rule in two wordings.** This is
  the one a wrap can make worse rather than merely inherit. Carrying both
  forward verbatim, which is what every other instruction here tells you to do,
  writes the fork into another document and grows it.

  Resolving it is not a judgement call about which reads better. Ask which
  wording is current, carry that one, and retire the other by quoting it
  exactly, per the retirement rule below. Then check the command again before
  writing: a retirement that matched nothing has left both live and the wrap is
  about to record them both.

  Where the two turn out to be genuinely different rules that happen to read
  alike, say so in the handoff. The check reports and never edits precisely
  because it cannot tell the difference, and an unexplained pair will be
  reported again at every wrap from here on.

**Nothing inside a constraint may change between sessions.** No running count,
no session number, no date, no "third time this has come up". This governs
every route a constraint reaches the handoff by: carried from the command,
proposed out of an older handoff, or written for the first time in this
session. Matching is on the whole text, so a value that moves makes every
session's copy a different constraint: carrying it verbatim preserves a stale
figure, correcting it forks a near duplicate, and there is no third option.
Measured on 2026-08-15, one rule about where handoffs file was live in five
numbered wordings at once, ending "Sixth" through "Tenth session running", and
five retirement lines had been written chasing four of them. Retiring one
leaves the rest in force, because an exact quote is exact.

Where the recurrence is itself the point, count it rather than storing it. How
many handoffs carry a constraint is a search anyone can run, and what a rising
count is really reporting, a tool that keeps proposing the wrong answer,
belongs in the bug queue where it can be fixed rather than in a number that
records it being tolerated.

**A rule that outlives the work belongs in the project, not in the handoff.**
Before carrying one, ask whether it stays true after this piece of work ends. A
deploy restriction, a filing rulebook, a standard the code has to meet: those
are documentation, and they belong in that project's own instructions file. A
handoff constraint is for what is true this week and false next: which checkout
is shared right now, what is half migrated, what is waiting on somebody.

**This is not Step 3, and the two must not both take the same rule.** The
durable notes hold what stays true about the work and the person across every
project, and load every session wherever it starts. A project's instructions
file holds what governs work inside that one project, and loads when the work is
in it. So a rule naming a repository, a path, a branch or a deploy target goes to
the project; a rule about how to work, or about the person, goes to the notes in
Step 3. Sending one rule to both is how two copies come to disagree, which is the
thing this whole section exists to stop.

**Check the destination is reachable from the runtime before moving anything.**
Claude Code loads a project's `CLAUDE.md` on its own once work moves into the
folder. Codex does not, and this plugin ships a Codex manifest, so a rule filed
that way is invisible to half the hosts this skill runs on. It would not merely
read as noise there, it would stop binding, with a retirement line in the
handoff saying it had been safely filed.

So a project qualifies as a destination when its rules are reachable from every
runtime the work runs under, which today means Claude Code and Codex. The usual
arrangement is the rules in `CLAUDE.md` with an `AGENTS.md` beside it holding a
pointer rather than a second copy. A project keeping its rules in `AGENTS.md`
alone qualifies just as well, provided every runtime in use reads that file.

**Confirm it rather than inferring it from the filenames.** Which names a host
loads is a property of that host and its version, so it is checked where the
work is happening and not promised here.

**Where a project does not qualify, the rule stays in the handoff.** A list that
is too long is recoverable by reading it. A rule nobody's runtime can see is not.

Carrying a permanent fact forward instead is how a document about one thing
accumulates the rules of everything. Measured on 2026-08-16, a handoff about a
writing skill carried 26 rules, and 21 of them belonged to a project rather than
to the work that session was doing.

**Ask before writing into a project's instructions file, every time.** That file
is committed and shared with everybody who works in the repository, and a wrap is
not the moment to change one unasked. Show the rule and the file it would go
into, and move it only on an explicit yes:

> This rule outlives the work, so it belongs in `<file>` rather than the handoff.
> Move it there? <the rule, quoted>

No answer is a no. Without one the rule stays in the handoff, the same fallback
as a project the runtime cannot reach. Nothing else in this skill writes outside
the handoff and the durable notes without being asked, and this is not the
exception.

**Write it into the project file first, then retire it here.** A move is a
retirement and uses the same line, so the trace survives:

```
- Retired this session: <the constraint, quoted exactly as it was written>, because it is now recorded in <the path of the file it was actually written into>.
```

**Name the file the rule landed in, not the file that made the project
qualify.** Those are usually different. In the common arrangement the rules sit
in `CLAUDE.md` and `AGENTS.md` is the pointer that makes them reachable from
Codex, so the note names `CLAUDE.md`. A project that keeps its rules in
`AGENTS.md` instead is named that way. Writing the wrong one produces a note
pointing at a file the rule was never written into, which is the failure
described immediately below rather than a cosmetic slip.

The order is not a preference. A retirement written before the destination
exists deletes the rule and leaves a note saying it was filed somewhere it is
not, which is worse than either doing nothing or losing it outright, because the
note stops anybody looking.

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
why is indistinguishable from one that was forgotten, which is how an
approved design system was lost between one handoff and the one that
superseded it three days later.

**Never edit a handoff that is not this wrap's own.** That means every other
thread, every history document, and anything protected. Those are a record of
what was true when they were written. Outside threads, the new document is the
carrier. Inside a thread, the thread's one document is, and a retirement there
is the bullet deleted plus one `Retired this session:` line for this session
only. That line is not carried into later rewrites, because nothing outside the
thread reads it.

**Prefer what was verified over what was intended.** A version number, a
manifest and a passing manifest entry all report intent. Only running something
reports behaviour. Where the two differ in this session, write down which is
which. That distinction is the single most useful thing a handoff carries, and
it is the first thing lost when the session is summarized casually.

---

## Step 2: Write the handoff

### For a thread

A thread's document is the current state of the whole subject, not a log of
this session. Rewrite it from the version read in Step 1:

- keep every open loop until it is resolved or superseded, and every decision
  while it still governs work;
- replace "Verified vs assumed" with what is true now;
- set `**Last session:**` to today's date and one line on what changed;
- carry the constraints as Step 1 describes.

A small session must not erase the rest of the subject.

Write the whole document to a draft file outside `~/.planning/handoffs` (in
Claude Code, the session's scratchpad directory; in Codex, the system temporary
directory), then save it. Never write the thread's file directly, and never
write a `HANDOFF-*.md` into the handoffs folder yourself:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js save --thread "<slug>" --from "<draft path>" --base "<rev from Step 1>" --generation <N> --json
```

For a new thread, add `--create` and pass `--base none`.

Read what comes back:

- `saved: true` (and `declared: true` for a new thread): done. Go to Step 3.
- `saved: true` and `declared: false`: the file is written but is not a thread
  yet. Go to Step 3 and end as Step 4 says for that case.
- `reason: "conflict"`: another session saved this thread after this one read
  it. Read it again, merge this session's changes into what is there now, and
  save once more with `--base` set to the `currentRev` the refusal gave. If that
  conflicts too, stop and tell the user; do not overwrite.
- `reason: "name-taken"`: a new thread's name already belongs to another
  handoff. Do not merge into it. Pick another name with the user, or adopt that
  document with `cli.js declare`, and save again.
- `reason: "busy"`: another session is writing handoffs right now. Wait a
  moment and save once more; if it is still busy, stop and say so.
- Any other refusal: nothing was written. Report the reason, and the kept draft
  path when `draft` is present, and stop.

The save refuses to write anything it cannot verify, so there is no separate
existence check to run afterwards: its answer is the check.

### Anywhere threads do not apply

Ask where it goes:

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js target "<short topic>" --json
```

It returns the path, the kind, and the slug `/pickup` will need. If it returns
`refused` instead, stop and report it: the path is protected, or is a declared
thread, and nothing may be written there this way. It also says when the entry
was not recorded in the index (`recorded: false`); say that in the summary,
because a project handoff kept outside the configured roots may then not be
found by name. A directory
with its own work scope gets `HANDOFF.md` alongside the work. Anywhere else,
including the home directory, gets a topic-named file in the central handoffs
folder, so that separate threads of work do not overwrite each other.

Write this, filling every section that has content and dropping any that does
not:

```markdown
# Session Handoff
**Date:** [today's date, from the session start note]
**Working directory:** [path]
**Last session:** [for a thread: today's date and one line on what changed. Drop this line outside threads.]

## What was worked on
[Two or three sentences. The subject, not the activity.]

## Constraints still in force
- [what governs future work, and nothing else on the line]
- [Retired this session: the constraint quoted exactly, because the reason. Drop this line unless something was actually retired.]

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

### Then confirm it is actually there (outside threads)

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js find "<slug>" --json
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
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js memory --json
```

If that returns a directory, this project keeps notes that load at the start of
every session. Update them with anything from today that stays true beyond this
week, and only that.

Rules, because this file is read every session and grows forever if nobody
guards it:

- Read what is there before writing, and place what you are adding against it.
  You are editing, not appending. Placing it has a procedure, below, because
  reading and then appending anyway is the failure this step keeps having.
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

### Place it before you write it

Read the headings already in the file. Then, for each thing you are about to
add, say one of these two sentences, and say which one it is:

- **"This belongs under `<heading>`."** Sharpen that section rather than
  opening a new one. A section that already covered the shape and now covers it
  better is the result, not a consolation prize.
- **"No existing heading covers this."** Name the closest heading you rejected
  and why it does not fit. Being unable to name a close one is the evidence
  that it is new.

A new section is the exception. Two sections describing the same shape from
different directions are one section, and the later arrival is the one that
should not exist. The rule above was in force for every session that grew
`plugin-build-lessons.md` to 5,922 words across about 25 dated sections that
were not 25 distinct lessons, three of which open by explaining how they relate
to another section in the same file.

**Check the file's declared type while you are writing to it, not only when a
number flags it later.** If what you are adding never changes, and most of what
is already there never changes either, the file is durable reference wearing a
live label, and the fix is to retype it rather than to hold it under a cap it
was never meant to meet. Propose the retype and let her decide. The same
guidance sits at the end of this step for the moment `memory-check` flags a
file, which is a week later than it needs to be.

### Then measure what you just wrote to

```bash
node "${CLAUDE_PLUGIN_ROOT}"/scripts/cli.js memory-check
```

Nothing above this line checks whether any of it happened, and every component
in this library has now been caught skipping its own rules. This is the number.

It changes nothing and deletes nothing. Surface whatever it reports in the Step
4 summary, and stay silent when it reports nothing.

| What it says | What it means |
|---|---|
| `oversize-live` | A file meant to be replaced has been grown instead. Something in it already happened and can go |
| `oversize-durable` | Long enough to be worth splitting, though length here is allowed |
| `over-budget` | How far the oversize files above are over their own caps, added up. It is silent when every file is within its cap, whatever the directory totals |
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

**For a thread**, the ending follows what `save` reported:

- saved, and declared if it was new: `Handoff saved to [path].` then the pickup
  line below, using the `slug` that `save` returned, which is the name as the
  script stored it.
- saved, but `indexUpdated: false`: the same, plus one line that the index was
  not updated. A thread is still found by name.
- saved as a new thread but `declared: false`: `Handoff saved to [path], but it
  is not a thread yet. Run cli.js declare [slug].` and no pickup line.
- not saved, with `reason` of `verify-failed`, or of `write-failed` with
  `previousUnchanged: false`: `Update NOT saved, and the state of [path] is
  uncertain. Check it before the next wrap. The draft is at [draft].` and no
  pickup line.
- not saved for any other reason, which all refuse before writing: `Update NOT
  saved; the previous handoff at [path] is unchanged. The draft is at [draft].`
  and no pickup line.

**Anywhere threads do not apply, where the check returned a match**, close with:

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
after it has to be scrolled past. In Codex the same slug is passed to the pickup
skill by asking for it; say that in one line above the `/pickup` line, never
below it.

---

## Notes

**Small sessions still get wrapped.** One decision in twenty minutes is still
the thing the next session needs.

**If asked for a "quick wrap":** write the files, confirm the path, skip the
summary.

**If there is genuinely nothing to capture**, a fresh session with nothing
discussed, say "Nothing to wrap, the session was empty" and write nothing at
all. Do not touch the durable notes.
