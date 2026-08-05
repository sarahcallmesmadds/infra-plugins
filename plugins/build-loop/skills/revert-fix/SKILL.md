---
name: revert-fix
type: human
description: Rolls back a committed fix. Reads the queue entry to find the commit hash, runs git revert in the correct repo (creates a new undo commit — does not delete or modify the original commit), resets the queue entry status back to Open, and stores the revert commit hash in notes. Works whether the commit has been pushed or not. The user does not need to know any git commands.
argument-hint: "[queue-entry-id or target-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mktemp:*), Bash(mv:*), Bash(node:*), Bash(git:*)
---

You are rolling back a committed fix. The goal: undo a bad fix commit without rewriting history, and put the queue entry back to Open so another attempt can be made.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

---

## Step 1 — Locate the queue entry

Look at `$ARGUMENTS`:

- **If it matches a queue entry ID format** (YYYY-MM-DDTHH-MM-SS-{target}, e.g. `2026-04-23T13-29-20-daily-brief`): read `~/.claude/build-loop/queue/{id}.json` directly using the Read tool.

- **If it is a target name** (e.g. `daily-brief`): run `ls ~/.claude/build-loop/queue/` and scan all `.json` files. Find all entries whose name equals `$ARGUMENTS`, reading `target` and falling back to `skill` when `target` is absent (SCHEMA.md read-time mapping), AND `status == "fix applied, watching"`.
  - If exactly one match: use it.
  - If multiple matches: list them (id, created_at, one-line of what_happened) and ask the user to pick. Do not proceed until they confirm one.
  - If no matches: say "No 'fix applied, watching' entries found for '{target}'. If the fix is in a different status, provide the full queue entry ID." Stop.

- **If $ARGUMENTS is empty**: list all entries across all `.json` files where `status == "fix applied, watching"`. Ask the user to pick. Do not proceed until they pick one.

**Annotate every list this step shows, not just one of them.** That means the
multi-match list under the target-name bullet as well as the empty-argument list.
Read each candidate's notes and label it by its **last** marker, since notes are
append-only and an entry can carry both (see SCHEMA.md, note markers):

| Last marker in note order | Label |
|---|---|
| `Committed:` | no label, this is the revertible case |
| `Not committed:` | `(no commit, nothing to revert)` |
| no marker at all | `(no commit recorded)` |

`"fix applied, watching"` does not imply a commit. `/apply-fix` lands there after
writing a file whose root is not a git repository, and `/verify-fix` lands there after
a standalone pass on an `In Progress` entry. Step 2's status guard passes for all of
them, because the status genuinely is `fix applied, watching`, so an unlabelled list
lets someone choose an entry Step 3 will then refuse. The point of labelling is that
the refusal comes before the choice rather than after it.

---

## Step 2 — Guard on status

Read the queue entry JSON using the Read tool.

- If `status` is NOT `"fix applied, watching"`: say "This entry has status '{status}', not 'fix applied, watching'. /revert-fix only reverts committed fixes. If you want to discard an in-progress attempt, use /apply-fix and reply 'no' to the diff." Stop.

- If `repo == "unknown"`: say "This entry has repo: unknown. I can't determine which git repo to revert in. Check the queue entry and resolve the repo field first." Stop.

---

## Step 3 — Find the commit hash

Scan the entry's `notes[]` array in order for objects whose `text` starts with
`"Committed:"` or `"Not committed:"`, and take the **last** one. Notes are append-only,
so an entry that was written without a repository and later committed carries both, and
the older `Not committed:` describes a state that has since changed. Deciding on the
first match found refuses to revert a commit that exists.

Extract the hash from that string. The format is:
```
"Committed: {hash} to {repo}"
```
Example: `"Committed: abc1234 to personal"` → hash is `abc1234`.

- If that last marker is **`Committed:`**, extract the hash from it as above and continue, even if an earlier `Not committed:` note also exists. The commit is the newer fact.

- If that last marker is **`Not committed:`**, there is nothing to revert and no commit to search for. `/apply-fix` Step 8 writes that marker when it wrote the file and the root was not a git repository. Quote the note rather than restating its reason, which keeps this correct if the wording gains other cases:

  > "There is nothing to revert. The entry records: {the Not committed: note}. No commit exists, so there is no earlier version for git to restore, and undoing it means putting the file back by hand.
  >
  > `/apply-fix {id}` will not do it either: it stops on any entry already at 'fix applied, watching'. Shall I reopen this entry so it can propose the reverse change? Or log the reversal as its own correction with `/flag-issue`, which is the better record if the original fix was simply wrong."

  If they say reopen, **run it yourself.** `Bash(node:*)` is in `allowed-tools`, so there is no
  reason to hand the user a command, and one reason not to: `${CLAUDE_PLUGIN_ROOT}` is set by
  the plugin runtime and is empty in an ordinary shell, so a quoted command carrying it expands
  to `node "/scripts/queue.js"` and fails with a missing file. Never print that variable in text
  addressed to the user. Where a command genuinely has to be handed over, substitute every value
  first, the way `/verify-fix` hands over `git -C {repo_root} log`.

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open --note "Reopened to write a reverse change. The original was written without a commit, so there is nothing to revert."
  ```

  `--note` rather than `--note-file` because that sentence is fixed text with nothing
  interpolated into it, which is the same reason the `Reverted:` note further down uses `--note`.
  Only the closing step at the end of this skill needs the scratch directory, because a
  resolution is an object and there is no way to pass one on the command line.

  If the call exits non-zero, say what it printed and that the entry is still at
  `fix applied, watching`. Then stop either way: writing the reverse change is `/apply-fix`'s
  job, not this skill's.

  Stop. Do not suggest `git log`, which cannot run usefully in a directory that is not a repository.

- If no `Committed:` note is found and no `Not committed:` note explains why: say "I can't find a commit hash in this queue entry's notes, and nothing records why. The commit hash is normally stored by /apply-fix after committing, and `/verify-fix` can also leave this status with no hash after a standalone pass. You may need to find the commit manually with: `git -C {repo_root} log --oneline | head -10`" Stop.

---

## Step 4 — Confirm before reverting

**Before running any git command, show the user exactly what will happen and wait for them answer.**

Show this message:

```
I'll run: git revert {hash} --no-edit in {repo_root}

This creates a NEW undo commit. It does not delete or modify the original commit.
The fix for {target} will be reversed.
The queue entry will go back to Open.

Proceed? (yes / no)
```

- If the user says **yes** or any clear affirmative: proceed to Step 5.
- If the user says **no** or any negative: say "Cancelled. Nothing changed." Stop. Do not touch the git repo or queue entry.

---

## Step 5 — Run git revert

Determine `repo_root` by looking up the entry's `repo` field in `roots` in
`~/.claude/build-loop.config.json` and taking that root's `path`. With no config
file there are the three defaults from SCHEMA.md: `personal` at
`~/.claude/skills`, `hooks` at `~/.claude/hooks`, and `commands` at
`~/.claude/commands`. A config holding `skillRoots` and no `roots` is read as
roots of kind `skill`. If `repo` is
`"unknown"`, or names a root that is no longer configured, stop and say so.
Never guess a repository to run a revert in.

A root that is still configured may no longer be on disk, which is a different
thing and reads the same from here. Ask about the one this entry names, before
running anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check --name {repo}
```

Exit 0 means that root exists. Anything else means it does not, or is not
configured at all: relay what the check printed and stop. A revert is the one
operation here where guessing at a repository would rewrite work in the wrong
place, so "the other roots are fine" is not a good enough answer.

Run:
```bash
git -C {repo_root} revert {commit-hash} --no-edit
```

This creates a new commit that undoes all changes from the original fix commit. It does not rewrite history. It works whether the original commit has been pushed or not — the user never needs to force-push.

**If the revert fails** (non-zero exit code): say "git revert failed: {error output}. The queue entry has NOT been updated. Common cause: the commit has already been reverted, or there are newer commits that conflict with the undo. Check with: `git -C {repo_root} log --oneline | head -10`" Stop.

After a successful revert, capture the revert commit hash:
```bash
git -C {repo_root} rev-parse HEAD
```

This is the new undo commit's hash — it will be different from the original fix commit hash.

---

## Step 6 — Update queue entry and close

Update the queue entry, status and note in one call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open \
  --note "Reverted: {revert-commit-hash}"
```

Do not read the entry and rebuild it yourself. A revert has happened since Step
1, the session may have run for hours, and another session may have written to
the same entry in between. `queue.js` reads it inside the lock, so the note is
appended to what is on disk now rather than to the copy you read at the start,
and the version you read cannot overwrite work you never saw.

If the command exits non-zero, say "The queue entry update failed. The revert
DID succeed (undo commit: {revert-hash}), and the queue file was not updated:
{what it printed}." A refusal usually means another session holds the lock, so
running it again is the remedy rather than editing the file by hand.

**Why this is a command and not a Write.** This step used to say the entry was
"already loaded, use what you have", which is an instruction to trust a copy
read before the revert ran. `apply-fix` carried the same phrasing and did drop
notes because of it. The wording was then corrected to say read it again, which
helped and did not fix it: reading in one tool call and writing in another still
leaves a gap for another session to write into. `queue.js` closes that by doing
both inside one process holding a lock, so there is no copy to go stale.

Show closing message:

```
Done. The fix for {target} has been reverted (undo commit: {revert-hash}).
Queue entry is back to Open.
The target file is restored to its pre-fix state.

Do you want to try a different fix, or leave this Open for later?
```

Wait for the user's response. If they say "Won't Fix" or "mark it closed",
closing it means saying what closing it meant, and the status on its own is
refused. Ask which it is, in one question:

> "Closing this as Won't Fix. Was the correction declined on purpose, or has it
> stopped being relevant?"

Make a private directory for it, once:

```bash
mktemp -d "${TMPDIR:-/tmp}/build-loop.XXXXXX"
```

Written out in full rather than as `mktemp -d -t build-loop`, which is BSD only:
GNU coreutils wants six `X` characters and exits 1 on the short form, so on Linux
the directory is never created and the hand-off below fails. Use the path it
prints, written as `{scratch}` here, and never a fixed name under `/tmp`, which
another session or another local user can replace between the Write and the call.

Write the answer to that directory, `wont_fix` for declined and `obsolete` for
no longer relevant, then hand both over in one call:

```json
{
  "outcome": "wont_fix",
  "at": "{ISO-8601 now}",
  "by": "user",
  "summary": "{why they closed it, in their words. The fix was reverted, so say what happened to it}"
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --list queue \
  --status "Won't Fix" --resolution {scratch}/resolution-{id}.json
```

If it exits non-zero, nothing was written and the entry is still `Open`. Report
what it printed, report that the entry is still open, and stop. Never report an
entry as closed when the call that would have closed it was refused. A refusal is
usually another session holding the lock, in which case running it again is the
whole remedy.

Both outcomes take `Won't Fix`, and `fix_applied` is refused against it: the
change was reverted, so nothing landed. See Resolution in SCHEMA.md.
