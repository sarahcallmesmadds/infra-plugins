---
name: whats-breaking
type: human
description: A weekly report on what broke, what got fixed, and what keeps coming back. Reads the bug queue, finds the things corrected three or more times on three or more separate occasions, writes the report to ~/.claude/build-loop/summaries/YYYY-WW.md, and offers to post it to Slack. Use when the user asks "what keeps breaking", "what's breaking", "what did I fix this week", "show me the patterns", or explicitly invokes /whats-breaking. Runs on a local machine only, never in a cloud runtime.
allowed-tools: [Read, Write, Bash, mcp__slack__*]
---


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

## Runtime Requirements

This skill MUST run on the user's local Mac. It reads from local-only paths:
- `~/.claude/build-loop/queue/` — queue files
- `~/.claude/build-loop/pattern-flags.json` — flag store
- `~/.claude/build-loop/summaries/` — output directory
- `~/.claude/hot-cache.md` — session memory trail

It CANNOT run in:
- Claude Desktop's "New Task" UI (defaults to Cowork — a cloud session with no access to `~/.claude/`)
- Any Cowork or remote-agent runtime
- `/schedule` remote agents (also cloud-based)

To run on a schedule, use a local-only mechanism:
- macOS `launchd` job in the user's user session
- A terminal-launched `cron` job that opens a Claude Code session
- Manual invocation in a Claude Code terminal session

**Why this matters:** scheduling this skill via Claude Desktop's New Task UI fires the task in Cowork, which silently does nothing — no flags written, no summary generated — because the queue files don't exist in that runtime. The failure is silent, so the schedule looks healthy when it isn't (queue entry 2026-04-24T22-07-34-skill-summary).

**Scheduling-research lesson:** when adding a schedule for ANY skill that reads or writes local paths, verify the chosen runtime can access those paths BEFORE declaring the schedule complete. Cloud-only schedulers (Cowork, /schedule, remote-agent) cannot reach `~/.claude/`.

---

## Overview

This skill is the weekly rhythm for the build loop. It reads the correction queue, detects structural patterns (things that have been corrected 3+ times on 3+ separate occasions), writes a pattern-flags.json file for the maintainer co-development review, generates a weekly summary report at `~/.claude/build-loop/summaries/YYYY-WW.md`, and optionally posts that summary to Slack.

**When to invoke:** Manually any time you want a fresh read of the queue, or automatically via a local `launchd` or terminal `cron` job that opens a Claude Code session (NOT Claude Desktop's "New Task" UI — see Runtime Requirements above; that path runs in Cowork and silently does nothing).

**Plan 04-02 implemented Steps 1–6 (pattern detection + pattern-flags.json).**
**Plan 04-03 adds Steps 7–10 (summary report generation, file write to `summaries/YYYY-WW.md`, optional Slack post, hot-cache.md update).**

**Load-bearing context from Phase 4 design (see `.planning/phases/04-intelligence-layer/04-DESIGN.md` in the build loop project if you need the full spec):**
- "Same type" for pattern flagging = target-level grouping. 3+ closed primary corrections for the same target on 3+ occurrences = structural flag. No semantic classification.
- Pattern detection runs ONLY inside this skill. Not on every queue close. Not as a standalone hook. Weekly cadence is correct at current volume.
- One flag entry per target in pattern-flags.json, forever. Updates are always in-place — never create a second flag for the same target.
- Structural fixes from pattern flags are NEVER auto-applied. PATT-03 requires the maintainer co-development review. The flag surfaces the problem; it does not trigger changes. Status stays `pending-review` until the maintainer and the user change it manually.
- Summary file front-loads Pattern Flags before Fixes Applied and Still Open — the session-start hook truncates at 2,000 chars and truncation cuts the tail.

---

## Step 1: Load Queue Entries

Read every queue entry file. Malformed files are skipped silently — they never block detection.

Run:

```bash
ls ~/.claude/build-loop/queue/*.json 2>/dev/null
```

For each file returned, use the Read tool to load its JSON contents. If a file fails to parse, skip it silently and increment a `skipped_malformed` counter — do NOT throw or stop the run. You will note the skipped count in Step 6 output.

Collect parsed entries into a working list. Each entry should have these fields (from the SCHEMA.md v5 queue entry schema):

```
id: string (unique entry id, and the counting token for a deliberate correction)
target: string (the name of the thing corrected — grouping key)
target_kind: "skill" | "hook" | "command" | "plugin" | "script" | "other"
repo: string (name of the root it lives in, or "unknown")
type: "primary" | "dep-review" (missing field defaults to "primary")
status: "Resolved" | "fix applied, watching" | "Open" | "In Progress" | "fix attempted / unresolved" (retired in 0.3.1, still readable on older entries)
session_id: string (the session that filed it, may be empty on entries written before 0.9.6)
source: string (which entry point wrote it, and what decides how it is counted)
what_happened: string (free text — read for diagnosis generation in Step 2d)
target_path: string (absolute path to the file a fix would edit — copied into flag entries)
```

Missing fields should be treated as follows:
- Missing `type` → treat as `"primary"` (v1 entries predate the type field)
- Missing `target` → read `skill` instead (entries predating v5)
- Missing `target_kind` → treat as `"skill"`
- Missing `target_path` → read `skill_path` instead, and if that is absent too, leave as empty string in flag output
- Missing `session_id` → treat as empty string `""`
- Missing `source` → treat as `"stop-hook"`. That is the conservative reading:
  it dedups by session, which is what every entry did before the field was
  consulted, so an old entry counts exactly as it always has.
- Missing `repo` → treat as `"unknown"`

---

## Step 2: Pattern Detection

This is the reasoning step Claude executes against the loaded entries. The algorithm below comes directly from `04-DESIGN.md` Section 2 and is the single source of truth for pattern detection.

### Step 2a — Filter to closed primary corrections

Keep only entries where BOTH:
- `type` is `"primary"` OR the `type` field is missing
- `status` is `"Resolved"` OR `status` is `"fix applied, watching"`

Discard everything else:
- `type: "dep-review"` entries — never count toward structural flags
- `status: "Open"` entries
- `status: "In Progress"` entries
- `status: "fix attempted / unresolved"` entries. Retired in 0.3.1: nothing writes
  it any more and a rejected fix stays `Open`. Kept here because entries written
  before 0.3.1 still carry it, and both statuses are discarded anyway, so the
  retirement changes nothing about which entries feed pattern detection.

This filter is strict. Only closed primary corrections feed pattern detection.

### Step 2b — Group by target name, count occurrences

For each qualifying entry:
- Grouping key = `entry.target`
- Counting token, decided by `entry.source`:
  - `"slash-capture"` → `entry.id`
  - anything else, including `"manual"` and a missing `source` → `entry.session_id`
    if it is a non-empty string, else `entry.id`

Build this map:

```
byTarget = {
  "<target-name>": {
    occurrences: Set of counting tokens,
    entries: list of full entry objects (preserved for diagnosis and example_entries)
  },
  ...
}
```

**Say occurrences, not sessions.** They were the same thing until 0.9.6 and are
not any more, and the number is printed to somebody who will act on it. Three
`/flag-issue` corrections typed in one sitting are three occurrences and one
sitting. Reporting that as "three sessions" tells the reader a problem recurred
across three separate occasions when it happened on one, which turns a single bad
afternoon into a standing pattern: exactly the thing the dedup half of this rule
exists to prevent. Devin caught it on PR #96, in the round that introduced it.

**Counting rule:** the rule has always had two jobs. A stop-hook can fire many
times in one sitting, and counting each firing would let one afternoon look like
a pattern, so those dedup by session. A correction someone typed through
`/flag-issue` is a deliberate act, and three of them about the same target is
three separate decisions to complain, so those count one each.

**Only `slash-capture` counts per entry.** It is the one source whose behaviour
the 0.9.6 `session_id` fix changed, so it is the only one this rule restores.
`manual` was briefly included on the argument that a hand-written entry is also
deliberate. That argument is not evidence, no fault ever motivated it, and the
effect would have been to let a few hand-written entries cross the threshold on
their own. A behaviour here changes on a fault, not on a reason it might be nice.

**Read that from `source`, never from an empty `session_id`.** Until 0.9.6
`/flag-issue` left `session_id` blank, so slash-capture entries fell through to
`entry.id` and got the per-entry counting by accident. The rule looked like it
was about missing session context and was actually about who filed the entry.
When 0.9.6 started resolving the id, three corrections filed in one sitting
collapsed to one data point and dropped below the threshold, silently. Devin
caught it on PR #96 before it shipped. `source` says what the entry is, and it
cannot be quietly changed by an unrelated fix somewhere else.

Entries of type `dep-review` never reach this step. Step 2a discards them, so a
dep-review copying its parent's `session_id` cannot affect any count.

### Step 2c — Apply threshold

```
flaggedTargets = targets where byTarget[target].occurrences.size >= 3
```

Threshold is exactly 3 occurrences. Targets with fewer than 3 occurrences of closed corrections are NOT flagged, no matter how many total correction entries they have.

### Step 2d — For each flagged target, generate a diagnosis

Read all the `what_happened` strings from qualifying entries for that target. Synthesize a diagnosis of 3–5 sentences, max ~500 characters, covering:

1. How many corrections, across how many occasions.
2. What the corrections cluster around — name 2–4 specific recurring issues directly, pulled from the what_happened text.
3. A structural cause hypothesis — what about its design is likely causing the recurrence.

**Required format:**

```
{target} has been corrected {N} times on {M} separate occasions. The corrections cluster around: (1) {issue one}, (2) {issue two}[, (3) {issue three}]. Its structure likely {structural cause hypothesis}.
```

`{M}` is `occurrence_count`, and it is not a count of sessions. Do not reword it
back into one. Several `/flag-issue` corrections typed in a single sitting are
several occasions here and one session, so calling them sessions overstates how
far the problem has spread.

**Hard cap: 500 characters.** This cap exists so the diagnosis fits in the summary file without blowing the 9,000-char session-start context cap downstream.

**What the diagnosis is NOT:** It is not a fix prescription. It names the problem and hypothesizes the structural cause. Fix design is the maintainer's domain (PATT-03). Do NOT propose fixes in the diagnosis. Do NOT include action items. Describe the pattern, name the likely structural cause, stop.

Also collect for each flagged target:
- `correction_count` = total number of qualifying entries for this target (not deduped)
- `occurrence_count` = `byTarget[target].occurrences.size` (deduped)
- `example_entries` = up to 5 most recent qualifying entry `id` values (newest first by timestamp prefix of id)
- `repo` = most common repo value among the qualifying entries (falls back to `"unknown"`)
- `target_kind` = most common `target_kind` among the qualifying entries (falls back to `"skill"`)
- `target_path` = `target_path` from the most recent qualifying entry (falls back to empty string)

---

## Step 3: Read Existing pattern-flags.json

Check whether the flags file already exists:

```bash
cat ~/.claude/build-loop/pattern-flags.json 2>/dev/null
```

- If the file exists and parses as JSON: load its `flags` array into memory as `existingFlags`.
- If the file does not exist OR fails to parse: start with `existingFlags = []` and treat this as the first-ever run.

**Apply the same read-time mapping to every loaded flag that Step 1 applies to queue entries.** A flags file written before schema v5 stores the identifier under `skill`, not `target`, so a flag read without this mapping has no `target` at all, fails to match in Step 4, and gets appended a second time. That breaks the one-entry-per-target rule below and splits the history the file exists to hold.

For each entry in `existingFlags`:

- Missing `target` → read `skill` instead
- Missing `target_path` → read `skill_path` instead
- Missing `target_kind` → treat as `"skill"`
- Missing `occurrence_count` → read `session_count` instead. A flags file written
  before 0.9.6 stores the number under the old name. It counted the same thing
  those files were counting at the time, so the value carries over unchanged and
  only the label is wrong. Read it, and Step 5 writes it back under the new name.

Do this in memory only. The file is not rewritten here. Step 5 writes every flag back under the v5 names, which converts the file as a side effect of the next normal run, so no separate migration ever has to be run and none can half-finish.

**Matching in Step 4 is on the mapped `target` value.** Never match on the raw field as it appeared in the file.

Preserve the structure otherwise — do not re-format it. Do not silently drop unknown fields (future-compatible). Only rewrite the fields this skill owns.

---

## Step 4: Merge New Flags with Existing

For each target in `flaggedTargets` from Step 2:

**Case A — No existing flag for this target (first-time flag):**

Before concluding this is a first-time flag, confirm the Step 3 mapping was applied. An entry written before v5 carries its name under `skill`, and comparing against `target` on an unmapped entry always reports "not found" and always creates a duplicate. If any loaded flag has a `skill` field and no `target`, the mapping was skipped: go back to Step 3.

Create a new flag entry:

```json
{
  "target": "<target-name>",
  "target_kind": "<target_kind>",
  "repo": "<repo>",
  "target_path": "<target_path>",
  "flagged_at": "<ISO-8601 UTC now>",
  "correction_count": <count>,
  "occurrence_count": <count>,
  "status": "pending-review",
  "diagnosis": "<generated in Step 2d>",
  "example_entries": [<up to 5 ids>],
  "notes": []
}
```

Append to the flags array. `status` is always `"pending-review"` on creation — PATT-03 gate.

**Case B — Existing flag for this target with status NOT `"resolved"`:**
Update the existing flag entry in place:
- `correction_count` → new count from Step 2d
- `occurrence_count` → new count from Step 2d
- `diagnosis` → regenerated string from Step 2d (only regenerate if correction_count has increased since last run; otherwise leave unchanged)
- `example_entries` → merge new ids into existing list, keep most recent 5 (dedup by id)

**Preserve on update (never overwrite):**
- `flagged_at` (original flag timestamp — never changes)
- `status` (if it's `"in-review"`, do NOT reset to `"pending-review"` — preserve manual state)
- `notes[]` (append-only, owned by the maintainer and the user for co-dev notes)

**Case C — Existing flag for this target with status `"resolved"`:**
Leave the flag entry exactly as-is. Resolved flags are archived records. Do not re-flag a resolved target even if new corrections appear — that is the maintainer's decision to reopen, not this skill's.

**One entry per target, forever.** Never append a second entry for a target that already has one. All updates are in-place. The most likely way to break this is a field-name mismatch rather than a logic error, so if a run ever produces two entries naming the same thing, the mapping in Step 3 is where to look first.

---

## Step 5: Write pattern-flags.json (Atomic)

Use the Phase 2 atomic write pattern. This is REQUIRED — do not skip. Partial writes must be impossible, even if Claude is interrupted mid-step.

The pattern: write to a `.tmp` file, parse-check it, then `mv` to the final path. `mv` is atomic on macOS within the same filesystem.

**Procedure:**

1. Prepare the final JSON object:

```json
{
  "$schema_version": 3,
  "last_updated": "<ISO-8601 UTC now>",
  "flags": [<merged flags array from Step 4>]
}
```

2. Use the Write tool to write the pretty-printed JSON (2-space indent) to `~/.claude/build-loop/pattern-flags.json.tmp`.

3. Parse-check the .tmp file by running:

```bash
node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/build-loop/pattern-flags.json.tmp', 'utf8'))" && echo "PARSE_OK"
```

If the parse-check fails (no `PARSE_OK` output OR node returns non-zero), STOP. Do NOT proceed to the swap. Print the error to the session and exit the skill. The existing pattern-flags.json (if any) is untouched — the system is in a safe state.

4. Atomically swap the .tmp file into place:

```bash
mv ~/.claude/build-loop/pattern-flags.json.tmp ~/.claude/build-loop/pattern-flags.json
```

After this `mv`, the file is updated. The .tmp file no longer exists.

**Empty flags case:** If no targets met the threshold (empty flags array), STILL write the file with `"flags": []`. This confirms detection ran and produced no flags — absence of file would be ambiguous.

---

## Step 6: Output Detection Results

Print the following to the session output. Steps 7-10 below read these results.

```
Pattern detection complete.
- Closed primary corrections found: <N>
- Targets evaluated: <N>
- Malformed queue entries skipped: <N>
- New pattern flags created: <N>
- Existing flags updated: <N>
- Resolved flags left untouched: <N>

Flagged targets:
- <target-1> - <occurrence_count> occasions, status: <status>
- <target-2> - <occurrence_count> occasions, status: <status>
...
```

**Special-case outputs:**
- If no closed primary corrections exist in the queue: print `No closed corrections found — pattern detection complete, no flags.` Still write pattern-flags.json with an empty flags array.
- If all flagged targets were already flagged and no new ones appeared: print `No new pattern flags this run. <N> existing flags updated.`
- If the .tmp parse-check failed in Step 5: print the error and note that pattern-flags.json was NOT updated.

---

## Step 6b: Pushback Rate

Steps 1 to 6 read the bug queue, which records what the user noticed and took the
trouble to log. This step reads the other half: the times an answer did not land
and they said so in the conversation. Nothing has to be captured live, because
Claude Code transcripts are already on disk.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pushback.js" --this-week
```

`--this-week` starts at Monday 00:00 in the machine's local timezone. That is
the same local calendar week used to name the summary file, so every section
describes one period and consecutive reports neither overlap nor leave a gap.

It prints one headline number, pushbacks per hundred messages the user actually
typed, then a breakdown by kind and the answer-level signal comparison. It does
not print example messages unless `--quotes` is explicitly added.

If the command says the transcript folder does not exist or cannot be read,
write `Pushback rate unavailable: this runtime has no readable Claude Code
transcripts.` in the section and continue building the rest of the weekly
report. This is expected in Codex and on a fresh machine. Never turn absence of
input into a zero. If the command instead reports an incomplete scan, keep its
warning in the report; the readable conversations still produce a useful rate.

The saved report carries counts, not quotes. If the user wants the examples,
run the same command with `--quotes` and show that output only in the current
local session. Do not copy those examples into the summary file: the session
plugin reads that file into future session briefs, where the examples would use
the brief's limited space and persist private transcript text beyond this run.

**The rate is the whole point.** A writing rule that does not move it is not
working, and adding more rules to the skill will not change a flat line. Report
the number first and the breakdown second. Baseline measured by hand on
2026-08-16 over the preceding 36 hours: **15.4 per hundred**, against 5.4 per
hundred across the 2,445 messages before that window.

**Those two figures are not a like-for-like comparison and must not be presented
as one.** The detector's patterns were written from the 36-hour window, so it
finds more there by construction. What is comparable is one ISO week against
another from now on, because the detector no longer changes between them and
each report starts at Monday 00:00 in the machine's local timezone. Say so if
you quote both.

**State the floor.** The count only includes times the user said something. Giving
up and working around an answer leaves no trace, so every figure is a lower bound.
The script prints this line itself; do not delete it when summarising.

**Accuracy.** The detector is measured against a labelled set of the user's own
messages, which lives at `~/.claude/build-loop/pushback-fixture.json` and stays
off this public repository. Check it with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pushback.js" --selftest
```

If that reports a catch rate below about 90 per cent, the patterns have drifted
from how the user actually writes and the weekly number is understating things.
That is worth a queue entry against `pushback.js` rather than a silent shrug.
The suite in `tests/pushback.test.js` proves the script is wired up correctly and
deliberately does **not** prove it is accurate, because a public repository is the
wrong place for somebody's unguarded messages.

**When a kind crosses three occurrences in a week**, treat it exactly like a
structural pattern flag from Step 2: surface it, do not fix it silently, and
suggest a queue entry against the skill that is supposed to prevent it, which is
`say-it-simply` in the `slop-check` plugin. That is how a conversational pattern
becomes a tracked defect rather than a note nobody reads.

---

## Step 7: Generate Summary Report Content

Using the queue entries loaded in Step 1 and the detection results from Steps 2-6b, build the weekly summary report. The report covers the current ISO week — use the ISO week computation below to determine which entries are "this week" vs older.

**Compute the ISO week filename** using this exact logic (from 04-RESEARCH.md Pattern 5 — do NOT use calendar year/week, it produces wrong filenames at year boundaries):

```bash
node -e "
const d = new Date();
const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
const day = utc.getUTCDay() || 7;
utc.setUTCDate(utc.getUTCDate() + 4 - day);
const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
console.log(utc.getUTCFullYear() + '-' + String(week).padStart(2, '0'));
"
```

This outputs `YYYY-WW` (e.g. `2026-17`). The summary filename is `{YYYY-WW}.md`.

**"This week" definition:** An entry is "this week" if its `id` timestamp (for example, `"2026-04-24T..."`) falls within the machine's current local ISO week, from Monday 00:00 local time through now. Entries outside this window still appear in the "Still Open" section if their status is `"Open"`, but are NOT listed as "Fixed This Week."

**Build the report content** in this order (Pattern Flags FIRST — front-loading rule from 04-DESIGN.md Section 6):

```markdown
# Build Loop: Week {WW}, {YYYY}

**Generated:** {YYYY-MM-DD}

## Pattern Flags

### New This Week
- **{target}** ({repo}, {N} corrections on {M} separate occasions): {diagnosis} [status: pending-review]

### Previously Flagged: Still Open
- **{target}** ({repo}, {N} corrections, status: {status}): {diagnosis}

### Resolved
- **{target}**: Structural fix applied {date}.

## Fixes Applied This Week

- `{target}` ({repo}): {one-line summary from what_happened} [queue:{entry-id}]

## Still Open

- `{target}` ({repo}): {what_happened truncated to ~80 chars} (logged {YYYY-MM-DD from id})

## Queue Summary

- {N} items resolved this week
- {M} items still open (total)
- {K} new pattern flags / {L} flags updated
- {J} targets with pending structural review

## No Action Needed

{N} targets had no corrections this week.

## Pushback Rate

{Counts-only output from Step 6b, including the headline rate, breakdown, signal
comparison, and floor statement. Never include quoted examples in this file.}
```

**Section rules:**
- **If no pattern flags exist at all:** OMIT the entire `## Pattern Flags` section. Do not write a section with "None."
- **If no fixes this week:** Keep the `## Fixes Applied This Week` heading, write `No fixes applied this week.` beneath it.
- **If no open items:** Keep the `## Still Open` heading, write `No open items in the queue.` beneath it.
- **One entry per resolved queue item** under Fixes Applied — never combine multiple fixes for the same target into one line.
- **Still Open** lists ALL status:`"Open"` entries regardless of week, sorted alphabetically by target name.

---

## Step 8: Write Summary File

Write the report from Step 7 to `~/.claude/build-loop/summaries/{YYYY-WW}.md` using the Write tool.

- If the directory doesn't exist, create it first: `mkdir -p ~/.claude/build-loop/summaries`
- If a file for this week already exists (same filename), OVERWRITE it — this lets you re-run the summary mid-week if the queue was updated.
- Use the Write tool directly (not Edit) — this is a full-file write and atomicity comes from the OS-level write.

After writing, print:

```
Summary written to ~/.claude/build-loop/summaries/{YYYY-WW}.md
```

---

## Step 9: Optional Slack Post

Ask the user directly:

```
Post this summary to Slack?
- yes → which channel? (default: your DM)
- no → summary saved locally only
```

**Wait for them response.** Do NOT post without explicit confirmation. Do NOT hardcode a channel.

**If yes:**
1. Ask for channel if they didn't specify one. Default: the user's DM.
2. Build a channel-safe copy of the full report as described under **Pushback quotes never go to Slack** below. Post that copy with the Slack MCP (`mcp__slack__*` tools — already configured in sessions). Never post the `.md` file verbatim because its Pushback Rate section contains private quotes.
3. Confirm: `Posted to {channel}.`

**If no:**
Confirm: `Summary saved locally. Not posted to Slack.`

**Channel safety:** the user's DM is the safe default per 04-DESIGN.md Section 9. For a public channel, confirm the channel name back to them before posting — "Posting to #{channel-name}, correct?" — and wait for confirmation.

**Pushback quotes never go to Slack.** The Step 6b section of the local report
quotes the user's own messages when it is asked to, which is what makes a
pattern actionable when they read it themselves. Those same lines are somebody's
unguarded words about being confused and frustrated, and a channel is a
different audience from a file on their own Mac, whatever the channel is.
Recompute the boundary and regenerate that section for the post with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pushback.js" --this-week
```

This recomputes the local week boundary in the posting step, emits the rate and
counts and no quotes. Substitute it for the local Step 6b
section before posting. If this command fails, stop and report the failure;
never fall back to quoted output. This applies to the direct message too: the
rule is about the surface, not about who can see it.

**Quoting is opt-in, and there is no flag to get wrong.** The script only quotes
when `--quotes` is passed, and refuses any argument it does not recognise rather
than ignoring it. So a typo, a wrong flag, or a half-remembered option produces
counts or an error, never the quotes. An earlier version had this the other way
round, with quoting on by default and one string comparison guarding it, and
three different spellings got past it in a single review. **Never add `--quotes`
to a command whose output is going anywhere but the user's own screen.**

---

## Step 10: Update hot-cache.md

Append a one-line status to `~/.claude/hot-cache.md` so session-start context has a fresh pointer to the latest summary.

Use this append pattern:

```bash
echo "Build Loop week {YYYY-WW}: {N} fixes applied, {M} open, {K} pattern flags. See ~/.claude/build-loop/summaries/{YYYY-WW}.md" >> ~/.claude/hot-cache.md
```

Substitute the actual counts and filename from Steps 6-8.

After appending, print: `hot-cache.md updated.`

**Note:** hot-cache.md is an append-only log. Do not edit or remove prior entries — they are the user's session memory trail.

---

## Notes

- **PATT-03 gate (non-negotiable):** Never auto-apply structural fixes from pattern flags. Flags are information for the maintainer co-development review. `"pending-review"` status means no automatic action is taken. Status transitions (`pending-review` → `in-review` → `resolved`) are made manually by the maintainer and the user, not by this skill.
- **Empty queue:** If no .json files exist in `~/.claude/build-loop/queue/`, that's fine — write pattern-flags.json with empty flags array, write the summary with "No fixes applied this week" / "No open items in the queue", and continue through Steps 9-10 normally.
- **Malformed queue entries:** Skip silently. Count them. Note the count in Step 6 output. Never throw.
- **Counting safety:** The `source`-driven token in Step 2b is the only dedup rule. Do not introduce additional dedup (e.g., by what_happened similarity). The design deliberately counts each `/flag-issue` entry as its own data point, and anything layered on top takes that away again.
- **Update in place only:** There must never be two flag entries for the same target. If Step 4 ever tries to append when an entry already exists, that is a bug — fix it and re-run.
- **Atomic write is non-optional here.** `pattern-flags.json` is not a queue entry, so it uses the `.tmp` plus parse-check plus `mv` pattern. Queue and to-build writes do not: they go through `scripts/queue.js`, which does the read, the check and the write under one lock. `flag-issue` used to be named here as the exception, on the grounds that creating an entry has no existing file to lose. Its header no longer says that, because the dedup check and the write were the part that needed the lock. Never use a direct single-step write to pattern-flags.json.
- **Slack is never hardcoded:** Channel is asked at post time. The user's DM is the default. Never assume a channel.
- **ISO week (not calendar week):** The filename logic uses the Thursday-anchor ISO 8601 method. At year boundaries (late December / early January) the ISO year can differ from the calendar year — always trust the ISO computation, not `new Date().getFullYear()`.
- **Front-loading is intentional:** Pattern Flags appears BEFORE Fixes Applied and Still Open in the summary file. The session-start hook (SUMM-04, Plan 04-04) truncates at 2,000 chars and truncation cuts the tail. New patterns and critical opens must appear in the first ~800 characters.

---

## What Plan 04-04 Adds (not yet implemented)

Plan 04-04 will add:
- Session-start hook extension (SUMM-04) that reads the most recent `summaries/YYYY-WW.md` and surfaces it in new sessions (2,000-char budget, 14-day staleness cutoff, silent try/catch so it never blocks session start)

A local `launchd` plist named `build-loop-weekly` that runs this skill automatically is created in Plan 04-03 alongside these Steps 7-10. (Earlier planning called for Claude Desktop's "New Task" UI — that approach was retired because it runs in Cowork and cannot access local paths. See Runtime Requirements at the top of this file.)
