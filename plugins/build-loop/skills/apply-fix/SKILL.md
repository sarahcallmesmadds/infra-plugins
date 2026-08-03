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

**Root guard.** A root that is still named in the config may no longer be on
disk, which reads the same from here as a repo that was never configured. Ask
about the one this entry names, not about the roots in general:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check --name {repo}
```

Exit 0 means that root exists, and Step 8 can commit into it. Anything else
means it cannot: relay what the check printed and stop. Do not change status.

**`--name`, rather than a bare `check`.** The question here is about one root.
A bare check answers about all of them, and "everything taken together is fine"
is not an answer about the one you are about to write into. That gap is not
hypothetical: it is how a missing default reached Step 8 as an all-clear.

**This check belongs here rather than at Step 8, where the roots are read.** By
Step 8 the target file is already written, so a root that turns out to be absent
leaves the fix on disk with nothing able to commit it, and an entry that says the
work is unfinished. That is the same limbo `2026-07-30T20-05-20-apply-fix-no-git-repo`
describes for a target outside a git repository, and it is avoidable here for
free: nothing has been written yet at Step 2, and `repo` is known the moment the
entry is read.

**Set status to In Progress:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status "In Progress"
```

**If it exits non-zero, stop.** Report what it printed and do not go on to Step
3. The old sequence ended "if parse fails: report the error, do not swap, do not
proceed", and that branch was dropped when the write moved into `queue.js`. It
is more reachable now, not less: `acquire` gives up after five seconds when
another session is holding the lock, which is an ordinary thing to happen rather
than a disk error. Proceeding anyway means applying and committing a fix while
the entry still says nobody has started it, so a second session picks up the
same bug.

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

**Resolve `{target_path}` to a file first.** The Read tool cannot read a directory,
and a `plugin`-kind entry may record one. `/flag-issue` requires a plugin to be
recorded as `plugins/{target}/.claude-plugin/plugin.json`, so an entry holding the
bare directory predates that rule or was written by hand.

**Every stop in this step must reopen the entry first.** Step 2 set it to
`In Progress`, and stopping without restoring that leaves the entry claiming a session
is working on it when none is. It then vanishes from the open list and the next run
meets the `In Progress` prompt instead of a clean entry. That is the same limbo Step 8
below exists to remove, so it cannot be reintroduced here. Every other early exit in
this skill restores it, at Step 3, Step 6 and Step 7.

Before any of the stops below:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} --status Open --note-file {scratch}/note-{id}.txt
```

with the note recording why, for example `Target path could not be resolved to a file:
{target_path} is a directory`. If that call exits non-zero, say "The entry was not
reopened: {what it printed}" and name the status it is stuck at, so the limbo is at
least visible. Do not retry silently.

- If it is a **file**, read it and carry on. No status change.
- If it is a **directory** and `target_kind` is `plugin`, the fix cannot be a
  full-file write against a directory. Reopen the entry, then say which file it should
  have held, rather than guessing which file inside the plugin the fix belongs in:

  > "Can't apply a fix to {target_path}, which is a directory. A plugin entry should point at .claude-plugin/plugin.json, and a fix that belongs in one file inside the plugin needs an entry naming that file. Fix the entry's path, or run /audit-deps to rebuild it. The entry is back to Open."

- If it is a **directory** and `target_kind` is anything else, reopen and stop the same way. There is no convention to guess with.

`/verify-fix` Step S3 also resolves the path before reading, but it substitutes
`.claude-plugin/plugin.json` for a `plugin`-kind directory and carries on, because it
only reads. Here the fix is a full-file write, which a directory cannot take, so this
stops instead. The two differ deliberately.

Read the file at `{target_path}` in full using the Read tool. Read the entire file — not just the section you plan to change. You need the full content to:
- Understand the surrounding context
- Write the complete updated file back in Step 7 (full-file Write, not patch)

If the path resolves to nothing: reopen the entry as above, then say "Can't find the target file at {target_path}. Is this path correct? The entry is back to Open." Use that only for a path that is absent, not for one that exists and is a directory, because asking whether a correct path is correct sends the reader to check the one thing that is not wrong.

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

**If that exits non-zero too, say both things.** The target file is untouched
and the entry could not be returned to Open, so it is parked wherever the last
status change left it and someone has to look. Two failures reported is
recoverable; the second one swallowed is an entry nobody knows is stuck.

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

Step 2 asked about this entry's `repo` by name, before anything was written, so
by here that root is known to exist. Do not check again.

If `git -C` still fails, the root exists and is not a git repository, which is a
different problem with its own handling below. Do not read it as the root being
absent.

Look up the entry's `repo` in `roots` to get that root's path. Then work out
what to stage, as the path of `target_path` relative to that root. Do NOT
assume it ends in `SKILL.md`, because the target may be a hook or a script:

```bash
git -C <root.path> add <target_path relative to root.path>
git -C <root.path> commit -m "fix({target}): {one-line summary of fix} [queue:{id}]"
```

**If either command fails, establish which failure it is before choosing a branch:**

```bash
git -C <root.path> rev-parse --is-inside-work-tree
```

`true` means the root is a git repository and the commit failed for some other reason,
so take the commit-error branch further down, which asks the user whether to retry or
revert and changes nothing. Anything else, a non-zero exit or any other output, means
there is no repository, so take the next branch.

Run this test rather than reading "git failed" as "no repository". The two branches now
have opposite consequences: one is terminal and writes a factual claim into the audit
trail that four downstream readers branch on, the other asks a question and changes
nothing. A bad pathspec, a held index lock, a rejecting pre-commit hook, or nothing
staged to commit would all otherwise be recorded as "not a git repository", which is
both false and final. Before this change both branches ended in "say so and stop", so
confusing them cost nothing. That is no longer true, which is why the test is here.

If the root is not itself a git repository, do not search upwards
for some other repository to commit into, and **do not stop here.** Step 7 already
wrote the file, and stopping cannot unwrite it, so stopping leaves the entry at
`In Progress` while the change is live on disk. A status that says the work is
unfinished when the file has already changed is the half-finished state the 0.3.1
status cleanup existed to remove.

Skip the commit and give the entry a terminal state describing what is actually
true, in one call. The note is free text, so it goes through a file rather than a
shell argument, the same as every other note this skill writes:

Write the note to a scratch file in `{scratch}`, the per-run directory from the top
of this skill, exactly as the Step 7 failure note does. Not a bare `mktemp`, which
ignores the template this skill spells out in full for a stated reason, and not a
fixed name under `/tmp`.

**The note must read exactly this, starting with `Not committed:`:**

> Not committed: written to {target_path}, {repo} is not a git repository

The prefix is load-bearing and is the counterpart to `Committed:`. `/verify-fix` and
`/revert-fix` both branch on it, because `"fix applied, watching"` no longer implies a
commit and **the absence of a hash does not identify why.** `/verify-fix` Step S4's
standalone PASS path also promotes an entry to this status with no hash, so a tool
that guesses the reason from a missing hash will tell someone their repository is not
a git repository when it is. A fixed prefix is what makes the two cases
distinguishable rather than merely both hashless.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" update {id} \
  --status "fix applied, watching" \
  --note-file {scratch}/note-{id}.txt
```

There is no commit hash, so record none rather than an invented or empty-looking
one.

If that call exits non-zero, say "The fix is written to {target_path} and there was
no commit, and the queue entry was not updated: {what it printed}." Then stop. Do not
retry silently and do not edit the entry by hand. A refusal here usually means
another session holds the lock, and running it again is the whole fix. The entry
stays at `In Progress`, which is wrong but visible, and that is better than a
hand-written entry nothing can trust.

Then say so plainly:

> "The fix is written to {target_path}. There was no commit, because {root.path} is not a git repository, so there is nothing to revert through and /revert-fix cannot help here. The entry is 'fix applied, watching'."

**Then go to "Surface dep-review entries" below, and stop after it.** Do not skip it.
Step 7 wrote the file on this path exactly as it does on the commit path, so whatever
else the change might have broken is equally exposed, and the presence of a commit has
nothing to do with it. Skipping the closing summary is right, since there is no hash or
branch to report, but skipping the dependents warning would leave related entries
sitting unnoticed in the queue after a live change.

This is what the ancestor skill did, at `foundations/bug-fix-loop/apply-fixes/SKILL.md` Step 8.

Commit message format rules:
- `{target}` — the name from the `target` field in the queue entry
- `{one-line summary}` — plain English, present tense, max 60 characters
- `[queue:{id}]` — full queue entry id (e.g., `queue:2026-04-23T13-29-20-daily-brief`)
- Never git push as part of this skill. Pushing is a separate deliberate action.

**If git commit errors** inside a root that *is* a git repository, meaning
`rev-parse --is-inside-work-tree` printed `true` in the test above. This is where every
git failure other than a missing repository lands, including a bad pathspec, a held
index lock, a rejecting hook, and nothing staged:
> "The fix is written to disk but the git commit failed: {error}. Should I try the commit again, or revert the file to its original state?"

Do NOT change the queue entry status until the user's response. Do NOT assume the file should stay — it's written without a commit and is in a limbo state.

The two paths differ because the options differ. A commit that failed inside a real
repository can be retried, and the original content is recoverable through git, so
asking is worth the pause. A root that is not a repository offers neither, so there
is nothing to ask and the entry gets its terminal state instead of a question.

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
Fix committed locally. Queue entry {id} is now "fix applied, watching".
Commit: {hash} ({repo}), on branch {branch}, not pushed.
{liveness}
Then try it for real. When it works, run /list-bugs and update the entry to Resolved.
```

`{liveness}` depends on the **kind** of the root named by the entry's `repo`, because the
two answers are opposite and getting it wrong either way misleads:

| Root kind | `{liveness}` |
|---|---|
| `skill`, `hook`, `command` | `This is live for your next session already, since it was written straight into {root.path}. Pushing is about keeping it, not about loading it.` |
| `plugin-repo` | `Nothing will load this yet. Push the branch, open a PR, and after it merges run claude plugin marketplace update and claude plugin update, since the installed copy is served from the plugin cache and not from this checkout.` |

The defaults at the top of this step are `personal` at `~/.claude/skills`, `hooks` at
`~/.claude/hooks` and `commands` at `~/.claude/commands`. A write into any of those is
picked up by the next session with no push, no PR and no install, so telling someone it
is inert would have them stop testing a change that is already active. A `plugin-repo`
root is the opposite: the running copy comes from the cache, so the checkout can be
committed and the machine still runs the old file.

Either way the commit is local, and that part is said above in both cases.

Get the branch with `git -C {repo_root} rev-parse --abbrev-ref HEAD`.

**Say "not pushed" every time, and never leave it implied.** This skill does not push,
by the deliberate decision above, and `"fix applied, watching"` reads as shipped and
under observation. On 2026-08-02 two fixes were committed here and sat on one laptop
with no push and no PR, their entries claiming they were live, and it took a separate
audit to find them. The status cannot carry that distinction, so this line has to.

If the commit is on the repository's default branch rather than a feature branch, say
that too, since it changes what pushing means:

> "This committed straight onto {branch}. If you would rather it went through review, move it to a branch before pushing."
