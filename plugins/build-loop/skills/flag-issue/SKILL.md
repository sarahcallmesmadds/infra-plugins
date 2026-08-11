---
name: flag-issue
type: human
description: Logs a correction to the bug queue at ~/.claude/build-loop/queue/, against anything the user built — a skill, a hook, a slash command, a plugin, or a loose script. Use when the user says "that was wrong", "it should have", "next time", "don't do that", corrects anything of theirs by name, says the output was not what they wanted, or explicitly invokes /flag-issue. Reads the current session context to pre-fill what it was, what happened, what was expected, and a correct example; then shows a draft to the user and waits for confirmation before writing. Dedupes against queue entries from the last 10 minutes. After writing a primary entry, reads DEPS.json and auto-adds one dep-review queue entry per dependent listed in the map — so anything likely affected by the fix surfaces for review without the user having to remember.
argument-hint: "[optional name of the thing that misbehaved]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*), Bash(mktemp:*), Bash(node:*)
---

You are logging a correction to the build loop bug queue at `~/.claude/build-loop/queue/`. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA.md` — read it if you haven't already in this session.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

> **Every queue write goes through `scripts/queue.js`.** This skill used to
> write entries with the Write tool, on the argument that a brand-new file under
> a fresh timestamped name has no good file to lose. That reasoning was about
> half-written files and it was right about those. It missed the other failure:
> the dedup check and the write were separate tool calls, so two sessions
> capturing the same correction both looked at the queue, both saw no duplicate,
> and both wrote. The check was never the problem. The gap after it was.
>
> The `create` command does the check and the write inside one process holding
> one lock, so nothing can land between them.


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

Use the path it prints. Never a fixed name under `/tmp`. Two reasons, and the
second is the one that bites on this machine. A fixed name is world-readable and
another local user can replace it between the Write and the call, so what lands
in the queue is not what was composed. And a fixed name is shared between
sessions: with two of them in flight, which is the premise of this whole change,
one session's Write lands between the other's Write and its call, and the wrong
text is recorded against the wrong entry.

## Session context guard

If there is no session history (brand new session, /flag-issue run immediately with no prior exchanges), open with:

> "No recent context to pull from. What went wrong, and what was it that misbehaved?"

Then proceed to Step 1 using whatever the user tells you.

---

## Step 1 — Identify what's being corrected

Look back at the last 3–5 exchanges in the current session. Extract five pieces of information.

**1. target** — the name of the thing being corrected. It does not have to be a skill. A hook, a slash command, a plugin, or a loose script are all valid, and the queue records which. Matching rules, in order:

- If `$ARGUMENTS` is non-empty, use it as the name.
- If the user's last message names something explicitly (e.g. "the daily-brief skill did X", "the style hook blocked that"), use that name.
- If a slash command was recently invoked, use that command's name.
- If a hook fired and its output is in the transcript, use the hook's name from that output.
- Otherwise, make a best guess from context and ask: "Which one is this about? My best guess is `{guess}`. Is that right?"

**2. target_kind** — one of `skill`, `hook`, `command`, `plugin`, `script`, `other`. Infer it rather than asking:

- The user said hook, or the misbehaviour was something firing automatically or blocking an action: `hook`
- A slash command they typed, whose definition is a single file: `command`
- Something invoked by name that carries out a task, with a `SKILL.md`: `skill`
- The complaint is about a whole plugin and not one file in it: `plugin`
- A file they run in a terminal: `script`
- Still unclear after all of that: `other`

You show this in the draft at Step 2, so a wrong guess costs nothing. Asking about it as its own question costs a turn.

**3. target_path** — the absolute path to the file a fix would edit. Resolve it this way:

1. Read the roots from `~/.claude/build-loop.config.json`. If that file does not exist, use the three defaults from SCHEMA.md: `personal` at `~/.claude/skills` (kind `skill`), `hooks` at `~/.claude/hooks` (kind `hook`), and `commands` at `~/.claude/commands` (kind `command`). If the config has `skillRoots` and no `roots`, read each of those as a root of kind `skill`.

   Then check they still exist, before searching them:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check
   ```

   - Exit 0, carry on.
   - Exit 3, a root someone configured is gone. Relay that before asking the
     user anything. "I cannot find it" and "the place I was looking no longer
     exists" are different problems, and only the first is one they can answer
     by naming a file.
   - Exit 5, only default locations are absent. Nobody configured those paths,
     so do not lead with it. Carry on, and bring it up at point 5 below if the
     target then fails to resolve, where it is the explanation.
   - Exit 4, there is nowhere to look. Relay it and go straight to asking for a
     path, rather than searching roots that are not there.
   - Exit 1, the config could not be read. Relay it and ask for a path.

   Every one of those messages arrives on stdout, including exit 1.

2. Search the roots whose `kind` matches `target_kind`, in configured order, first hit wins:
   - kind `skill`: `ls <root.path>/{target}/SKILL.md`, then `ls <root.path>/{target}/skill/SKILL.md`
   - kind `hook`: `ls <root.path>/{target}`, then `ls <root.path>/{target}.*`
   - kind `command`: `ls <root.path>/{target}.md`

   On a hit, use that path and set `repo` to that root's `name`.

3. **Also search every root of kind `plugin-repo`, whatever the `target_kind` is.** These hold things nested one level deeper, and the subdirectory that matches is what tells you the kind:

   ```bash
   ls <root.path>/plugins/*/skills/{target}/SKILL.md    # -> target_kind: skill
   ls <root.path>/plugins/*/hooks/{target}              # -> target_kind: hook
   ls <root.path>/plugins/*/hooks/{target}.*            # -> target_kind: hook
   ls <root.path>/plugins/*/commands/{target}.md        # -> target_kind: command
   ls <root.path>/plugins/*/scripts/{target}            # -> target_kind: script
   ls <root.path>/plugins/*/scripts/{target}.*          # -> target_kind: script
   ls <root.path>/plugins/*/statusline/{target}.*       # -> target_kind: script
   ls <root.path>/plugins/{target}/.claude-plugin/plugin.json  # -> target_kind: plugin
   ls <root.path>/tests/{target}.js                     # -> target_kind: script
   ls <root.path>/tests/{target}.test.js                # -> target_kind: script
   ```

   A hit here **overrides the kind you guessed in step 2 of this list**, because the directory it was found in is evidence and your guess was not.

   **A plugin resolves to its `.claude-plugin/plugin.json`, never to its
   directory.** The path recorded here is what `/apply-fix` later opens, and a
   directory cannot be opened or edited. `DEPS.json` stores plugin rows the same
   way, so recording a directory also makes the queue entry and the map disagree
   about the same plugin.

   **`statusline/` and `tests/` are searched for opposite reasons.** `statusline/`
   is a fourth place a plugin keeps executable code and a search written from the
   plugin template will not know it is there. `tests/` is at the root of the
   repository and inside no plugin, so a glob anchored at `plugins/*/` cannot
   reach it however many subdirectories it lists. Try both the bare name and the
   `.test.js` form, since a correction is far more likely to arrive as
   "session-skills" than as "session-skills.test".

   **`scripts/` is not optional and it is where the logic usually lives.** A hook or a skill in a well-built plugin is a thin wrapper over a module in `scripts/`, so that is the file a fix edits. Leaving it out meant `hook-io`, `config`, `command`, `scan` and `patterns` all failed to resolve and fell through to asking the user for a path. Two of the four `guardrails` bugs fixed on 2026-07-27 were in `scripts/`, so this was the common case rather than the edge.

   If more than one plugin holds a file with the same name, `scripts/cli.js` exists in three, do not pick one. List the paths and ask which:

   > "`{target}` exists in more than one plugin: {paths}. Which one?"

4. If `target_kind` is `other` and nothing above matched, there is no convention left to search. Ask.

5. If nothing was found anywhere, the check in point 1 has already said whether the roots themselves are the problem. Where it named one as gone, repeat that before asking for anything: a root that has moved is the likely reason, and naming a file does not fix it.

   Then ask: "I can't find `{target}` in any configured root. What file should a fix edit?"

   Record whatever path they confirm. If it sits outside every configured root, set `repo: "unknown"` and note it. Never guess a path, and never fall back to a plausible-looking file. A wrong path here sends a commit into an unrelated repository.

6. **Never record a path under `~/.claude/plugins/marketplaces/`.** That is the plugin manager's cache and it is overwritten on the next update, so a fix committed there disappears without warning. If the only match is there, say so and ask where the checkout lives:

   > "`{target}` resolves to the installed copy at `{path}`, which the plugin manager overwrites on update. Where is the checkout you actually edit?"

**4. what_happened** — the behavior the user flagged as wrong. Summarize in one or two sentences in plain language. Quote the user's own words if they are short enough.

**5. what_expected** — what the user said it should have done. If they stated it explicitly, quote them. If not, ask ONE clarifying question:

> "Got it. What should it have done instead? A rough description is fine."

**6. correct_example** — a concrete example of correct output. If the user gave one, use it verbatim. If not, ask ONE question:

> "Can you give me a rough example of what the right output would have looked like? One line is fine."

Rule: ask at most ONE clarifying question per turn. If the user's last message already answered a question, do not re-ask it.

---

## Step 2 — Show the draft and ask for confirmation

Display the draft in this exact format before writing anything:

```
I'll log this correction to the queue:

Target: {target}  ({target_kind}, path: {target_path}, repo: {repo})
What happened: {what_happened}
What expected: {what_expected}
Correct example: {correct_example}

Write it? (y / edit / skip)
```

On the user's response:

- `y`, `yes`, `sure`, `go`, or any clear affirmative → proceed to Step 3.
- `edit` or any change request → update the draft with them edits, re-show, ask again.
- `skip`, `no`, `nope`, or any negative → respond "Skipped, nothing logged." and stop. Do not write anything.

**No silent writes. Ever.**

---

## Step 3 — Dedup check

Before writing, check for a duplicate:

1. Compute `dedup_key`:
   - Take the first 40 characters of `what_happened`.
   - Lowercase, replace all non-alphanumeric characters with `-`, strip leading/trailing dashes.
   - Result: `dedup_key = "{target}::{slug}"`

2. Look for an existing entry with the same `dedup_key` created in the last ten
   minutes, so you can tell the user before writing:

   ```bash
   ls ~/.claude/build-loop/queue/*.json 2>/dev/null
   ```

   Read each and compare. This is a courtesy check, not the guarantee. The real
   one happens inside the lock in Step 4, which is where a duplicate is actually
   refused, and it is worth knowing which is which: this check can be beaten by
   another session writing in the moment between it and your write, and that one
   cannot.

3. If a duplicate is found:
   > "I already have a similar entry from {when}: `{existing_filename}`. Skip (dedupe) or write anyway?"
   Default if no response: skip.

4. If no duplicate, continue to Step 4.

---

## Step 4 — Write the JSON file

Compose the entry object. All fields required per SCHEMA.md v5:

```
$schema_version: 5
id:             {YYYY-MM-DDTHH-MM-SS}-{slug(target)}    ← filename stem, must match exactly
created_at:     current UTC time in ISO-8601 (e.g. 2026-04-23T14:30:00.000Z)
status:         "Open"
type:           "primary"
parent_id:      null
target:         {target}
target_kind:    {target_kind}
target_path:    {target_path}
repo:           {repo}
session_id:     the current Claude Code session ID, resolved as below. Fill "" only after that has failed.
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

**Resolving `session_id`.** Do not reach for `""` first. The scratchpad directory
named in your system prompt carries the id in its path, which has the shape
`.../{project-slug}/{session-id}/scratchpad`, so the segment immediately before
`scratchpad` is the id. Confirm it rather than trusting the shape:

```bash
ls ~/.claude/projects/*/{session_id}.jsonl
```

A hit means the id is right and the transcript is on disk to be read later.
Record `""` only when there is no scratchpad path to read from, or when nothing
matches.

This field is the only route from a queue entry back to the conversation that
produced it. The entry filed on 2026-08-07 against `UserPromptSubmit` carried
`""`, and working out what had actually failed took a full session of forensics
four days later, because there was no transcript to open and the surrounding
sessions had none of the failure in them. The id was sitting in the scratchpad
path the whole time. Treat this as required, not as a convenience field.

Then:

1. Get the current UTC time: `date -u +"%Y-%m-%dT%H-%M-%S"` for the filename, `date -u +"%Y-%m-%dT%H:%M:%S.000Z"` for `created_at`.
2. Build the filename: `{YYYY-MM-DDTHH-MM-SS}-{slug(target)}.json`
   The `id` field MUST equal the filename stem (everything before `.json`).
3. Ensure the queue directory exists: `mkdir -p ~/.claude/build-loop/queue`
4. Write the composed entry to a scratch file with the Write tool, then hand it
   over. Do not write it into the queue directory yourself:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" create {scratch}/{filename}
   ```

   It re-checks the `dedup_key` inside the lock and writes only if nothing
   matched, so the check and the write cannot be separated.

   **If Step 3 found a duplicate and the user said "write anyway", pass
   `--dedup-window 0`**, which skips the check. Without it the write is refused
   for the exact duplicate they just approved, and the correction they asked to
   keep is discarded. Exit 0 means it was
   written. Exit 2 means a duplicate won the race and nothing was written: say so
   and name the entry it printed, rather than retrying. Exit 1 is a real error
   and the message is written to be read aloud.
5. **Stop here unless it exited 0.** Nothing below this line is true if the
   entry was not written.

   - Exit 2, a duplicate won the race: say so, name the entry it printed, and
     stop. Do not retry.
   - Exit 1, a real error: read its message out and stop.

   In both cases do NOT go on to Step 4b and do NOT print the confirmation.
   Dep-review entries carry `parent_id` pointing at the primary, so writing them
   against an entry that does not exist leaves children with no parent, and the
   Step 4c line would tell the user their correction was logged when it was
   discarded. That is the worst failure this skill has, because the user has no
   reason to check.

   The old flow could not reach this state: the dedup decision happened before
   the single Write, so there was no way to be refused after deciding to write.
   `create` can refuse, so the branch has to exist.
6. Do NOT count here, and do NOT confirm here. Go straight to Step 4b. The
   count is taken in Step 4c, after the dep-review entries exist.

   It used to be taken at this point, and every dep-review written afterwards
   made it wrong by one. The confirmation then reported a total and, in the next
   breath, announced N entries the total did not include.

---

## Step 4b — Auto-add dep-review entries for dependents

After the primary entry is written in Step 4, flag anything the map says depends on it. This runs BEFORE the final confirmation message — the confirmation in Step 4 becomes a later step below (see Step 4c).

### Read DEPS.json

Read `~/.claude/build-loop/DEPS.json` using the Read tool.

**If the read fails** (file missing, permission denied, or the content is not valid JSON):
> Print: "⚠ DEPS.json missing or unreadable, skipping dep-review flagging. Run /audit-deps to fix."
> Jump to Step 4c with `dep_reviews_written: 0`. Never block the primary write.

### Look up the captured target's entry

Build the composite key from the primary entry you just wrote, following the Composite Key Rule in SCHEMA-DEPS.md:

- Normally `{repo}:{target}`.
- **When the owning root is of kind `plugin-repo`, it is `{repo}:{plugin}/{target}`.** Take the plugin segment from `target_path`, which is the directory under `plugins/`, not from the target name. The name alone cannot say which plugin it is in, and three of them ship a `cli`.

Read the map from `DEPS.json.targets`. **If that key is absent and `DEPS.json.skills` is present, use `skills` instead**, treating each entry's `skill` field as `target` and a missing `kind` as `"skill"`. That is a v1 map, per SCHEMA-DEPS.md. Reading only `targets` against a v1 map finds nothing, reports every dependency as absent, and silently skips the dep-review flagging that is the whole point of this step.

**If the exact key is absent, work down this list before giving up.** A lookup that quietly finds nothing is indistinguishable from a target that genuinely has no dependents, so exhaust the fallbacks first and then say which one matched.

**a. The bare key, `{repo}:{target}`.** A map written before v3 stored plugin-repo entries under a plain name, `plugins:hook-io` rather than `plugins:guardrails/hook-io`. Step b cannot find those, because `hook-io` does not end with `/hook-io`. Without this step every pre-v3 map goes silent the moment this version is installed.

On a match here, add this to the confirmation in Step 4c:

> `Note: DEPS.json predates v3, so this matched on name alone. If more than one plugin has a {target}, the entry may describe a different one. Run /audit-deps to rebuild the keys.`

A pre-v3 map is the file where `plugins:cli` meant three different things, so the entry may belong to another plugin. Using it beats going silent, and calling it exact would be wrong.

**b. A suffix match on `/{target}`.** The mirror of a: a bare lookup against a map that is already qualified.

- Exactly one match: use it.
- More than one: do not choose. Say which keys matched and that the name is ambiguous, then carry on to Step 4c with `dep_reviews_written: 0`. Picking one sends a review to the wrong plugin, which is the exact failure the key format exists to stop.

**c. Nothing matched.** There is no entry, which is the case handled below.

**If the key is NOT in the map:**
> Print: "⚠ {target} not in DEPS.json, skipping dep-review flagging. Run /audit-deps to add it."
> Jump to Step 4c with `dep_reviews_written: 0`.

**If the key IS present**, look at its `dependents`. If the array is empty, jump to Step 4c with `dep_reviews_written: 0` — there's nothing to flag, which is the common case.

### For each dependent, write a dep-review entry

For every `{ target: X, plugin: P, kind: K, repo: R, reason: Y, confidence?: low }` in the dependents array. An edge written before schema v5 carries `skill` instead of `target` and has no `kind`, so read `X` from `target` if present and `skill` otherwise, and default `K` to `skill`:

**`X` is bare and stays bare.** `P` is a separate field naming the plugin, and it is only there under a `plugin-repo` root. Use `{R}:{P}/{X}` when you need the edge's key in `DEPS.json`, and use `X` on its own everywhere the dep-review entry is concerned.

**Never write `{P}/{X}` into the entry's `target`.** A queue entry's `target` is a name on disk that `/apply-fix` and `/list-bugs` later have to resolve to a file, and nothing on disk is called `guardrails/hook-io`. If an edge does carry a slashed `target`, which a map written before this rule may, split it: the part before the last `/` is `P` and the part after is `X`.

**The `id`, the filename, and the `dedup_key` want the opposite.** Those exist to be unique, and a bare name is not. One fix to something that `guardrails/cli` and `slop-check/cli` both depend on produces two dependents with the same bare name, and then:

- the same filename, so the second write overwrites the first
- the same `dedup_key`, so the dedup check in step 3 skips the second

Either way one review survives and the other disappears without a word, which is the failure this whole map exists to prevent, happening inside the thing meant to prevent it.

So fold `P` in wherever the value is an identifier, and leave it out wherever the value is a name that has to resolve:

| value | with a plugin | without |
|---|---|---|
| `target` | `{X}` | `{X}` |
| `id` and filename | `{ts}-dep-review-{slug(P)}-{slug(X)}` | `{ts}-dep-review-{slug(X)}` |
| `dedup_key` | `dep-review::{P}/{X}::{parent id}` | `dep-review::{X}::{parent id}` |

1. **Compute urgency_hint** (Claude's judgment — this is NOT a rule engine):
   - Tight coupling signals: Y mentions "explicit call", "shared DB ID", or "schema reference" — OR the edge confidence is `"high"`.
   - Loose coupling signals: Y describes semantic/lens/output-format similarity — OR the edge confidence is `"low"`.
   - Tight → urgency_hint = same as the primary entry's urgency_hint
   - Loose → urgency_hint = one level lower: high→normal, normal→low, low stays low

2. **Compute the dep-review dedup key**: `dep-review::{P}/{X}::{primary entry's id}` when `P` is present, otherwise `dep-review::{X}::{primary entry's id}`. The plugin belongs here. Without it, two dependents called `cli` in different plugins produce one key, and the second is skipped as a duplicate of the first.

3. **Dedup**: not a separate step any more. Step 5 passes `--dedup-window all`,
   which makes `queue.js` refuse any entry whose `dedup_key` already exists at
   any age. Unlike primary dedup, dep-review dedup has no expiry: one parent and
   one dependent is one logical review, forever, not one every ten minutes.

4. **Build the dep-review entry** (all fields per SCHEMA.md v5):
   ```
   $schema_version:  5
   id:               {primary timestamp}-dep-review-{slug(P)}-{slug(X)}, or -dep-review-{slug(X)} where there is no P
   created_at:       {same as primary entry's created_at}
   status:           "Open"
   type:             "dep-review"
   parent_id:        {primary entry's id}
   target:           {X}          <- bare. Never {P}/{X}.
   target_kind:      {K}
   target_path:      {DEPS.json entry's path value}
   repo:             {R}
   session_id:       {same as primary entry's session_id}
   session_cwd:      {same as primary entry's session_cwd}
   what_happened:    "Review: {X} may be affected by fix to {primary target}. Reason: {Y}"
   what_expected:    "(not applicable: this is a dependency review)"
   correct_example:  "(not applicable)"
   source:           "dep-review-auto"
   urgency_hint:     {computed above}
   dedup_key:        dep-review::{P}/{X}::{primary entry's id}, or dep-review::{X}::{...} where there is no P
   notes:            []
   resolution:       null
   ```

5. **Write the entry.** Compose it to a scratch file with the Write tool, then:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" create {scratch}/{id}.json --dedup-window all
   ```

   The filename it lands under is the `id` with `.json` appended, so
   `{primary timestamp}-dep-review-{slug(P)}-{slug(X)}.json` where there is a
   plugin. `queue.js` derives it from the `id` field, which is what keeps the two
   from drifting apart: an entry whose filename and `id` disagree cannot be found
   by its own identifier.

   Exit 2 means this review already exists, which is not an error. Exit 1 is:
   report the failure for that dependent and carry on with the remaining ones,
   per the failure handling at the end of this step. Neither counts toward
   `dep_reviews_written`, so step 6 runs only after an exit 0.

6. Increment `dep_reviews_written`.

### Step 4c — Confirmation message

The confirmation message from the current Step 4 is REPLACED. Instead of "Logged to {filename}. Queue now has N open items.", use this rule.

**Take the count now, after every write above has landed:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/queue.js" count
```

**Count statuses, never files.** This used to be `ls queue/*.json | wc -l`,
which counts every entry ever written. A resolved entry stays in the same
directory with its status changed, so that number only ever grows: on
2026-08-09 it reported 85 open items against 19 that were actually open, the
other 66 being resolved or closed. Reporting it as "open" made a queue with
seven live bugs in it look abandoned, which is the opposite of what the number
is for.

**And take it here rather than before Step 4b.** It used to run right after the
primary entry was written, so every dep-review written afterwards left it short
by one. The message then gave a total and immediately announced N entries that
total did not include, which is a plainer contradiction than the one this
replaced, because both halves are on screen at once.

`{count}` is the line that command printed, repeated as it came. **Do not
restate part of it as a total of your own.** The fault this replaced was a
number presented as "open items" that was not one, and quoting half of a correct
line reintroduces it in a smaller way.

- If `dep_reviews_written == 0`:
  > "Logged to `{filename}`. Queue: {count}."

- If `dep_reviews_written > 0`:
  > "Logged to `{filename}`. Queue: {count}."
  > "Also flagged {dep_reviews_written} dep-review {entr(y|ies)}: {comma-separated target names}."

Pluralization: use "entry" when `dep_reviews_written == 1`, "entries" otherwise.

### Failure handling inside Step 4b

If ANY dep-review write fails (exit 1 from `queue.js`, or the Write tool erroring on the scratch file), continue with the remaining dependents and note the failure in the confirmation. An exit 2 is a duplicate rather than a failure, so it is not counted here:
> "Flagged {K} of {total} dep-reviews. {total - K} failed to write. Check the queue directory manually."

The primary entry write is never rolled back because a dep-review write failed. The primary is the source of truth; dep-reviews are convenience.

---

## Failure handling

- If the Write tool fails for any reason, tell the user exactly what failed. Do NOT retry silently. They may want to fix the root cause before retrying.
- If the user declines to answer a clarifying question, record the missing field as `"(not provided)"` and still write the entry. A partial entry is better than a lost correction. Flag this in the confirmation message:
  > "Logged with missing {field}. You can edit the file later at `{path}`."
- **`target_path` is the exception, and it is not a partial entry, it is a blocked
  one.** With no path there is nothing to infer `repo` from, so the entry lands as
  `repo: "unknown"`, and `/apply-fix` refuses that outright. The correction is
  recorded and can never be started by anything. Say that before writing, rather
  than after:

  > "Without a file path this cannot be started. `/apply-fix` refuses an entry
  > whose repo is unknown, and the repo is worked out from the path, so with no
  > path there is nothing to work it out from. Log it anyway, or name the file?"

  Answering with a real path is the whole remedy, as long as it sits under a
  configured root: the `target_path` resolution in Step 1 sets `repo` from the
  root it matched. A path outside every root still leaves `repo: "unknown"`, so
  say so at that point rather than letting them believe the question is settled.

  If they choose to log it anyway, the confirmation names what it is, and names
  the field that actually unblocks it:

  > "Logged as blocked. `/apply-fix` refuses it until `repo` is set at `{path}`.
  > Filling in `target_path` alone will not clear it, because `repo` is worked
  > out once, when the entry is written, and nothing recomputes it afterwards."

  **Say `repo`, not `target_path`.** The guard in `/apply-fix` reads `repo` and
  nothing else, and the Repo Attribution Rule in SCHEMA.md infers `repo` from the
  path at capture time only. Sending somebody to type a path into an entry that
  already exists points them at the one field that will not move the guard, and
  they find out when the fix command refuses them a second time, for the same
  reason as the first. That is this bullet's own failure happening one level
  down, and it is how the wrong wording got written: it was corrected to name the
  blockage and never checked for whether it named the remedy.

  The old wording, "Logged with missing field, you can edit the file later", is
  what let the 2026-08-07 `UserPromptSubmit` entry read as a minor gap. It sat
  unworkable for four days because nothing in the confirmation said it could not
  be worked at all.
- If `repo` ends up as `"unknown"`, add a note in the `notes` array:
  `{"ts": "{created_at}", "text": "repo unknown: target_path {target_path} is outside both known roots. Resolve before Phase 3 can apply the fix."}`
- If DEPS.json cannot be read in Step 4b, NEVER block the primary confirmation. The primary entry is the source of truth. Dep-review is best-effort.
