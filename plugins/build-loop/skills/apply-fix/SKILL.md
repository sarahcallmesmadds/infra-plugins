---
name: apply-fix
type: human
description: Applies a correction from the bug queue to an actual target file. Reads the queue entry, checks DEPS.json for dependents, reasons about the surgical fix, shows a plain-language before/after diff, waits for the user's approval (yes / no / retry), then writes the fix, commits to the correct repo, and updates the queue entry status to "fix applied, watching" with the commit hash stored. Never writes without explicit approval.
argument-hint: "[queue-entry-id or target-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*), Bash(mv:*), Bash(rm:*), Bash(node:*), Bash(git:*), Bash(grep:*), Bash(wc:*)
---

You are applying a correction from the build loop bug queue to an actual target file. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA.md` and the dependency map is at `~/.claude/build-loop/DEPS.json`.

Eight steps. Do not reorder or skip steps. The diff gate (Step 6) must come before the write (Step 7). No silent writes. Ever.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

---

## Step 1 — Parse argument and locate queue entry

Read `$ARGUMENTS`:

- **If $ARGUMENTS matches the pattern `YYYY-MM-DDTHH-MM-SS-{target}`** (a full queue entry ID): read `~/.claude/build-loop/queue/{id}.json` directly using the Read tool.

- **If $ARGUMENTS is a target name or partial name** (e.g., `daily-brief`): run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file and filter where `target == $ARGUMENTS` AND `type == "primary"` (or type field missing) AND `status` is `"Open"` or `"In Progress"`. Sort by `created_at` descending:
  - If one match: use it.
  - If multiple matches: list them (id, created_at, what_happened summary) and ask the user to pick one. Do not proceed until they pick.
  - If no matches: say "No open queue entries found for '{$ARGUMENTS}'. Run /list-bugs to see what's available." Stop.

- **If $ARGUMENTS is empty**: list all `"Open"` primary entries (where `type == "primary"` and `status == "Open"`) and ask the user to pick one. Do not proceed until they pick.

---

## Step 2 — Read queue entry and guard on repo and status

Read the queue entry JSON using the Read tool (not Bash cat). Display:

> "Working on: {what_happened} ({target_kind}: {target}, repo: {repo})"

Then check:

- If `status` is `"Resolved"`, `"Won't Fix"`, or `"fix applied, watching"`: say "This entry is already {status}. Nothing to fix." Stop.
- If `status` is `"fix attempted / unresolved"`: say "This entry was previously attempted but not resolved. Proceeding with a new attempt." Continue.
- If `status` is `"In Progress"` from a previous session (no commit hash in notes): say "This entry is already marked In Progress from a previous session. The last session may have been interrupted before the fix was committed. Should I start fresh (re-read the target file and propose the fix again), or check whether the file was already written?" Wait for the user's answer:
  - "start fresh" → set status to "Open" via atomic write (see below), then continue from Step 1.
  - "check if written" → read the current target file and compare to the before/after description in the queue entry. If the fix appears already applied, show a summary and ask whether to commit it or revert.

**Repo guard:** If `repo == "unknown"`: say "This entry has repo: unknown. I can't commit without knowing which repo this belongs to. Check DEPS.json or update the queue entry's repo field manually, then try again." Stop. Do not change status.

**Set status to In Progress** via atomic write:
1. Write the updated JSON (with `status: "In Progress"`) to `~/.claude/build-loop/queue/{id}.json.tmp` using the Write tool.
2. Run: `node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/build-loop/queue/{id}.json.tmp','utf8'))"`
3. If parse succeeds: `mv ~/.claude/build-loop/queue/{id}.json.tmp ~/.claude/build-loop/queue/{id}.json`
4. If parse fails: report the error. Do not swap. Do not proceed.

---

## Step 3 — Check DEPS.json for dependents

Read `~/.claude/build-loop/DEPS.json` using the Read tool.

Compute the composite key `{repo}:{target}`, where `repo` is the root name
recorded on the queue entry.

Look up `DEPS.json.targets[key].dependents`:
- If the key is not in DEPS.json, or if the dependents array is empty: proceed silently — this is the common case.
- If dependents exist, show:

  > "Heads up: {target} has dependents that may be affected by this fix: {for each dependent: '{dep.target}' — {dep.reason}}. Proceed with the fix?"

  Wait for the user's explicit confirmation. If they say no: set status back to `"Open"` via atomic write (same 3-step pattern). Stop.

---

## Step 4 — Read the target file

Read the file at `{target_path}` in full using the Read tool. Read the entire file — not just the section you plan to change. You need the full content to:
- Understand the surrounding context
- Write the complete updated file back in Step 7 (full-file Write, not patch)
- Know the current frontmatter version and correction_notes values

If the file is not found: say "Can't find the target file at {target_path}. Is this path correct?" Stop.

---

## Step 5 — Reason about the fix out loud

Before showing the diff, explain your reasoning in plain language:

> "I'm going to change [specific text from the target file] to [new text] because [plain-language explanation derived from what_happened and what_expected from the queue entry]."

Identify the SURGICAL change: the specific paragraph, step, instruction, or example that is wrong. Only that block will change. Do not restructure surrounding content.

**If the queue entry is vague** — meaning `what_happened` is fewer than 20 characters, OR `correct_example` is an empty string — ask ONE clarifying question before proceeding:

> "The queue entry doesn't give me enough to work from specifically. Can you tell me: which part of it is wrong, and what should it say instead?"

Wait for the user's answer, incorporate it, then continue. Do not ask a second clarifying question — proceed with your best judgment after one round.

---

## Step 6 — Show the diff and wait for approval

**Only a file with YAML frontmatter gets version bookkeeping.** That means a `SKILL.md`, or a command file that already has a frontmatter block. A hook, a script, or any file whose first line is not `---` gets the surgical change and nothing else. Do not add a frontmatter block to a file that never had one, and do not write a version comment in its place. A JavaScript hook with three lines of YAML pasted on top of it is a broken hook.

When the file DOES have frontmatter, compute the new values first:
- Run `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` to get the current timestamp.
- Determine new version: if `version` is missing from frontmatter, new version is `2`; if present, increment by 1.
- Determine new correction_notes: if missing, new value is `"{YYYY-MM-DD} — {one-line fix description} [queue:{id}]"`; if present, append with `"; "` separator.

Display the diff in this exact format:

```
Fixing: {what_happened from queue entry — verbatim or close paraphrase}
Expected: {what_expected from queue entry — verbatim or close paraphrase}

Here's what I'll change:

BEFORE:
  "{verbatim old text from the target file}"

AFTER:
  "{verbatim new text as it will appear}"

What else changes:
  - frontmatter: version bumped from {old} to {new}, last_updated set to {timestamp}, correction_notes updated
  - {any other changes, or "Nothing else was touched"}

Does this look right? Reply yes, no, or retry: [your instructions]
```

For a file with no frontmatter, the "What else changes" line reads `Nothing else was touched. This file has no frontmatter, so there is no version to bump.`

Rules for the diff display:
- Use plain language only. No code symbols, no programming jargon.
- Quote the actual text verbatim in BEFORE and AFTER blocks. Do not paraphrase old or new text.
- Always list frontmatter changes in "What else changes." Never omit it.
- If the change is an addition (new text, not a replacement), show BEFORE as the location context ("After step 3...") and AFTER as the new text being inserted.
- If multiple distinct blocks change, show multiple BEFORE/AFTER pairs.

**STOP here.** Wait for the user's response before doing anything else.

Response handling:
- `"yes"` (or any clear affirmative) → proceed to Step 7.
- `"no"` (or any negative) → set status back to `"Open"` via atomic write. Ask: "Should I mark this Won't Fix or leave it Open for later?" Then stop. Do NOT write the target file.
- `"retry: {instructions}"` → revise the fix reasoning incorporating the user's instructions, return to Step 5 with the revised reasoning, show an updated diff, return to Step 6.

---

## Step 7 — Write the updated target file

Build the complete updated file content:
- Apply the surgical change (the specific before → after from Step 6).
- If, and only if, the file already opens with a YAML frontmatter block: add or update `version`, `last_updated`, and `correction_notes` immediately before the closing `---`. Do NOT reorder existing fields. Do NOT add blank lines between existing fields and the new ones. If the file has no frontmatter, skip this entirely and do not create one.
- All content outside the fixed section and frontmatter must be identical to what was read in Step 4.

Use the **Write tool** to write the full file to `{target_path}`. Do NOT use the Edit tool or incremental patches — Write is atomic at the OS level; Edit can fail partway through leaving the file in a partial state.

**If Write tool errors:**
> "The write failed: {error}. The target file is untouched — Write is all-or-nothing. Updating queue entry to 'fix attempted / unresolved'."

Run atomic write to set status to `"fix attempted / unresolved"` with note `{"ts": "{now}", "text": "Write tool failed: {error}"}`. Stop.

After successful write, verify the file exists and is not empty:
```bash
wc -l {target_path}
```
If the output is `0` or the file is missing, report an error immediately and do not proceed to commit.

---

## Step 8 — Commit and close the loop

Read the roots from `~/.claude/build-loop.config.json`. If that file does not
exist, use the three defaults from SCHEMA.md: `personal` at `~/.claude/skills`,
`hooks` at `~/.claude/hooks`, and `commands` at `~/.claude/commands`. A config
holding `skillRoots` and no `roots` is read as roots of kind `skill`.

Look up the entry's `repo` in `roots` to get that root's path. Then work out
what to stage, as the path of `target_path` relative to that root. Do NOT
assume it ends in `SKILL.md`, because the target may be a hook or a script:

```bash
git -C <root.path> add <target_path relative to root.path>
git -C <root.path> commit -m "fix({target}): {one-line summary of fix} [queue:{id}]"
```

If the root is not itself a git repository, `git -C` fails. Say so and stop,
rather than searching upwards for some other repository to commit into.

Commit message format rules:
- `{target}` — the name from the `target` field in the queue entry
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

**Surface dep-review entries** — run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file and find any entries where `parent_id == this entry's id` AND `status == "Open"`. If any exist:

> "These may be affected by this fix: {list each target name with its what_happened}. Do you want to review them now (run /apply-fix on each) or leave them Open in the queue?"

Wait for the user's answer. If they say "leave them", they stay Open. Do not auto-close dep-review entries.

**Show closing summary:**

```
Fix committed. Queue entry {id} is now "fix applied, watching".
Try it in a real session — when it works, run /list-bugs and update the entry to Resolved.
Commit: {hash} ({repo})
```
