---
name: skill-apply-fix
type: human
description: Applies a correction from the bug queue to an actual skill file. Reads the queue entry, checks DEPS.json for dependents, reasons about the surgical fix, shows a plain-language before/after diff, waits for the user's approval (yes / no / retry), then writes the fix, commits to the correct repo, and updates the queue entry status to "fix applied, watching" with the commit hash stored. Never writes without explicit approval.
argument-hint: "[queue-entry-id or skill-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*), Bash(mv:*), Bash(rm:*), Bash(node:*), Bash(git:*), Bash(grep:*), Bash(wc:*)
---

You are applying a correction from the skill loop bug queue to an actual skill file. The schema is at `reference/SCHEMA.md` in this plugin's directory and the dependency map is at `~/.claude/skill-loop/DEPS.json`.

Eight steps. Do not reorder or skip steps. The diff gate (Step 6) must come before the write (Step 7). No silent writes. Ever.

---

## Step 1 — Parse argument and locate queue entry

Read `$ARGUMENTS`:

- **If $ARGUMENTS matches the pattern `YYYY-MM-DDTHH-MM-SS-{skill}`** (a full queue entry ID): read `~/.claude/skill-loop/queue/{id}.json` directly using the Read tool.

- **If $ARGUMENTS is a skill name or partial name** (e.g., `daily-brief`): run `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null`. Read each file and filter where `skill == $ARGUMENTS` AND `type == "primary"` (or type field missing) AND `status` is `"Open"` or `"In Progress"`. Sort by `created_at` descending:
  - If one match: use it.
  - If multiple matches: list them (id, created_at, what_happened summary) and ask the user to pick one. Do not proceed until they pick.
  - If no matches: say "No open queue entries found for '{$ARGUMENTS}'. Run /skill-list-bugs to see what's available." Stop.

- **If $ARGUMENTS is empty**: list all `"Open"` primary entries (where `type == "primary"` and `status == "Open"`) and ask the user to pick one. Do not proceed until they pick.

---

## Step 2 — Read queue entry and guard on repo and status

Read the queue entry JSON using the Read tool (not Bash cat). Display:

> "Working on: {what_happened} (skill: {skill}, repo: {repo})"

Then check:

- If `status` is `"Resolved"`, `"Won't Fix"`, or `"fix applied, watching"`: say "This entry is already {status}. Nothing to fix." Stop.
- If `status` is `"fix attempted / unresolved"`: say "This entry was previously attempted but not resolved. Proceeding with a new attempt." Continue.
- If `status` is `"In Progress"` from a previous session (no commit hash in notes): say "This entry is already marked In Progress from a previous session. The last session may have been interrupted before the fix was committed. Should I start fresh (re-read the skill file and propose the fix again), or check whether the file was already written?" Wait for the user's answer:
  - "start fresh" → set status to "Open" via atomic write (see below), then continue from Step 1.
  - "check if written" → read the current skill file and compare to the before/after description in the queue entry. If the fix appears already applied, show a summary and ask whether to commit it or revert.

**Repo guard:** If `repo == "unknown"`: say "This entry has repo: unknown. I can't commit without knowing which repo this skill belongs to. Check DEPS.json or update the queue entry's repo field manually, then try again." Stop. Do not change status.

**Set status to In Progress** via atomic write:
1. Write the updated JSON (with `status: "In Progress"`) to `~/.claude/skill-loop/queue/{id}.json.tmp` using the Write tool.
2. Run: `node -e "JSON.parse(require('fs').readFileSync('~/.claude/skill-loop/queue/{id}.json.tmp','utf8'))"`
3. If parse succeeds: `mv ~/.claude/skill-loop/queue/{id}.json.tmp ~/.claude/skill-loop/queue/{id}.json`
4. If parse fails: report the error. Do not swap. Do not proceed.

---

## Step 3 — Check DEPS.json for dependents

Read `~/.claude/skill-loop/DEPS.json` using the Read tool.

Compute the composite key `{repo}:{skill}`, where `repo` is the root name
recorded on the queue entry.

Look up `DEPS.json.skills[key].dependents`:
- If the key is not in DEPS.json, or if the dependents array is empty: proceed silently — this is the common case.
- If dependents exist, show:

  > "Heads up: {skill} has dependent skills that may be affected by this fix: {for each dependent: '{dep.skill}' — {dep.reason}}. Proceed with the fix?"

  Wait for the user's explicit confirmation. If they say no: set status back to `"Open"` via atomic write (same 3-step pattern). Stop.

---

## Step 4 — Read the skill file

Read the file at `{skill_path}` in full using the Read tool. Read the entire file — not just the section you plan to change. You need the full content to:
- Understand the surrounding context
- Write the complete updated file back in Step 7 (full-file Write, not patch)
- Know the current frontmatter version and correction_notes values

If the file is not found: say "Can't find the skill file at {skill_path}. Is this path correct?" Stop.

---

## Step 5 — Reason about the fix out loud

Before showing the diff, explain your reasoning in plain language:

> "I'm going to change [specific text from the skill file] to [new text] because [plain-language explanation derived from what_happened and what_expected from the queue entry]."

Identify the SURGICAL change: the specific paragraph, step, instruction, or example that is wrong. Only that block will change. Do not restructure surrounding content.

**If the queue entry is vague** — meaning `what_happened` is fewer than 20 characters, OR `correct_example` is an empty string — ask ONE clarifying question before proceeding:

> "The queue entry doesn't give me enough to work from specifically. Can you tell me: which part of the skill is wrong, and what should it say instead?"

Wait for the user's answer, incorporate it, then continue. Do not ask a second clarifying question — proceed with your best judgment after one round.

---

## Step 6 — Show the diff and wait for approval

Compute new frontmatter values first:
- Run `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` to get the current timestamp.
- Determine new version: if `version` is missing from frontmatter, new version is `2`; if present, increment by 1.
- Determine new correction_notes: if missing, new value is `"{YYYY-MM-DD} — {one-line fix description} [queue:{id}]"`; if present, append with `"; "` separator.

Display the diff in this exact format:

```
Fixing: {what_happened from queue entry — verbatim or close paraphrase}
Expected: {what_expected from queue entry — verbatim or close paraphrase}

Here's what I'll change:

BEFORE:
  "{verbatim old text from the skill file}"

AFTER:
  "{verbatim new text as it will appear}"

What else changes:
  - frontmatter: version bumped from {old} to {new}, last_updated set to {timestamp}, correction_notes updated
  - {any other changes, or "Nothing else was touched"}

Does this look right? Reply yes, no, or retry: [your instructions]
```

Rules for the diff display:
- Use plain language only. No code symbols, no programming jargon.
- Quote the actual text verbatim in BEFORE and AFTER blocks. Do not paraphrase old or new text.
- Always list frontmatter changes in "What else changes." Never omit it.
- If the change is an addition (new text, not a replacement), show BEFORE as the location context ("After step 3...") and AFTER as the new text being inserted.
- If multiple distinct blocks change, show multiple BEFORE/AFTER pairs.

**STOP here.** Wait for the user's response before doing anything else.

Response handling:
- `"yes"` (or any clear affirmative) → proceed to Step 7.
- `"no"` (or any negative) → set status back to `"Open"` via atomic write. Ask: "Should I mark this Won't Fix or leave it Open for later?" Then stop. Do NOT write the skill file.
- `"retry: {instructions}"` → revise the fix reasoning incorporating the user's instructions, return to Step 5 with the revised reasoning, show an updated diff, return to Step 6.

---

## Step 7 — Write the updated skill file

Build the complete updated file content:
- Apply the surgical change (the specific before → after from Step 6).
- Update the frontmatter: add or update `version`, `last_updated`, and `correction_notes` immediately before the closing `---` of the frontmatter block. Do NOT reorder existing fields. Do NOT add blank lines between existing fields and the new ones.
- All content outside the fixed section and frontmatter must be identical to what was read in Step 4.

Use the **Write tool** to write the full file to `{skill_path}`. Do NOT use the Edit tool or incremental patches — Write is atomic at the OS level; Edit can fail partway through leaving the file in a partial state.

**If Write tool errors:**
> "The write failed: {error}. The skill file is untouched — Write is all-or-nothing. Updating queue entry to 'fix attempted / unresolved'."

Run atomic write to set status to `"fix attempted / unresolved"` with note `{"ts": "{now}", "text": "Write tool failed: {error}"}`. Stop.

After successful write, verify the file exists and is not empty:
```bash
wc -l {skill_path}
```
If the output is `0` or the file is missing, report an error immediately and do not proceed to commit.

---

## Step 8 — Commit and close the loop

Run the commit command for the correct repo. Derive `{skill-dir-name}` from `skill_path` — it is the directory name immediately containing SKILL.md.

Look up the entry's `repo` in `skillRoots` to get that root's path, and commit
the SKILL.md relative to it:

```bash
git -C <root.path> add {skill-dir-name}/SKILL.md
git -C <root.path> commit -m "fix({skill}): {one-line summary of fix} [queue:{id}]"
```

If the root is not itself a git repository, `git -C` fails. Say so and stop,
rather than searching upwards for some other repository to commit into.

Commit message format rules:
- `{skill}` — the skill directory name (matches the `skill` field in the queue entry)
- `{one-line summary}` — plain English, present tense, max 60 characters
- `[queue:{id}]` — full queue entry id (e.g., `queue:2026-04-23T13-29-20-daily-brief`)
- Never git push as part of this skill. Pushing is a separate deliberate action.

**If git commit errors:**
> "The fix is written to disk but the git commit failed: {error}. Should I try the commit again, or revert the file to its original state?"

Do NOT change the queue entry status until the user's response. Do NOT assume the file should stay — it's written without a commit and is in a limbo state.

**Capture the commit hash:**
```bash
git -C {repo_root} rev-parse HEAD
```
Where `{repo_root}` is the `path` of the root named by the entry's `repo` field.

**Update the queue entry** — run atomic write to set status to `"fix applied, watching"` and append note:
```json
{"ts": "{ISO-8601 now}", "text": "Committed: {commit-hash} to {repo}"}
```

**Surface dep-review entries** — run `ls ~/.claude/skill-loop/queue/*.json 2>/dev/null`. Read each file and find any entries where `parent_id == this entry's id` AND `status == "Open"`. If any exist:

> "These dependent skills may be affected by this fix: {list each skill name with its what_happened}. Do you want to review them now (run /skill-apply-fix on each) or leave them Open in the queue?"

Wait for the user's answer. If they say "leave them", they stay Open. Do not auto-close dep-review entries.

**Show closing summary:**

```
Fix committed. Queue entry {id} is now "fix applied, watching".
Try the skill in a real session — when it works, run /skill-list-bugs and update the entry to Resolved.
Commit: {hash} ({repo})
```
