---
name: skill-flag-issue
type: human
description: Logs a skill correction to the bug queue at ~/.claude/skill-loop/queue/. Use when the user says "that was wrong", "it should have", "next time", "don't do that", corrects any named skill by name, says the output of a skill was not what they wanted, or explicitly invokes /skill-flag-issue. Reads the current session context to pre-fill skill name, what happened, what was expected, and a correct example; then shows a draft to the user and waits for confirmation before writing. Dedupes against queue entries from the last 10 minutes. After writing a primary entry, reads DEPS.json and auto-adds one dep-review queue entry per dependent listed in the map — so skills likely affected by the fix surface for review without the user having to remember.
argument-hint: "[optional skill name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*)
---

You are logging a correction to the skill loop bug queue at `~/.claude/skill-loop/queue/`. The schema is at `reference/SCHEMA.md` in this plugin's directory — read it if you haven't already in this session.

## Session context guard

If there is no session history (brand new session, /skill-flag-issue run immediately with no prior exchanges), open with:

> "No recent context to pull from — what skill is this about, and what went wrong?"

Then proceed to Step 1 using whatever the user tells you.

---

## Step 1 — Identify what's being corrected

Look back at the last 3–5 exchanges in the current session. Extract four pieces of information:

**1. skill** — the skill name being corrected. Matching rules (apply in order):

- If `$ARGUMENTS` is non-empty, use it as the skill name.
- If the user's last message names a skill explicitly (e.g. "the daily-brief skill did X"), use that name.
- If a slash command was recently invoked, use that command's name.
- Otherwise, make a best guess from context and ask: "Which skill is this about? My best guess is `{guess}` — is that right? If not, what skill?"

**2. skill_path** — the absolute path to the skill's SKILL.md. Resolve using this algorithm:

1. Read the roots from `~/.claude/skill-loop.config.json`. If that file does not exist, use the single default root `{ "name": "personal", "path": "~/.claude/skills" }`.
2. For each root in order, run `ls <root.path>/{skill}/SKILL.md`, then `ls <root.path>/{skill}/skill/SKILL.md`. On the first hit, use that path and set `repo` to that root's `name`.
3. If no root has it, ask: "I can't find a SKILL.md for `{skill}` in any configured root. Is this the right skill name, or is it somewhere else?" Record whatever path they confirm. If it is outside every configured root, set `repo: "unknown"`. Do NOT guess a path.

**3. what_happened** — the behavior the user flagged as wrong. Summarize in one or two sentences in plain language. Quote the user's own words if they are short enough.

**4. what_expected** — what the user said the skill should have done. If they stated it explicitly, quote them. If not, ask ONE clarifying question:

> "Got it — what should it have done instead? A rough description is fine."

**5. correct_example** — a concrete example of correct output. If the user gave one, use it verbatim. If not, ask ONE question:

> "Can you give me a rough example of what the right output would have looked like? One line is fine."

Rule: ask at most ONE clarifying question per turn. If the user's last message already answered a question, do not re-ask it.

---

## Step 2 — Show the draft and ask for confirmation

Display the draft in this exact format before writing anything:

```
I'll log this correction to the queue:

Skill: {skill}  (path: {skill_path}, repo: {repo})
What happened: {what_happened}
What expected: {what_expected}
Correct example: {correct_example}

Write it? (y / edit / skip)
```

On the user's response:

- `y`, `yes`, `sure`, `go`, or any clear affirmative → proceed to Step 3.
- `edit` or any change request → update the draft with them edits, re-show, ask again.
- `skip`, `no`, `nope`, or any negative → respond "Skipped — nothing logged." and stop. Do not write anything.

**No silent writes. Ever.**

---

## Step 3 — Dedup check

Before writing, check for a duplicate:

1. Compute `dedup_key`:
   - Take the first 40 characters of `what_happened`.
   - Lowercase, replace all non-alphanumeric characters with `-`, strip leading/trailing dashes.
   - Result: `dedup_key = "{skill}::{slug}"`

2. Run `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null`.
   For each file found, read it and check:
   - Does its `dedup_key` equal the new one?
   - Was its `created_at` within the last 10 minutes?
   If both are true, a duplicate exists.

3. If a duplicate is found:
   > "I already have a similar entry from {when}: `{existing_filename}`. Skip (dedupe) or write anyway?"
   Default if no response: skip.

4. If no duplicate, continue to Step 4.

---

## Step 4 — Write the JSON file

Compose the entry object. All fields required per SCHEMA.md v2:

```
$schema_version: 2
id:             {YYYY-MM-DDTHH-MM-SS}-{slug(skill)}    ← filename stem, must match exactly
created_at:     current UTC time in ISO-8601 (e.g. 2026-04-23T14:30:00.000Z)
status:         "Open"
type:           "primary"
parent_id:      null
skill:          {skill}
skill_path:     {skill_path}
repo:           {repo}
session_id:     current Claude Code session ID (fill "" if not available)
session_cwd:    current working directory of this session (fill "" if not available)
what_happened:  {what_happened}
what_expected:  {what_expected}
correct_example: {correct_example}
source:         "slash-capture"
urgency_hint:   "normal"  (set to "high" only if the user explicitly says it is urgent)
dedup_key:      {dedup_key}
notes:          []
resolution:     null
```

Then:

1. Get the current UTC time: `date -u +"%Y-%m-%dT%H-%M-%S"` for the filename, `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` for `created_at`.
2. Build the filename: `{YYYY-MM-DDTHH-MM-SS}-{slug(skill)}.json`
   The `id` field MUST equal the filename stem (everything before `.json`).
3. Ensure the queue directory exists: `mkdir -p ~/.claude/skill-loop/queue`
4. Use the Write tool (expand `~` to the absolute home path first, the tool does not do it for you) to write the JSON file to `~/.claude/skill-loop/queue/{filename}`.
   Pretty-print with 2-space indentation (human-readable).
5. Count open items: `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null | wc -l`
6. Do NOT confirm here — proceed directly to Step 4b (dep-review flagging). Confirmation happens in Step 4c after flagging completes.

---

## Step 4b — Auto-add dep-review entries for dependents

After the primary entry is written in Step 4, flag any skills the map says are dependents. This runs BEFORE the final confirmation message — the confirmation in Step 4 becomes a later step below (see Step 4c).

### Read DEPS.json

Read `~/.claude/skill-loop/DEPS.json` using the Read tool.

**If the read fails** (file missing, permission denied, or the content is not valid JSON):
> Print: "⚠ DEPS.json missing or unreadable — skipping dep-review flagging. Run /skill-audit-deps to fix."
> Jump to Step 4c with `dep_reviews_written: 0`. Never block the primary write.

### Look up the captured skill's entry

Build the composite key: `{repo}:{skill}` where both values come from the primary entry you just wrote.

**If the key is NOT in `DEPS.json.skills`:**
> Print: "⚠ {skill} not in DEPS.json — skipping dep-review flagging. Run /skill-audit-deps to add it."
> Jump to Step 4c with `dep_reviews_written: 0`.

**If the key IS present**, look at `DEPS.json.skills[key].dependents`. If the array is empty, jump to Step 4c with `dep_reviews_written: 0` — there's nothing to flag, which is the common case for most skills.

### For each dependent, write a dep-review entry

For every `{ skill: X, repo: R, reason: Y, confidence?: low }` in the dependents array:

1. **Compute urgency_hint** (Claude's judgment — this is NOT a rule engine):
   - Tight coupling signals: Y mentions "explicit call", "shared DB ID", or "schema reference" — OR the edge confidence is `"high"`.
   - Loose coupling signals: Y describes semantic/lens/output-format similarity — OR the edge confidence is `"low"`.
   - Tight → urgency_hint = same as the primary entry's urgency_hint
   - Loose → urgency_hint = one level lower: high→normal, normal→low, low stays low

2. **Compute the dep-review dedup key**: `dep-review::{X}::{primary entry's id}`.

3. **Dedup check**: run `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null`. Read each file. If any existing entry has the same `dedup_key`, skip this dependent and continue to the next. (Unlike primary dedup, dep-review dedup is NOT time-windowed — the same parent_id + dependent pair is one logical review, forever.)

4. **Build the dep-review entry** (all fields per SCHEMA.md v2):
   ```
   $schema_version:  2
   id:               {primary entry's timestamp}-dep-review-{slug(X)}
   created_at:       {same as primary entry's created_at}
   status:           "Open"
   type:             "dep-review"
   parent_id:        {primary entry's id}
   skill:            {X}
   skill_path:       {DEPS.json entry's path value}
   repo:             {R}
   session_id:       {same as primary entry's session_id}
   session_cwd:      {same as primary entry's session_cwd}
   what_happened:    "Review: {X} may be affected by fix to {primary skill}. Reason: {Y}"
   what_expected:    "(not applicable — this is a dependency review)"
   correct_example:  "(not applicable)"
   source:           "dep-review-auto"
   urgency_hint:     {computed above}
   dedup_key:        dep-review::{X}::{primary entry's id}
   notes:            []
   resolution:       null
   ```

5. **Write the entry**. Filename: `{primary timestamp}-dep-review-{slug(X)}.json`. Use the Write tool. Pretty-print with 2-space indentation.

6. Increment `dep_reviews_written`.

### Step 4c — Confirmation message

The confirmation message from the current Step 4 is REPLACED. Instead of "Logged to {filename}. Queue now has N open items.", use this rule:

- If `dep_reviews_written == 0`:
  > "Logged to `{filename}`. Queue now has {N} open items."
  (Same as Phase 1 — no change.)

- If `dep_reviews_written > 0`:
  > "Logged to `{filename}`. Queue now has {N} open items."
  > "Also flagged {dep_reviews_written} dep-review {entr(y|ies)}: {comma-separated skill names}."

Pluralization: use "entry" when `dep_reviews_written == 1`, "entries" otherwise.

### Failure handling inside Step 4b

If ANY dep-review write fails (Write tool error, tempfile issue), continue with the remaining dependents and note the failure in the confirmation:
> "Flagged {K} of {total} dep-reviews — {total - K} failed to write. Check queue directory manually."

The primary entry write is never rolled back because a dep-review write failed. The primary is the source of truth; dep-reviews are convenience.

---

## Failure handling

- If the Write tool fails for any reason, tell the user exactly what failed. Do NOT retry silently. They may want to fix the root cause before retrying.
- If the user declines to answer a clarifying question, record the missing field as `"(not provided)"` and still write the entry — a partial entry is better than a lost correction. Flag this in the confirmation message:
  > "Logged with missing {field} — you can edit the file later at `{path}`."
- If `repo` ends up as `"unknown"`, add a note in the `notes` array:
  `{"ts": "{created_at}", "text": "repo unknown — skill_path {skill_path} is outside both known roots. Resolve before Phase 3 can apply the fix."}`
- If DEPS.json cannot be read in Step 4b, NEVER block the primary confirmation. The primary entry is the source of truth. Dep-review is best-effort.
