---
name: revert-fix
type: human
description: Rolls back a committed fix. Reads the queue entry to find the commit hash, runs git revert in the correct repo (creates a new undo commit — does not delete or modify the original commit), resets the queue entry status back to Open, and stores the revert commit hash in notes. Works whether the commit has been pushed or not. The user does not need to know any git commands.
argument-hint: "[queue-entry-id or target-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mv:*), Bash(node:*), Bash(git:*)
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

---

## Step 2 — Guard on status

Read the queue entry JSON using the Read tool.

- If `status` is NOT `"fix applied, watching"`: say "This entry has status '{status}', not 'fix applied, watching'. /revert-fix only reverts committed fixes. If you want to discard an in-progress attempt, use /apply-fix and reply 'no' to the diff." Stop.

- If `repo == "unknown"`: say "This entry has repo: unknown. I can't determine which git repo to revert in — check the queue entry and resolve the repo field first." Stop.

---

## Step 3 — Find the commit hash

Scan the entry's `notes[]` array for an object where `text` starts with `"Committed:"`.

Extract the hash from that string. The format is:
```
"Committed: {hash} to {repo}"
```
Example: `"Committed: abc1234 to personal"` → hash is `abc1234`.

- If no `Committed:` note is found in `notes[]`: say "I can't find a commit hash in this queue entry's notes. The commit hash is normally stored by /apply-fix after committing. You may need to find the commit manually with: `git -C {repo_root} log --oneline | head -10`" Stop.

---

## Step 4 — Confirm before reverting

**Before running any git command, show the user exactly what will happen and wait for them answer.**

Show this message:

```
I'll run: git revert {hash} --no-edit in {repo_root}

This creates a NEW undo commit — it does not delete or modify the original commit.
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

Via atomic write, update the queue entry:

1. Read the current queue entry JSON (already loaded — use what you have).
2. Set `status` to `"Open"`.
3. Append to `notes[]`:
   ```json
   {"ts": "{current UTC time}", "text": "Reverted: {revert-commit-hash}"}
   ```
   Get current UTC time with: `date -u +"%Y-%m-%dT%H:%M:%S.000Z"`

4. Atomic write sequence:
   - Write the updated JSON to `~/.claude/build-loop/queue/{id}.json.tmp` using the Write tool.
   - Run: `node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/build-loop/queue/{id}.json.tmp','utf8'))"`
   - If parse succeeds: `mv ~/.claude/build-loop/queue/{id}.json.tmp ~/.claude/build-loop/queue/{id}.json`
   - If parse fails: report error, do not swap. Say "The queue entry update failed — the revert DID succeed (undo commit: {revert-hash}), but the queue file was not updated. Edit it manually at ~/.claude/build-loop/queue/{id}.json"

Show closing message:

```
Done. The fix for {target} has been reverted (undo commit: {revert-hash}).
Queue entry is back to Open.
The target file is restored to its pre-fix state.

Do you want to try a different fix, or leave this Open for later?
```

Wait for the user's response. If they say "Won't Fix" or "mark it closed": set `status` to `"Won't Fix"` via atomic write using the same pattern above.
