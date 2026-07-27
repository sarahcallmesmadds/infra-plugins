---
name: flag-issue
type: human
description: Logs a correction to the bug queue at ~/.claude/build-loop/queue/, against anything the user built — a skill, a hook, a slash command, a plugin, or a loose script. Use when the user says "that was wrong", "it should have", "next time", "don't do that", corrects anything of theirs by name, says the output was not what they wanted, or explicitly invokes /flag-issue. Reads the current session context to pre-fill what it was, what happened, what was expected, and a correct example; then shows a draft to the user and waits for confirmation before writing. Dedupes against queue entries from the last 10 minutes. After writing a primary entry, reads DEPS.json and auto-adds one dep-review queue entry per dependent listed in the map — so anything likely affected by the fix surfaces for review without the user having to remember.
argument-hint: "[optional name of the thing that misbehaved]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(mkdir:*)
---

You are logging a correction to the build loop bug queue at `~/.claude/build-loop/queue/`. The schema is at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA.md` — read it if you haven't already in this session.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

> **This skill writes directly, on purpose.** Every other skill here writes JSON
> through the `.tmp` plus parse-check plus `mv` sequence, and says that rule has
> no exceptions. This one is the exception, which is why `allowed-tools` above
> grants no `node` or `mv`.
>
> The reason is what the pattern protects against. It exists so a half-written
> file cannot replace a good one. This skill only ever creates brand-new queue
> entries under a fresh timestamped filename, so there is no good file to lose.
> The worst case is one unparseable new entry, and `list-bugs` already
> renders those as `(malformed)` rather than failing, so it is visible and
> deletable.
>
> If this skill is ever changed to update an existing entry, that rule stops
> applying and the atomic sequence becomes mandatory.

## Session context guard

If there is no session history (brand new session, /flag-issue run immediately with no prior exchanges), open with:

> "No recent context to pull from — what went wrong, and what was it that misbehaved?"

Then proceed to Step 1 using whatever the user tells you.

---

## Step 1 — Identify what's being corrected

Look back at the last 3–5 exchanges in the current session. Extract five pieces of information.

**1. target** — the name of the thing being corrected. It does not have to be a skill. A hook, a slash command, a plugin, or a loose script are all valid, and the queue records which. Matching rules, in order:

- If `$ARGUMENTS` is non-empty, use it as the name.
- If the user's last message names something explicitly (e.g. "the daily-brief skill did X", "the style hook blocked that"), use that name.
- If a slash command was recently invoked, use that command's name.
- If a hook fired and its output is in the transcript, use the hook's name from that output.
- Otherwise, make a best guess from context and ask: "Which one is this about? My best guess is `{guess}` — is that right?"

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
   ls -d <root.path>/plugins/{target}                   # -> target_kind: plugin
   ```

   A hit here **overrides the kind you guessed in step 2 of this list**, because the directory it was found in is evidence and your guess was not.

   **`scripts/` is not optional and it is where the logic usually lives.** A hook or a skill in a well-built plugin is a thin wrapper over a module in `scripts/`, so that is the file a fix edits. Leaving it out meant `hook-io`, `config`, `command`, `scan` and `patterns` all failed to resolve and fell through to asking the user for a path. Two of the four `guardrails` bugs fixed on 2026-07-27 were in `scripts/`, so this was the common case rather than the edge.

   If more than one plugin holds a file with the same name, `scripts/cli.js` exists in three, do not pick one. List the paths and ask which:

   > "`{target}` exists in more than one plugin: {paths}. Which one?"

4. If `target_kind` is `other` and nothing above matched, there is no convention left to search. Ask.

5. If nothing was found anywhere, first check whether any configured root exists on disk at all. If none do, say this once rather than asking for a path every time:

   > "None of the configured roots exist on this machine. If you develop plugins in a checkout, add it to `~/.claude/build-loop.config.json` as a root of kind `plugin-repo` and this will resolve automatically. For now, what file should a fix edit?"

   Otherwise ask: "I can't find `{target}` in any configured root. What file should a fix edit?"

   Record whatever path they confirm. If it sits outside every configured root, set `repo: "unknown"` and note it. Never guess a path, and never fall back to a plausible-looking file. A wrong path here sends a commit into an unrelated repository.

6. **Never record a path under `~/.claude/plugins/marketplaces/`.** That is the plugin manager's cache and it is overwritten on the next update, so a fix committed there disappears without warning. If the only match is there, say so and ask where the checkout lives:

   > "`{target}` resolves to the installed copy at `{path}`, which the plugin manager overwrites on update. Where is the checkout you actually edit?"

**4. what_happened** — the behavior the user flagged as wrong. Summarize in one or two sentences in plain language. Quote the user's own words if they are short enough.

**5. what_expected** — what the user said it should have done. If they stated it explicitly, quote them. If not, ask ONE clarifying question:

> "Got it — what should it have done instead? A rough description is fine."

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
- `skip`, `no`, `nope`, or any negative → respond "Skipped — nothing logged." and stop. Do not write anything.

**No silent writes. Ever.**

---

## Step 3 — Dedup check

Before writing, check for a duplicate:

1. Compute `dedup_key`:
   - Take the first 40 characters of `what_happened`.
   - Lowercase, replace all non-alphanumeric characters with `-`, strip leading/trailing dashes.
   - Result: `dedup_key = "{target}::{slug}"`

2. Run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`.
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
2. Build the filename: `{YYYY-MM-DDTHH-MM-SS}-{slug(target)}.json`
   The `id` field MUST equal the filename stem (everything before `.json`).
3. Ensure the queue directory exists: `mkdir -p ~/.claude/build-loop/queue`
4. Use the Write tool to write the JSON file to `~/.claude/build-loop/queue/{filename}`.
   Pretty-print with 2-space indentation (human-readable).
5. Count open items: `ls ~/.claude/build-loop/queue/*.json 2>/dev/null | wc -l`
6. Do NOT confirm here — proceed directly to Step 4b (dep-review flagging). Confirmation happens in Step 4c after flagging completes.

---

## Step 4b — Auto-add dep-review entries for dependents

After the primary entry is written in Step 4, flag anything the map says depends on it. This runs BEFORE the final confirmation message — the confirmation in Step 4 becomes a later step below (see Step 4c).

### Read DEPS.json

Read `~/.claude/build-loop/DEPS.json` using the Read tool.

**If the read fails** (file missing, permission denied, or the content is not valid JSON):
> Print: "⚠ DEPS.json missing or unreadable — skipping dep-review flagging. Run /audit-deps to fix."
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
> Print: "⚠ {target} not in DEPS.json — skipping dep-review flagging. Run /audit-deps to add it."
> Jump to Step 4c with `dep_reviews_written: 0`.

**If the key IS present**, look at its `dependents`. If the array is empty, jump to Step 4c with `dep_reviews_written: 0` — there's nothing to flag, which is the common case.

### For each dependent, write a dep-review entry

For every `{ target: X, plugin: P, kind: K, repo: R, reason: Y, confidence?: low }` in the dependents array. An edge written before schema v5 carries `skill` instead of `target` and has no `kind`, so read `X` from `target` if present and `skill` otherwise, and default `K` to `skill`:

**`X` is bare and stays bare.** `P` is a separate field naming the plugin, and it is only there under a `plugin-repo` root. Use `{R}:{P}/{X}` when you need the edge's key in `DEPS.json`, and use `X` on its own everywhere the dep-review entry is concerned.

Never write `{P}/{X}` into the entry's `target`, its `id`, or its filename. A queue entry's `target` is a name on disk that `/apply-fix` and `/list-bugs` later have to resolve to a file, and nothing on disk is called `guardrails/hook-io`. If an edge does carry a slashed `target`, which a map written before this rule may, split it: the part before the last `/` is `P` and the part after is `X`.

1. **Compute urgency_hint** (Claude's judgment — this is NOT a rule engine):
   - Tight coupling signals: Y mentions "explicit call", "shared DB ID", or "schema reference" — OR the edge confidence is `"high"`.
   - Loose coupling signals: Y describes semantic/lens/output-format similarity — OR the edge confidence is `"low"`.
   - Tight → urgency_hint = same as the primary entry's urgency_hint
   - Loose → urgency_hint = one level lower: high→normal, normal→low, low stays low

2. **Compute the dep-review dedup key**: `dep-review::{X}::{primary entry's id}`.

3. **Dedup check**: run `ls ~/.claude/build-loop/queue/*.json 2>/dev/null`. Read each file. If any existing entry has the same `dedup_key`, skip this dependent and continue to the next. (Unlike primary dedup, dep-review dedup is NOT time-windowed — the same parent_id + dependent pair is one logical review, forever.)

4. **Build the dep-review entry** (all fields per SCHEMA.md v5):
   ```
   $schema_version:  5
   id:               {primary entry's timestamp}-dep-review-{slug(X)}
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
  > "Also flagged {dep_reviews_written} dep-review {entr(y|ies)}: {comma-separated target names}."

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
  `{"ts": "{created_at}", "text": "repo unknown — target_path {target_path} is outside both known roots. Resolve before Phase 3 can apply the fix."}`
- If DEPS.json cannot be read in Step 4b, NEVER block the primary confirmation. The primary entry is the source of truth. Dep-review is best-effort.
