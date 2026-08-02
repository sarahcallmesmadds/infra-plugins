---
name: apply-fix
type: human
description: Applies a correction from the bug queue to an actual target file. Reads the queue entry, checks DEPS.json for dependents, reasons about the surgical fix, shows a plain-language before/after diff, waits for the user's approval (yes / no / retry), then writes the fix, commits to the correct repo, and updates the queue entry status to "fix applied, watching" with the commit hash stored. Never writes without explicit approval.
argument-hint: "[queue-entry-id or target-name]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mktemp:*), Bash(mkdir:*), Bash(mv:*), Bash(rm:*), Bash(node:*), Bash(git:*), Bash(grep:*), Bash(wc:*)
---

You are applying a correction from the build loop bug queue to an actual target file. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA.md` and the dependency map is at `~/.claude/build-loop/DEPS.json`.

Eight steps. Do not reorder or skip steps. The diff gate (Step 6) must come before the write (Step 7). No silent writes. Ever.


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

## Step 1 — Parse argument and locate queue entry

Read `$ARGUMENTS`:

- **If $ARGUMENTS matches the pattern `YYYY-MM-DDTHH-MM-SS-{target}`** (a full queue entry ID): read `~/.claude/build-loop/queue/{id}.json` directly using the Read tool.

- **If $ARGUMENTS is a target name or partial name** (e.g., `daily-brief`): run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file and filter where the entry name equals `$ARGUMENTS`, reading `target` and falling back to `skill` when `target` is absent (per SCHEMA.md, entries written before v5 carry `skill`; matching on `target` alone makes every older entry invisible) AND `type == "primary"` (or type field missing) AND `status` is `"Open"` or `"In Progress"`. Sort by `created_at` descending:
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
- If `status` is `"fix attempted / unresolved"`: that status was retired in 0.3.1 and nothing writes it any more, so this entry predates the change. Treat it as `"Open"`, say "This entry was attempted in an earlier version and left unresolved. Proceeding with a new attempt." Continue. Read this even though nothing produces it: an entry written before 0.3.1 is otherwise stuck, because no other branch here handles the value.
- If `status` is `"In Progress"` from a previous session (no commit hash in notes): say "This entry is already marked In Progress from a previous session. The last session may have been interrupted before the fix was committed. Should I start fresh (re-read the target file and propose the fix again), or check whether the file was already written?" Wait for the user's answer:
  - "start fresh" → set status to "Open" with `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open`, then continue from Step 1.
  - "check if written" → read the current target file and compare to the before/after description in the queue entry. If the fix appears already applied, show a summary and ask whether to commit it or revert.

**Repo guard:** If `repo == "unknown"`: say "This entry has repo: unknown. I can't commit without knowing which repo this belongs to. Check DEPS.json or update the queue entry's repo field manually, then try again." Stop. Do not change status.

**Set status to In Progress:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status "In Progress"
```

**Never edit a queue entry with the Write tool.** `queue.js` reads the entry,
changes what you asked for, and writes it back inside one process holding one
lock. Doing it by hand means reading the file in one tool call and writing it in
another, and in between that gap another session can write the same entry. Its
change is then gone, with no error and nothing to notice, because your write
carried a copy of the entry from before it existed. Three sessions in this
directory at once is normal, so that gap is not hypothetical.

It is also what protects `notes`. The array is read at the moment something has
gone wrong, which is when it is least affordable to lose, and `--note` appends to
whatever is on disk rather than to whatever you remember reading.

---

## Step 3 — Check DEPS.json for dependents

Read `~/.claude/build-loop/DEPS.json` using the Read tool.

Compute the composite key per the Composite Key Rule in SCHEMA-DEPS.md, where
`repo` is the root name recorded on the queue entry.

- Normally `{repo}:{target}`.
- **When the owning root is of kind `plugin-repo`, it is `{repo}:{plugin}/{target}`.**
  Read the plugin segment out of `target_path`, the directory under `plugins/`,
  never out of the target name. Three plugins here ship a `cli`.

**If the exact key is absent, work down this list before concluding there are no
dependents.**

**a. The bare key, `{repo}:{target}`.** A map written before v3 stored
plugin-repo entries under a plain name, `plugins:hook-io` rather than
`plugins:guardrails/hook-io`. Step b cannot reach those, since `hook-io` does not
end with `/hook-io`. Without this step, installing this version makes every
pre-v3 map go quiet, and the warning about what a fix might break disappears at
the exact moment it matters.

On a match here, show this alongside the dependents:

> `Note: DEPS.json predates v3, so this matched on name alone. If more than one plugin has a {target}, the entry may describe a different one. Run /audit-deps to rebuild the keys.`

**b. A suffix match on `/{target}`.** Exactly one match, use it. More than one,
do not choose: say which keys matched and that the name is ambiguous, and treat
it as a warning rather than silence.

**c. Nothing matched.** There is genuinely no entry.

A lookup that finds nothing and a target with no dependents both end in silence
here, and only one of them means it is safe to proceed.

Read the map from `DEPS.json.targets`. **If that is absent and `DEPS.json.skills` is present, use `skills` instead**, treating each entry's `skill` field as `target`. That is a v1 map, per SCHEMA-DEPS.md. Reading only `targets` against a v1 map reports every dependency as absent, so the warning below never fires and a fix lands with no heads-up about what it might break.

Look up `dependents` for the key. Each edge carries a bare `target` and, inside a
`plugin-repo` root, a separate `plugin` field. Show `{plugin}/{target}` when
naming one to the user, since three plugins here ship a `cli` and the bare name
would not say which is at risk. Keep the two fields apart everywhere else.

- If the key is not in DEPS.json, or if the dependents array is empty: proceed silently — this is the common case.
- If dependents exist, show:

  > "Heads up: {target} has dependents that may be affected by this fix: {for each dependent: '{dep.plugin}/{dep.target}' when dep.plugin is present, otherwise '{dep.target}', {dep.reason}}. Proceed with the fix?"

  The plugin belongs in this line. `cli`, `config`, `hook-io` and `patterns`
  each exist in more than one plugin here, so a bare name in a warning about
  what a fix might break is the one place ambiguity costs something.

  Wait for the user's explicit confirmation. If they say no: set status back with `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open`. Stop.

---

## Step 4 — Read the target file

Read the file at `{target_path}` in full using the Read tool. Read the entire file — not just the section you plan to change. You need the full content to:
- Understand the surrounding context
- Write the complete updated file back in Step 7 (full-file Write, not patch)

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

**Change only what the fix requires.** Frontmatter is not touched, and no
`version`, `last_updated` or `correction_notes` field is added or updated.

This skill used to write those three fields into any target that had a
frontmatter block. They came off on 2026-07-28 because git records the same
thing and cannot drift, while the fields could and did. `whats-breaking`
reached `version: 4`, meaning three corrections, carrying a `correction_notes`
that mentioned one of them. A field that quietly stops accumulating is worse
than no field, because it still reads as a complete record.

The commit is the record. Step 8 puts the queue id in the commit message, so
`git log --grep` finds a fix from its bug report, and the diff shows what
changed rather than a sentence summarizing it.

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
  - {any other changes, or "Nothing else was touched"}

Does this look right? Reply yes, no, or retry: [your instructions]
```

Rules for the diff display:
- Use plain language only. No code symbols, no programming jargon.
- Quote the actual text verbatim in BEFORE and AFTER blocks. Do not paraphrase old or new text.
- "What else changes" lists everything outside the BEFORE and AFTER blocks. Where there is nothing, say `Nothing else was touched.` rather than dropping the line, so a silent extra edit cannot hide in an omission.
- If the change is an addition (new text, not a replacement), show BEFORE as the location context ("After step 3...") and AFTER as the new text being inserted.
- If multiple distinct blocks change, show multiple BEFORE/AFTER pairs.

**STOP here.** Wait for the user's response before doing anything else.

Response handling:
- `"yes"` (or any clear affirmative) → proceed to Step 7.
- `"no"` (or any negative) → set status back with `node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open`. Ask: "Should I mark this Won't Fix or leave it Open for later?" Then stop. Do NOT write the target file.
- `"retry: {instructions}"` → revise the fix reasoning incorporating the user's instructions, return to Step 5 with the revised reasoning, show an updated diff, return to Step 6.

---

## Step 7 — Write the updated target file

Build the complete updated file content:
- Apply the surgical change (the specific before → after from Step 6).
- All content outside the fixed section must be identical to what was read in Step 4, frontmatter included.

Use the **Write tool** to write the full file to `{target_path}`. Do NOT use the Edit tool or incremental patches — Write is atomic at the OS level; Edit can fail partway through leaving the file in a partial state.

**If Write tool errors:**
> "The write failed: {error}. The target file is untouched, since Write is all-or-nothing. The queue entry stays Open, with a note recording the failure."

Write the note to a scratch file, reading:

> Write tool failed, target file untouched: {error}

Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open --note-file {scratch}/note-{id}.txt
```

`--note-file` rather than `--note` because `{error}` is free text from a tool.
A double quote, a backtick, a `$(...)` or a newline in it would end or extend
the shell argument, and this runs where `Bash(node:*)` is allowed. Use
`--note-file` for anything interpolated from an error, from something the user
typed, or from a file. `--note` is for fixed strings and for values with a known
shape, such as a commit hash. Stop.

The entry stays Open for the same reason a rejected verification does: a fix that
did not land is an open bug, and a status no view lists is a bug you cannot find.

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

**Update the queue entry**, status and note in one call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} \
  --status "fix applied, watching" \
  --note "Committed: {commit-hash} to {repo}"
```

One call rather than two, because everything asked for in one call lands in one
write. Split across two, another session can write between them and leave the
status changed with the note explaining it missing.

The entry has almost certainly changed since Step 2 and may carry notes this
session never saw. That is handled: the read happens inside the lock, so the
note is appended to what is on disk now rather than to the copy you read
earlier. Do not read the entry and rebuild it yourself.

If the command exits non-zero, say "The fix is committed ({commit-hash}), and
the queue entry was not updated: {what it printed}." Do not retry silently, and
do not edit the file by hand to get around it. A refusal here usually means
another session holds the lock, and the retry is the whole fix.

Notes are the audit trail on a queue entry: a repo unknown warning, the reason a
dep-review was raised, a record that an earlier attempt was abandoned. They are
read at exactly the moment something has gone wrong, which is when they are
least affordable to lose. An entry that arrives here with one note leaves with
two, the original plus the Committed note. `queue.js` prints the count before and
after, so a lost note is visible rather than silent.

**Surface dep-review entries** — run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file and find any entries where `parent_id == this entry's id` AND `status == "Open"`. If any exist:

> "These may be affected by this fix: {list each target name with its what_happened}. Do you want to review them now (run /apply-fix on each) or leave them Open in the queue?"

Wait for the user's answer. If they say "leave them", they stay Open. Do not auto-close dep-review entries.

**Show closing summary:**

```
Fix committed. Queue entry {id} is now "fix applied, watching".
Try it in a real session. When it works, run /list-bugs and update the entry to Resolved.
Commit: {hash} ({repo})
```
