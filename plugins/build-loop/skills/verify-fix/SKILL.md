---
name: verify-fix
type: human
description: Human-review verification gate for fixes. Presents the original failing scenario from the queue entry, shows the before/after diff, and asks the user whether the fix looks right. If yes — signals pass (apply-fix handles the commit). If no — leaves the queue entry Open with a note recording the rejected attempt, and restores the target file to its pre-fix state. Can be called from within /apply-fix or invoked standalone to re-verify a fix from a previous session.
argument-hint: "[queue-entry-id or target-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mktemp:*), Bash(mv:*), Bash(node:*)
---

You are the human-review verification gate for the build loop. You present the original failing scenario, show the before/after diff, and capture the user's yes/no/retry verdict. You do NOT commit — committing is /apply-fix's responsibility.

Two modes of operation: Mode A (called from within /apply-fix at Step 6) and Mode B (called standalone to re-verify a fix from a previous session).


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

## Mode A: Called from within /apply-fix (Step 6)

When /apply-fix reaches its Step 6, it has already:
- Loaded the queue entry
- Read the target file (pre-fix content, Step 4)
- Reasoned about the fix out loud (Step 5)

/verify-fix then runs Steps V1 through V4 using that context. The target file has NOT been written yet — verification happens before write.

---

### Step V1 — Present the failing scenario

Display:

```
Testing fix for: {target}

It did: {what_happened}
It should have done: {what_expected}
Correct output would look like: {correct_example}
```

Use plain language. Quote the queue entry's fields directly without paraphrasing.

---

### Step V2 — Show the diff

Frontmatter is not touched. See the note in `/apply-fix` Step 6: the `version`,
`last_updated` and `correction_notes` fields came off on 2026-07-28, because git
records the same thing and cannot drift.

Display the diff in this exact format:

```
Here's what I'll change:

BEFORE:
  "{verbatim old text from the target file — exact characters, including surrounding context}"

AFTER:
  "{verbatim new text as it will appear in the file — exact characters}"

What else changes:
  - {any other changes, or "Nothing else was touched"}

Does this look right? Reply yes, no, or retry: [your instructions]
```

Rules for the diff:
- Use plain language only. No code symbols, no programming jargon.
- Quote the actual text verbatim in BEFORE and AFTER blocks. Never paraphrase old or new text.
- "What else changes" lists everything outside the BEFORE and AFTER blocks. Where there is nothing, say `Nothing else was touched.` rather than dropping the line, so a silent extra edit cannot hide in an omission.
- If the change is an addition (new text, not a replacement), show BEFORE as location context ("After step 3...") and AFTER as the new text being inserted.
- If multiple distinct blocks change, show multiple BEFORE/AFTER pairs.

---

### Step V3 — Capture the user's response and route

**STOP after Step V2.** Wait for the user's response before doing anything else.

- **"yes"** (or any clear affirmative): Signal PASS.
  Display: "Got it, writing and committing the fix."
  Return control to /apply-fix Step 7 to write the file and Step 8 to handle the commit and queue update. /verify-fix does NOT write or commit.

- **"no"** (or any negative without retry instructions): Signal FAIL.
  Proceed to Step V4.

- **"retry: {instructions}"**: Signal REVISE.
  Pass {instructions} back to /apply-fix Step 5 to revise the fix reasoning.
  Do NOT change the queue status. Do NOT write the target file.
  Return to Step V1 after revision with the updated fix.

---

### Step V4 — Fail path: mark queue and report

**This step is shared by both modes, and the file state differs between them.**
Work out `{file_state}` before writing anything:

| Called from | State of the target file | `{file_state}` |
|---|---|---|
| Mode A, within `/apply-fix` | Never written. Verification happens before the write. | `The target file was never written.` |
| Mode B, standalone, entry has a `Committed:` note | Already written and committed in an earlier session. | `The fix is already committed, so the target file still carries it until it is reverted.` |
| Mode B, standalone, entry has a `Not committed:` note | Written, never committed, because its root is not a git repository. | `The fix was written to the target file and never committed, so the file carries it and there is no commit to restore from.` |
| Mode B, standalone, neither note | Written at some point, with no record of whether it was committed. | `The target file was written and the entry records no commit either way.` |

Getting this wrong writes a false audit trail. Mode B exists to re-review a fix
from a previous session, which by definition was applied, and the branch below
offers to help restore that file precisely because it did change. A note saying
the file is untouched would contradict the offer sitting next to it.

Set the status back to `"Open"` and record the attempt, in one call:

Write the note to a scratch file, reading:

> Fix attempted and rejected at the verify gate. {retry instructions if given, else 'No reason given.'} {file_state}

Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open --note-file {scratch}/note-{id}.txt
```

`--note-file` rather than `--note` because the retry instructions are text the
user typed. A double quote or a `$(...)` in them would end or extend the shell
argument, and this runs where `Bash(node:*)` is allowed.

A rejected fix is an open bug. It used to get its own status,
`"fix attempted / unresolved"`, which read as more precise and was worse: no
filter in `/list-bugs` reached it, so rejecting a diff removed the entry from
the only view that lists work. The attempt is not lost, it is the note above,
and a note is visible where a status was not.

**Never edit a queue entry with the Write tool.** `queue.js` reads, changes and
writes inside one process holding one lock, so another session cannot write the
same entry in the gap between your read and your write. It also appends the note
to what is on disk now rather than to the copy you read earlier, which is how a
note recorded by a session you never saw survives.

If the command exits non-zero, report what it printed. The entry keeps its
previous status and nothing partial is left behind.

Display:
```
Understood. Fix discarded. Queue entry {id} stays Open, with a note recording
that this attempt was rejected. {file_state} You can try again with /apply-fix
or leave this for later.
```

---

## Mode B: Standalone invocation

When /verify-fix is invoked directly (not from within /apply-fix), it works independently. Use this when a fix was applied in a previous session and you need to review it retroactively, or when you want to re-examine an In Progress entry.

---

### Step S1 — Locate the queue entry

- If `$ARGUMENTS` matches the pattern `YYYY-MM-DDTHH-MM-SS-{target}` (a full queue entry ID): read `~/.claude/build-loop/queue/{id}.json` directly.
- If `$ARGUMENTS` is a target name: run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file. Find entries whose name equals `$ARGUMENTS`, reading `target` and falling back to `skill` when `target` is absent (SCHEMA.md read-time mapping), AND `status` is `"In Progress"` or `"fix applied, watching"`. If multiple match, list them (id, status, created_at) and ask the user to pick. Do not proceed until they pick.
- If `$ARGUMENTS` is empty: list all entries with status `"In Progress"` or `"fix applied, watching"`. If none, say "No fixes in progress or recently applied. Run /list-bugs to see current status." Stop.

Check the loaded entry's status:

- **"fix applied, watching"**, with a `Committed:` note carrying a hash: The fix was approved and committed. Say: "This fix was already committed at {commit-hash from notes}. Do you want to review the change retroactively? I can show you the diff from that commit." Wait for confirmation before proceeding.
- **"fix applied, watching"** with a note starting **`Not committed:`**: `/apply-fix` Step 8 writes that marker when it wrote the file and had nowhere to commit it. Quote the reason from the note rather than restating it, since the note carries the actual `{target_path}` and `{repo}`. Say: "This fix was written and never committed. The entry records: {the Not committed: note}. There is no diff to show and `/revert-fix` cannot undo it. I can show you what is in the file now." Then go to Step S3.
- **"fix applied, watching"** with **neither** marker: say "This entry is 'fix applied, watching' but records no commit and no reason. I can show you what is in the file now, though I cannot tell you whether it was committed." Then go to Step S3.

  **Do not infer a cause from a missing hash.** Step S4's own standalone PASS path below promotes an `In Progress` entry to this status with a note and no hash, so hashless entries arise here as well as from a missing repository. Guessing tells someone their repository is not a git repository when it is. And read the notes before asserting a hash at all: printing `{commit-hash}` unsubstituted is the failure this skill forbids in Step S3.
- **"In Progress"**: The fix was started but not committed (session may have been interrupted). Proceed to Step S2.
- **"Open"**: Say "This entry hasn't had a fix proposed yet. Run /apply-fix {id} to start the fix process." Stop.
- Any other status: Say "This entry is {status}. Nothing to verify." Stop.

---

### Step S2 — Re-present the failing scenario

Display the same format as Step V1:

```
Testing fix for: {target}

It did: {what_happened}
It should have done: {what_expected}
Correct output would look like: {correct_example}
```

---

### Step S3 — Show what's currently in the target file

**Resolve `{target_path}` to a readable file first.** The Read tool cannot read a directory,
and a `plugin`-kind entry may record one. `/flag-issue` requires a plugin to be recorded as
`plugins/{target}/.claude-plugin/plugin.json`, so an entry holding the bare directory predates
that rule or was written by hand.

1. Check what the path is: `ls -d {target_path}` tells you it exists, and `ls -d {target_path}/` succeeding on a path without a trailing slash in the entry tells you it is a directory.
2. If it is a **file**, read it and carry on.
3. If it is a **directory** and `target_kind` is `plugin`, read `{target_path}/.claude-plugin/plugin.json` instead. Say which file you substituted and why, so the user can see the entry is imprecise: "The entry records the plugin directory, so I am showing `.claude-plugin/plugin.json`."
4. If it is a **directory** and `target_kind` is anything else, stop and use the directory branch in Error handling. Do not guess at a file.

For a `plugin`-kind entry, `plugin.json` is rarely where the fix landed, so it is a poor thing
to verify against. When the entry's status is `"fix applied, watching"` its notes carry the
commit hash, and that commit is the honest source for what changed.

**Only when the status is `"fix applied, watching"` and the notes actually carry a hash.** Step
S2 and S3 are also reached from `"In Progress"`, where no commit exists yet, so this line is
conditional and not something to print for every plugin entry.

When the guard holds, **name the command for the user to run rather than offering to run it.**
`allowed-tools` has no `Bash(git:*)` and must not gain it: this skill is the review gate, and
the one thing it must be unable to do is commit. Step S4 already hands git commands to the user
for the same reason. Say:

> "This is a plugin-level entry, so there is no single target file, and I am showing {resolved file} instead. The fix was committed as {hash}. To see what actually changed, run: git -C {repo_root} show {hash}"

When the status is `"In Progress"`, or the notes hold no hash, **omit this line entirely** and
show the resolved file on its own. Never print `{hash}` unsubstituted, which is what a
command with a missing value looks like to the person asked to run it.

Then read the resolved file using the Read tool. Display:

```
Here's what the target file currently looks like at the relevant section:

{the relevant section of the current target file — the lines most likely changed by the fix, based on what_happened and what_expected}
```

Note: In standalone mode, the "BEFORE" state (pre-fix content) may not be available if the fix was already written. Display what IS currently in the file and ask:

> "Is this what you expected the fix to look like? Reply yes, no, or retry: [your instructions]"

---

### Step S4 — Ask for verdict and route

Same three response types as Step V3:

- **"yes"** (PASS in standalone mode):
  "Noted, the fix looks correct. Updating the queue entry to record your approval."
  If status was `"In Progress"`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status "fix applied, watching" --note "Standalone verify: the user confirmed fix looks correct."`.
  Display: "Queue entry {id} is now 'fix applied, watching'. Try it in a real session. When it works, you can close this to Resolved."

- **"no"** (FAIL in standalone mode):
  Follow Step V4 fail path (set status back to `"Open"`, append failure note),
  using the **Mode B** row of `{file_state}` that matches this entry's notes. The fix
  reached the file in an earlier session, so a note claiming it is untouched would
  contradict the offer on the next line. Pick the row by the note, not by assuming a
  commit: writing "already committed" onto an entry that was never committed puts a
  false audit trail on the record, which is the exact thing this table exists to stop.

  **Then offer a restore only if a `Committed:` note exists:**

  > "Should I help restore the target file to its pre-fix state? To check what the file looked like before: git -C {repo_root} log --oneline -5, find the commit with [queue:{id}] in the message, then run /revert-fix {id} to undo it."

  With a `Not committed:` note, there is no commit and `git log` cannot run usefully in
  a directory that is not a repository, so say this instead:

  > "There is no commit to restore from, because this was written without one. Undoing it means editing {target_path} back by hand. The entry is back to Open, so /apply-fix {id} can now propose a corrected fix."

  With neither note, say the restore path is unknown rather than picking one:

  > "The entry records no commit, so I cannot tell you whether git can restore this. Check `git -C {repo_root} log --oneline -5` for a commit mentioning [queue:{id}]. If there is none, the file has to go back by hand."

- **"retry: {instructions}"** (REVISE in standalone mode):
  "To revise this fix, run /apply-fix {id}. It will pick up the In Progress entry and you can guide it with your instructions."
  Do NOT change queue status. Stop.

---

## Error handling

- **Queue entry not found**: "No queue entry found at {path}. Check the ID and try again." Stop.
- **Target file not found (Step S3)**: "Can't find the target file at {target_path}. Is this path correct?" Show what IS in the queue entry and ask if the user wants to update the path. Use this only when the path resolves to nothing. A path that exists and is a directory is the next case, and asking whether a correct path is correct sends the user looking in the wrong place.
- **Target path is a directory (Step S3)**: the path is right and the assumption that it names a file is wrong, so say that rather than blaming the path. For a `plugin`-kind entry with no `.claude-plugin/plugin.json` under it, and for any other kind:

  > "Can't read the target for {id}. target_path is the directory {target_path}, and a {target_kind} entry should point at a file. Fix the entry's path, or run /audit-deps to rebuild it."

  For a `plugin`-kind entry name the file it should have held: "a plugin entry should point at `.claude-plugin/plugin.json`". Show what is in the queue entry either way, and do not proceed to Step S4 with nothing displayed.
- **The write fails**: report what `queue.js` printed. It leaves no partial file and the entry retains its previous status. A refusal usually means another session holds the lock, so the remedy is to run it again.
