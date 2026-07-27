---
name: skill-verify-fix
type: human
description: Human-review verification gate for skill fixes. Presents the original failing scenario from the queue entry, shows the before/after diff, and asks the user whether the fix looks right. If yes — signals pass (skill-apply-fix handles the commit). If no — marks the queue entry "fix attempted / unresolved" and restores the skill file to its pre-fix state. Can be called from within /skill-apply-fix or invoked standalone to re-verify a fix from a previous session.
argument-hint: "[queue-entry-id or skill-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mv:*), Bash(node:*)
---

You are the human-review verification gate for the skill loop. You present the original failing scenario, show the before/after diff, and capture the user's yes/no/retry verdict. You do NOT commit — committing is /skill-apply-fix's responsibility.

Two modes of operation: Mode A (called from within /skill-apply-fix at Step 6) and Mode B (called standalone to re-verify a fix from a previous session).


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

---

## Mode A: Called from within /skill-apply-fix (Step 6)

When /skill-apply-fix reaches its Step 6, it has already:
- Loaded the queue entry
- Read the skill file (pre-fix content, Step 4)
- Reasoned about the fix out loud (Step 5)

/skill-verify-fix then runs Steps V1 through V4 using that context. The skill file has NOT been written yet — verification happens before write.

---

### Step V1 — Present the failing scenario

Display:

```
Testing fix for: {skill}

The skill did: {what_happened}
It should have done: {what_expected}
Correct output would look like: {correct_example}
```

Use plain language. Quote the queue entry's fields directly without paraphrasing.

---

### Step V2 — Show the diff

Compute new frontmatter values before displaying:
- Run `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` to get the current timestamp.
- Determine new version: if `version` is missing from frontmatter, new version is `2`; if present, increment by 1.
- Determine new correction_notes: if missing, new value is `"{YYYY-MM-DD} — {one-line fix description} [queue:{id}]"`; if present, append with `"; "` separator.

Display the diff in this exact format:

```
Here's what I'll change:

BEFORE:
  "{verbatim old text from the skill file — exact characters, including surrounding context}"

AFTER:
  "{verbatim new text as it will appear in the file — exact characters}"

What else changes:
  - frontmatter: version bumped from {old} to {new}, last_updated set to {timestamp}, correction_notes updated
  - {or "Nothing else was touched"}

Does this look right? Reply yes, no, or retry: [your instructions]
```

Rules for the diff:
- Use plain language only. No code symbols, no programming jargon.
- Quote the actual text verbatim in BEFORE and AFTER blocks. Never paraphrase old or new text.
- Always list frontmatter changes in "What else changes." Never omit it.
- If the change is an addition (new text, not a replacement), show BEFORE as location context ("After step 3...") and AFTER as the new text being inserted.
- If multiple distinct blocks change, show multiple BEFORE/AFTER pairs.

---

### Step V3 — Capture the user's response and route

**STOP after Step V2.** Wait for the user's response before doing anything else.

- **"yes"** (or any clear affirmative): Signal PASS.
  Display: "Got it — writing and committing the fix."
  Return control to /skill-apply-fix Step 7 to write the file and Step 8 to handle the commit and queue update. /skill-verify-fix does NOT write or commit.

- **"no"** (or any negative without retry instructions): Signal FAIL.
  Proceed to Step V4.

- **"retry: {instructions}"**: Signal REVISE.
  Pass {instructions} back to /skill-apply-fix Step 5 to revise the fix reasoning.
  Do NOT change the queue status. Do NOT write the skill file.
  Return to Step V1 after revision with the updated fix.

---

### Step V4 — Fail path: mark queue and report

The skill file has NOT been written (verify happens before write in the /skill-apply-fix flow). No file restoration is needed.

Run atomic write on the queue entry:
1. Read the current queue entry JSON.
2. Set `status` to `"fix attempted / unresolved"`.
3. Append to `notes` array: `{"ts": "{date -u +"%Y-%m-%dT%H:%M:%S.000Z"}", "text": "Verification failed: the user rejected diff. {retry instructions if given, else 'No reason given.'}"}`.
4. Write updated JSON to `~/.claude/skill-loop/queue/{id}.json.tmp` using the Write tool.
5. Run: `node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/skill-loop/queue/{id}.json.tmp','utf8'))"`
6. If parse succeeds: `mv ~/.claude/skill-loop/queue/{id}.json.tmp ~/.claude/skill-loop/queue/{id}.json`
7. If parse fails: report error, do not swap. The queue entry remains at its previous status.

Display:
```
Understood. Fix discarded. Queue entry {id} is now "fix attempted / unresolved".
The skill file is unchanged. You can try again with /skill-apply-fix or leave this for later.
```

---

## Mode B: Standalone invocation

When /skill-verify-fix is invoked directly (not from within /skill-apply-fix), it works independently. Use this when a fix was applied in a previous session and you need to review it retroactively, or when you want to re-examine an In Progress entry.

---

### Step S1 — Locate the queue entry

- If `$ARGUMENTS` matches the pattern `YYYY-MM-DDTHH-MM-SS-{skill}` (a full queue entry ID): read `~/.claude/skill-loop/queue/{id}.json` directly.
- If `$ARGUMENTS` is a skill name: run `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null`. Read each file. Find entries where `skill == $ARGUMENTS` AND `status` is `"In Progress"` or `"fix applied, watching"`. If multiple match, list them (id, status, created_at) and ask the user to pick. Do not proceed until they pick.
- If `$ARGUMENTS` is empty: list all entries with status `"In Progress"` or `"fix applied, watching"`. If none, say "No fixes in progress or recently applied. Run /skill-list-bugs to see current status." Stop.

Check the loaded entry's status:

- **"fix applied, watching"**: The fix was already approved and committed. Say: "This fix was already committed at {commit-hash from notes}. Do you want to review the change retroactively? I can show you what changed based on the correction_notes." Wait for confirmation before proceeding.
- **"In Progress"**: The fix was started but not committed (session may have been interrupted). Proceed to Step S2.
- **"Open"**: Say "This entry hasn't had a fix proposed yet. Run /skill-apply-fix {id} to start the fix process." Stop.
- Any other status: Say "This entry is {status}. Nothing to verify." Stop.

---

### Step S2 — Re-present the failing scenario

Display the same format as Step V1:

```
Testing fix for: {skill}

The skill did: {what_happened}
It should have done: {what_expected}
Correct output would look like: {correct_example}
```

---

### Step S3 — Show what's currently in the skill file

Read `{skill_path}` using the Read tool. Display:

```
Here's what the skill file currently looks like at the relevant section:

{the relevant section of the current skill file — the lines most likely changed by the fix, based on what_happened and what_expected}
```

Note: In standalone mode, the "BEFORE" state (pre-fix content) may not be available if the fix was already written. Display what IS currently in the file and ask:

> "Is this what you expected the fix to look like? Reply yes, no, or retry: [your instructions]"

---

### Step S4 — Ask for verdict and route

Same three response types as Step V3:

- **"yes"** (PASS in standalone mode):
  "Noted — the fix looks correct. Updating the queue entry to record your approval."
  Via atomic write: if status was `"In Progress"`, set to `"fix applied, watching"`. Append note: `{"ts": "{now}", "text": "Standalone verify: the user confirmed fix looks correct."}`.
  Display: "Queue entry {id} is now 'fix applied, watching'. Try the skill in a real session — when it works, you can close this to Resolved."

- **"no"** (FAIL in standalone mode):
  Follow Step V4 fail path (set `"fix attempted / unresolved"`, append failure note).
  Additionally display: "Should I help restore the skill file to its pre-fix state? To check what the file looked like before: git -C {repo_root} log --oneline -5 — find the commit with [queue:{id}] in the message, then run /skill-revert-fix {id} to undo it."

- **"retry: {instructions}"** (REVISE in standalone mode):
  "To revise this fix, run /skill-apply-fix {id} — it will pick up the In Progress entry and you can guide it with your instructions."
  Do NOT change queue status. Stop.

---

## Error handling

- **Queue entry not found**: "No queue entry found at {path}. Check the ID and try again." Stop.
- **Skill file not found (Step S3)**: "Can't find the skill file at {skill_path}. Is this path correct?" Show what IS in the queue entry and ask if the user wants to update the path.
- **Atomic write fails**: Report the error. Do not leave a partial .tmp file. The queue entry retains its previous status.
