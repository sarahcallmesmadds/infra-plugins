# Build Loop Queue Entry Schema

## Purpose

This document is the single source of truth for the bug queue entry format. Every skill in the build loop reads from and writes to this schema. When adding fields, bump `$schema_version` and update this document in the same commit.

The to-build list is a separate store with its own schema. See `SCHEMA-BUILD.md`.

---

## What a queue entry can be about

A queue entry records that something you built did the wrong thing. That something is not always a skill. It can be any of these, recorded in `target_kind`:

| `target_kind` | What it means | How its path is found |
|---|---|---|
| `skill` | A skill with a `SKILL.md` | By convention, in a root of kind `skill` |
| `hook` | A hook script fired by the harness | By convention, in a root of kind `hook` |
| `command` | A slash command file | By convention, in a root of kind `command` |
| `plugin` | A whole plugin, where the fault is not in one file | No convention. The user supplies the path. |
| `script` | A loose script anywhere on disk | No convention. The user supplies the path. |
| `other` | Anything else | No convention to guess from. The path comes from the user, or from a path named in the entry's own text. |

The first three resolve automatically. The last three always ask, because there is no layout to guess from and a guessed path sends a commit to the wrong repository. "No convention" means there is no layout to guess from, not that a path is unreachable: a path written into the entry's own text is one the author already supplied, and `/built-check` Step 3b uses exactly that when looking for disk evidence on an item of kind `other`.

---

## Roots configuration

Roots live at `~/.claude/build-loop.config.json`. With no config file, these three defaults apply:

```json
{
  "roots": [
    { "name": "personal", "path": "~/.claude/skills",   "kind": "skill" },
    { "name": "hooks",    "path": "~/.claude/hooks",    "kind": "hook" },
    { "name": "commands", "path": "~/.claude/commands", "kind": "command" }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Recorded as `repo` on every entry. Decides which repository a fix is committed to. |
| `path` | yes | Absolute path, or `~`-prefixed. Expand `~` before use. |
| `kind` | yes | One of `skill`, `hook`, `command`, `plugin-repo`. Sets the lookup convention below. |

**Lookup convention by kind**, tried in root order, first hit wins:

- `skill`: `<path>/<target>/SKILL.md`, then `<path>/<target>/skill/SKILL.md`
- `hook`: `<path>/<target>`, then `<path>/<target>.*`
- `command`: `<path>/<target>.md`
- `plugin-repo`: see below

### The `plugin-repo` kind

A root of kind `plugin-repo` is a checkout of a plugin marketplace repository,
where things are nested one level deeper than the flat layouts above:

```
<path>/plugins/<plugin>/skills/<target>/SKILL.md
<path>/plugins/<plugin>/hooks/<target>            (also <target>.*)
<path>/plugins/<plugin>/commands/<target>.md
<path>/plugins/<target>/                          (the plugin itself)
```

Search all four, in that order, first hit wins. **`target_kind` comes from
which subdirectory matched**, not from the root: a hit under `skills/` is a
`skill`, a hit under `hooks/` is a `hook`, a hit under `commands/` is a
`command`, and a directory directly under `plugins/` is a `plugin`.

This kind exists because installing from a marketplace and developing in a
checkout are different things. The installed copy under
`~/.claude/plugins/marketplaces/` is a cache that the plugin manager overwrites,
so a fix committed there is lost on the next update. Point the root at the
checkout you actually edit, never at the installed copy.

**Backward compatibility.** A config containing `skillRoots` and no `roots` is read as roots of kind `skill`, one per entry. Do not rewrite the file. This is what every config written before schema v5 looks like.

A target found under no root is recorded as `repo: "unknown"`, and nothing will commit a fix for it until that is resolved by hand.

### When a root does not exist

The three defaults are the standard locations, and on a machine where
everything is installed from marketplaces rather than written by hand, none of
them will exist. That is not an error, but it does mean nothing resolves
automatically and every capture will stop to ask for a path.

A root named in a config the user wrote is a different matter: that path was
chosen, so its being absent is worth saying out loud.

**This file does not describe what a skill says about either case.**
`scripts/roots.js` owns that wording, and every skill that reads the config
calls it and relays what it prints. Run `roots.js --help` for the exit codes.

The sentence used to be written out here and again in three of the six skills,
which is four copies of one rule with no way to tell which was in force. Three
of the six never had it at all, and that gap stayed invisible until a root moved
on 2026-08-01 and nothing said so.

---

## File Location Convention

One JSON file per queue entry, stored at:

```
~/.claude/build-loop/queue/{timestamp}-{target-slug}.json
```

- Filename stem MUST equal the `id` field exactly.
- Timestamp format: `YYYY-MM-DDTHH-MM-SS`, with colons replaced by dashes so it is safe on every filesystem.
- Example: `2026-04-23T14-30-00-daily-brief.json`

---

## Example Entry (v5 primary, a skill)

```json
{
  "$schema_version": 5,
  "id": "2026-04-23T14-30-00-daily-brief",
  "created_at": "2026-04-23T14:30:00.000Z",
  "status": "Open",
  "type": "primary",
  "parent_id": null,
  "target": "daily-brief",
  "target_kind": "skill",
  "target_path": "~/.claude/skills/daily-brief/SKILL.md",
  "repo": "personal",
  "session_id": "00dc3f8e-941c-...",
  "session_cwd": "~/projects/example",
  "what_happened": "Daily brief listed 22 accounts in the Revenue section one by one instead of synthesizing themes.",
  "what_expected": "The Revenue section should group by insight or theme, never per-account lists.",
  "correct_example": "Late-stage: Omaha, New Era moving to proposal. Early pipe: Sephora, Scotts.",
  "source": "slash-capture",
  "urgency_hint": "normal",
  "dedup_key": "daily-brief::per-account-lists-in-revenue",
  "notes": [],
  "resolution": null
}
```

## Example Entry (v5 primary, a hook)

```json
{
  "$schema_version": 5,
  "id": "2026-07-27T09-14-02-style-lint",
  "created_at": "2026-07-27T09:14:02.000Z",
  "status": "Open",
  "type": "primary",
  "parent_id": null,
  "target": "style-lint",
  "target_kind": "hook",
  "target_path": "~/.claude/hooks/style-lint.js",
  "repo": "hooks",
  "session_id": "b41e07c2-5d38-4a91-9f6e-2c7a0d5813be",
  "session_cwd": "/Users/example/Projects/infra-plugins",
  "what_happened": "The style hook counted the dashes inside a Markdown table separator as em dashes and blocked the response.",
  "what_expected": "Table row separators should not count as prose punctuation.",
  "correct_example": "A table whose separator row is three dashes passes with no finding.",
  "source": "slash-capture",
  "urgency_hint": "normal",
  "dedup_key": "style-lint::counted-table-separators-as-em-dashe",
  "notes": [],
  "resolution": null
}
```

---

## Example: dep-review entry (v5)

```json
{
  "$schema_version": 5,
  "id": "2026-04-23T14-30-00-dep-review-wrap",
  "created_at": "2026-04-23T14:30:00.000Z",
  "status": "Open",
  "type": "dep-review",
  "parent_id": "2026-04-23T14-30-00-capture",
  "target": "wrap",
  "target_kind": "skill",
  "target_path": "~/.claude/skills/wrap/SKILL.md",
  "repo": "personal",
  "session_id": "00dc3f8e-941c-...",
  "session_cwd": "~/projects/example",
  "what_happened": "Review: wrap may be affected by the fix to capture. Reason: wrap invokes /capture when pausing work.",
  "what_expected": "(not applicable, this is a dependency review)",
  "correct_example": "(not applicable)",
  "source": "dep-review-auto",
  "urgency_hint": "normal",
  "dedup_key": "dep-review::wrap::2026-04-23T14-30-00-capture",
  "notes": [],
  "resolution": null
}
```

---

## Field Reference

| Field | Type | Required | Description | Notes |
|-------|------|----------|-------------|-------|
| `$schema_version` | int | yes | Schema version number. Bump when any field is added, renamed, or removed. | Current version is 5. |
| `id` | string | yes | Unique identifier. Must match the filename stem exactly. | Format: `YYYY-MM-DDTHH-MM-SS-{target-slug}` |
| `created_at` | string | yes | ISO-8601 timestamp with timezone. | Example: `2026-04-23T14:30:00.000Z` |
| `status` | string | yes | Lifecycle state of this correction. One of six values, see Status Enum below. | Changes in place. Never delete entries, change their status instead. |
| `type` | string | yes | Which kind of queue entry this is. | `"primary"` or `"dep-review"`. A reader that finds no `type` treats the entry as `"primary"`. Do NOT rewrite existing entries. |
| `parent_id` | string or null | yes | For dep-review entries, the id of the primary entry that triggered this review. Null for primary entries. | Lets a fix close its dep-reviews when the primary is resolved. |
| `target` | string | yes | The name of the thing being corrected. No path, no extension. | Example: `daily-brief`, `style-lint`. Called `skill` before v5. |
| `target_kind` | string | yes | What sort of thing the target is. | `skill`, `hook`, `command`, `plugin`, `script`, `other`. A reader that finds no `target_kind` treats it as `"skill"`. |
| `target_path` | string | yes | Absolute path to the file a fix would edit. Used to route the commit to the right repository. | Example: `~/.claude/hooks/style-lint.js`. Called `skill_path` before v5. |
| `repo` | string | yes | Which root owns this target. Inferred from `target_path`, see Repo Attribution Rule below. | A root `name`, or `"unknown"` |
| `session_id` | string | yes | Claude Code session ID. The only route from an entry back to the conversation that produced it. | Resolve it from the scratchpad directory path, `.../{project-slug}/{session-id}/scratchpad`, and confirm it against `~/.claude/projects/*/{session_id}.jsonl`. Fill `""` only when that fails. |
| `session_cwd` | string | yes | Working directory when the correction was captured. | Fill `""` if not available. |
| `what_happened` | string | yes | Plain-language description of the wrong behaviour. | Write as: "It did X." |
| `what_expected` | string | yes | Plain-language description of the correct behaviour. | Write as: "It should do Y." |
| `correct_example` | string | yes | A concrete example of what correct output would look like. | Quote the user's words when available. A rough example is fine. |
| `source` | string | yes | Which entry point created this record. | `"stop-hook"`, `"slash-capture"`, `"manual"`, `"dep-review-auto"` |
| `urgency_hint` | string | yes | Urgency signal for queue sorting. | `"normal"`, `"high"`, `"low"`. Default is `"normal"`. |
| `dedup_key` | string | yes | Deduplication key. See Dedup Key Rule below. | Format: `"{target}::{slug(what_happened[:40])}"` |
| `notes` | array | no | Array of `{ts, text}` objects. Append-only. `/apply-fix` appends a note holding the commit hash after every successful commit. | Used for follow-up observations after capture. |
| `resolution` | object or null | no | Null until the entry is closed. Then what closing it meant. See Resolution below. | Written by whichever skill closes the entry. Readers use `scripts/resolution.js`, never the raw field. |

---

## Reading pre-v5 entries

Entries written before v5 use `skill` and `skill_path` and have no `target_kind`. Every reader applies this mapping at read time and never rewrites the file:

| Old field | Read as | Rule |
|---|---|---|
| `skill` | `target` | Use `target` if present, else `skill` |
| `skill_path` | `target_path` | Use `target_path` if present, else `skill_path` |
| (absent) | `target_kind` | Default to `"skill"` |

The reason for read-time mapping rather than a migration script: a migration that half-runs leaves a queue in two formats with no way to tell which entries were converted. Reading both shapes forever costs three lines per reader and cannot half-run.

Writers always emit the v5 field names. An old entry that gets its status updated is rewritten in full by the writer that touched it, which converts it as a side effect. That is fine, and it is the only time an old entry changes shape.

---

## Resolution

`status` says an entry is closed. `resolution` says what closing it meant, and
those are different questions. Two of the answers cannot be expressed as a
status at all: an entry that duplicates another, and one that stopped being
relevant without anybody deciding against it. Both would read as `Won't Fix`,
which this document defines as "the user explicitly deferred or declined", and
neither of them is that.

```json
"resolution": {
  "outcome": "fix_applied",
  "at": "2026-08-05T12:00:00.000Z",
  "by": "user",
  "commit": "abc1234",
  "duplicate_of": null,
  "summary": "The guard reads the event cwd, so a bare commit is judged against the right repository."
}
```

| Field | Required | Meaning |
|---|---|---|
| `outcome` | yes | One of the five below. |
| `at` | yes | ISO-8601, when it was closed. |
| `summary` | yes | Plain language. An outcome says what happened and never why, and why is the part nobody can reconstruct six weeks later. |
| `by` | no | Who confirmed it. `"user"`, or the skill that closed it. |
| `commit` | no | The commit, when there was one. A fix can land without one. |
| `duplicate_of` | only when the outcome is `duplicate` | The id of the entry holding the discussion. |

`by`, `commit` and `duplicate_of` must be non-empty strings when present. The
reader drops anything else, so a write that set `duplicate_of` to a number was
accepted and then read back as nothing, losing the link that outcome exists for.

A resolution cannot be erased once written. Clearing it is a deletion rather
than an edit, and this queue never deletes: to reopen an entry change its
status, and the resolution stays as the record of the earlier close. Writing a
different valid resolution over it is allowed.

**Closing an entry writes one.** A write that moves an entry into `Resolved` or
`Won't Fix` is refused unless the entry ends up carrying a resolution that reads
back with an outcome, and the two have to be written in the same call. Until
this, `--status Resolved` on an entry whose resolution was null changed no
resolution, so the shape check never ran and the entry closed saying nothing
about what closing it meant.

Two things this deliberately does not cover. An entry **already** closed keeps
whatever it has: it can still be annotated, and a misspelt status on it can
still be repaired, because `Wontfix` to `Won't Fix` is not a closing act and
refusing it would break the fix `lint` prints. And the check reads the
resolution rather than validating it, so the older shapes below can close an
entry that has been reopened even though they satisfy none of the writer's
rules.

### The status and the outcome have to agree

They answer different questions, which is why both exist, and that is not the
same as being independent. An entry cannot be `Resolved`, a fix applied and
verified, while also recording that the correction was declined. Both fields
were individually valid, so both directions of that used to pass.

| Status | Outcomes it can carry |
|---|---|
| `Resolved` | `fix_applied`, `no_change_needed` |
| `Won't Fix` | `wont_fix`, `duplicate`, `obsolete` |

Checked whenever a write changes either field, and only for those two statuses.
`Open`, `In Progress` and `fix applied, watching` are not closures, so an entry
sitting on one of them carries the resolution of an earlier close saying
anything at all. That is what reopening leaves behind, and it is a record rather
than a contradiction.

### Outcome enum

| Outcome | Meaning |
|---|---|
| `fix_applied` | A change was made and it addressed the correction. |
| `no_change_needed` | Looked at, and nothing needed changing. The usual answer for a dep-review. |
| `wont_fix` | Declined on purpose. |
| `duplicate` | The same thing as another entry. `duplicate_of` names it. |
| `obsolete` | Stopped being relevant. Nobody decided against it. |

`duplicate` is the one that earns its place. Without it a duplicate can only be
dropped, which loses the link between the two entries, so the same thing gets
captured a third time with nothing pointing at the earlier discussion.

**This is enforced, in `writeEntry`**, the same single gate as the status enum
and for the same reason: guarding the call sites means guarding four routes and
missing the fifth. Only a write that *changes* the field is checked, so the
nineteen entries written before this can still be annotated.

### Reading a resolution written before this

The field was never a string in practice, whatever the row above used to say.
Three shapes exist in the real queue and all three are still read:

| Shape | Where it came from |
|---|---|
| `{commit, fixed_at, pr, shipped_in, summary}` | Resolved primaries. No outcome, because the vocabulary did not exist. This exact five-key legacy shape reads as `fix_applied`; current status is deliberately irrelevant because reopening must not change the historical answer. A later object carrying only a commit does not get the inference, because a `Won't Fix` entry may record the commit that rolled a fix back. |
| `{commit, outcome, ts, why}` | Resolved dep-reviews, outcome `"no change needed"`. |
| `{outcome, ts, why}` | `Won't Fix` primaries, outcomes `"wontfix"` and `"obsolete"`. |

`ts` and `fixed_at` read as `at`. `why` reads as `summary`. The old outcome
spellings map to the enum. All of these are refused on write, the same pairing
as the outcome words: readers keep taking what is on disk while writers are
pushed to one vocabulary.

**Anything the reader does not carry into its result is kept under `extra`,
under its own name.** That covers three cases, and the first is the one it was
built for:

- A key nothing knows about, such as the `pr` and `shipped_in` on the twelve.
- An outcome that was stated and is not one of the five. `outcome` comes back
  `null` and the word somebody wrote is at `extra.outcome`. Null answers "which
  of the five is this" and is not an answer to "what did somebody write".
- A key written under two names, or written with the wrong type. `{at, ts}`
  returns the `at` and keeps the `ts`, and a hand-written `commit: true` returns
  `commit: null` and keeps the `true`. Both used to vanish, and because they are
  known keys they did not reach `extra` either.

An absent key, an explicit `null` and an empty string are all nothing to keep,
so the `"duplicate_of": null` on every resolution that is not a duplicate does
not fill `extra` with nulls.

Nothing rewrites these. That is the same rule the pre-v5 `skill` and
`skill_path` fields follow: a migration that half-runs leaves a queue in two
formats with no way to tell which entries were converted, while reading every
shape forever costs one function and cannot half-run.

**Read through `scripts/resolution.js`, never the raw field.** A reader that
looks at `resolution.outcome` directly sees `null` on twelve of the nineteen
entries that have one.


## Status Enum

| Status | Meaning |
|--------|---------|
| `Open` | Newly captured, not yet attempted. The default for all new entries. |
| `In Progress` | `/apply-fix` is actively working on this correction. |
| `Resolved` | Fix applied AND verified. |
| `Won't Fix` | The user explicitly deferred or declined this correction. |
| `fix applied, watching` | The fix reached the target file and is not yet confirmed in a real session. The user closes this to `Resolved` after using the thing. **This does not imply a commit.** See the note markers below. |
| `fix attempted / unresolved` | **Retired in 0.3.1. Do not write this.** Readers still accept it, because entries written earlier carry it. A rejected diff or a failed write now leaves the entry `Open` and records the attempt in `notes`. The status was removed rather than added to `/list-bugs`, because it described a bug that was still open while making it invisible to every filter that lists open work. |

**This enum is enforced, as of 0.5.6.** `queue.js` checks the status inside
`writeEntry`, which every write passes through, so no option can route around it.
That includes `--status`, `--field status=`, `--json status=FILE` and the
composed file handed to `create`.

The check was first written at those call sites instead, and review found the
fourth one, `--json`, unguarded: it assigns a parsed value straight onto the
entry. Guarding each way in is a list that has to be extended by whoever adds the
next option, and the claim "every path is covered" was already wrong when it was
written. One gate at the write is the version that stays true.

A status must also be a string. Only `--json` can express anything else, and an
object reported as an unrecognised status would name the wrong fault.

It refuses rather than corrects, even when the value is one character off,
because guessing what somebody meant and writing it is how a wrong status
arrives without anyone deciding to put it there. The suggestion is printed and
the write is still refused.

`fix attempted / unresolved` is refused on write and accepted on read, which is
what the row below has always said.

`queue.js lint` reports entries already on disk carrying a value no reader
matches, and exits 3 when it finds one. Enforcing writes does nothing about what
is already stored: the two entries that prompted this carried `Wontfix` for four
days, and no filter in `/list-bugs` would have shown them.


### Note markers on `fix applied, watching`

Three skills write this status and it reaches the same place by more than one route, so
the status alone cannot say whether a commit exists. A note prefix carries that, and
readers must branch on the prefix rather than on whether a hash happens to be present.

| Prefix | Written by | Means |
|--------|-----------|-------|
| `Committed:` | `/apply-fix` Step 8 | A commit exists. Format `Committed: {hash} to {repo}`. `/revert-fix` parses the hash out of this. |
| `Not committed:` | `/apply-fix` Step 8 | The file was written and there was nowhere to commit it. Format `Not committed: written to {target_path}, {repo} is not a git repository`. Nothing to revert and no diff to show. |
| neither | `/verify-fix` Step S4 standalone PASS | Promoted from `In Progress` on the user's say-so, with no commit either way. The reason is genuinely unknown. |

**The last marker wins.** Notes are append-only, so one entry can carry both. That
happens on a real path: `/apply-fix` writes `Not committed:` because the root was not a
git repository, the user runs `git init` and reopens the entry, and a second run appends
`Committed:`. Read the markers in note order and use the most recently appended one.
Anything else refuses to revert a commit that exists, because `Not committed:` is the
older record of a state that has since changed.

Most-recent is the rule rather than "prefer `Committed:`" because the reverse sequence
is also real: a fix committed once, reverted, then re-applied somewhere without a
repository. The newest marker is the only one that describes the file as it is now.

**Absence of a hash does not identify the reason.** A reader that treats every hashless
entry as the no-repository case will tell someone their repository is not a git
repository when it is, because the standalone verify path produces hashless entries
too.

Every place that reads these markers has to handle all three of the cases above. The
places that read them:

- `/verify-fix` Step S1, choosing what to say and whether to offer a diff
- `/verify-fix` Step S3, deciding whether to name a commit for a `plugin`-kind entry. Hash presence is not the test: an entry committed once and later re-applied into a root with no repository carries an old `Committed:` hash under a newer `Not committed:`, and printing that hash describes a state the file has left.
- `/verify-fix` Step V4, choosing the `{file_state}` row written into the failure note. Getting this one wrong puts a false audit trail on the record someone reads when something has gone wrong. Pick by status first: an `In Progress` entry may never have been written at all.
- `/revert-fix` Step 1, labelling **every** candidate list it shows, both the multi-match one and the empty-argument one, so a refusal comes before the choice rather than after it
- `/revert-fix` Step 3, deciding whether there is a commit to find

A local commit is also not a pushed one. `/apply-fix` never pushes, by deliberate
decision, so an entry at this status with a `Committed:` note may still exist only on
one machine. Its closing summary says so explicitly, because no status can.

---

## Type Enum

| Type | Meaning |
|------|---------|
| `primary` | A directly-captured correction. The user invoked `/flag-issue` or the Stop hook fired. |
| `dep-review` | Auto-generated review prompt for something that may be affected by a primary correction's fix. Written by `/flag-issue` Step 4b. See `SCHEMA-DEPS.md`. |

When reading an entry with no `type`, treat it as `primary`.

---

## Repo Attribution Rule

Infer `repo` from `target_path` at capture time:

- If `target_path` sits under a configured root's `path`, `repo` is that root's `name`.
- Roots are checked in configured order, first match wins.
- Otherwise `repo` is `"unknown"`, AND a note is added to `notes` flagging the unresolved path.

`/apply-fix` will NOT route a commit for an entry with `repo: "unknown"`. It must be resolved by hand first. This is deliberate: guessing a repository means committing a fix into an unrelated project.

---

## Dedup Key Rule

Before writing a new queue entry, compute:

```
dedup_key = "{target}::{slug(first 40 chars of what_happened)}"
```

Slugify means: lowercase, replace every non-alphanumeric character with `-`, trim leading and trailing dashes, truncate to 40 characters.

Then scan `~/.claude/build-loop/queue/` for any existing entry with the same `dedup_key` created in the last 10 minutes. If one is found, skip the write and report the duplicate rather than creating a second entry. This stops one correction being logged twice when the Stop hook and `/flag-issue` both catch the same event.

---

## Dep-review Dedup Key Rule

Dep-review entries use a different format:

```
dedup_key = "dep-review::{dependent_target}::{parent_id}"
```

Example: `dep-review::wrap::2026-04-23T14-30-00-capture`

Unlike primary dedup, this is NOT time-limited. The same `parent_id` plus dependent pair is one logical review forever, because the primary's resolution closes it.

---

## Pattern Flags File (pattern-flags.json)

**File location:** `~/.claude/build-loop/pattern-flags.json`

**Purpose:** Records targets that have accumulated enough closed corrections to indicate a structural problem rather than a one-off. Written by `/flag-patterns`. Never written by `/flag-issue` or `/apply-fix`.

### File-level schema

```json
{
  "$schema_version": 3,
  "last_updated": "2026-04-24T00:00:00.000Z",
  "flags": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema_version` | int | yes | Version for this file. Currently 3. Moved from 2 in 0.9.6 for the `session_count` to `occurrence_count` rename, under the bump rule above. A v2 file still reads correctly: the mapping in `/flag-patterns` Step 3 keys off the missing field rather than this number, so the bump makes the file say which name it carries rather than being what makes the old one readable. |
| `last_updated` | string | yes | ISO-8601 timestamp of the most recent write. |
| `flags` | array | yes | One entry per flagged target. Max one entry per target, updated in place. |

### Per-flag entry schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | yes | Matches the `target` field in queue entries. Called `skill` before v5. |
| `target_kind` | string | yes | Copied from the queue entries. Defaults to `"skill"` for pre-v5 data. |
| `repo` | string | yes | Which root owns it. |
| `target_path` | string | yes | Absolute path to the file. Called `skill_path` before v5. |
| `flagged_at` | string | yes | ISO-8601 timestamp when this first crossed the threshold. Never updated after creation. |
| `correction_count` | int | yes | Total closed primary corrections. Updated each run. |
| `occurrence_count` | int | yes | How many separate occasions the target was corrected on, by the counting rule in `/flag-patterns` Step 2b. Not a count of sessions: a typed correction counts on its own, so several filed in one sitting are several occurrences and one session. Updated each run. Called `session_count` before 0.9.6, and read under the old name when a flags file still carries it. |
| `status` | string | yes | See Flag Status Enum below. |
| `diagnosis` | string | yes | Plain-language description of the recurring issue. 500 characters max, three to five sentences. Names the problem and a structural cause hypothesis. NOT a fix prescription. |
| `example_entries` | array | yes | Up to 5 queue entry IDs evidencing the pattern. |
| `notes` | array | no | Append-only `{ts, text}` objects. Never cleared. |

### Reading a pre-v2 flags file

A flags file written before v2 stores each entry's identifier under `skill` and its path under `skill_path`, with no `target_kind`. Apply the same read-time mapping used for queue entries, to every flag, before matching anything:

| Old field | Read as | Rule |
|---|---|---|
| `skill` | `target` | Use `target` if present, else `skill` |
| `skill_path` | `target_path` | Use `target_path` if present, else `skill_path` |
| (absent) | `target_kind` | Default to `"skill"` |

**This mapping is load-bearing, not cosmetic.** Flags are matched by `target` to decide whether one already exists. An unmapped pre-v2 flag has no `target`, so it never matches, and a second entry is appended for something already flagged. That breaks the one-entry-per-target rule and splits the correction history the file exists to preserve. Everywhere else a missed mapping produces a visible error; here it produces a plausible-looking duplicate.

The file is not rewritten on read. `/flag-patterns` writes every flag back under the v2 names on its next normal run, which converts the file as a side effect, so no migration is ever run separately and none can half-finish.

### Flag Status Enum

| Status | Meaning |
|--------|---------|
| `pending-review` | Flagged, waiting for a structural review. Default on creation. |
| `in-review` | Actively being worked on. Set by hand. |
| `resolved` | Structural fix applied and verified. Set by hand. |

### Detection rule

Group by `target`. Three or more closed primary corrections for the same target, on three or more separate occasions. A correction is "closed primary" if `type == "primary"` (or the field is missing) AND `status` is `Resolved` or `fix applied, watching`.

The counting token comes from `source`. A `slash-capture` entry counts by `id`, one occurrence each, because somebody typed it. Anything else, including `manual` and a missing `source`, counts by `session_id || id`, so a stop-hook firing repeatedly in one sitting counts once. Do not read this off an empty `session_id`: that coupling is what broke on PR #96 the moment `/flag-issue` started filling the field in.

**Occurrences are not sessions, and the report must not call them sessions.** Several `slash-capture` corrections typed in one sitting are several occurrences and one session, so naming them sessions tells the reader a problem recurred across occasions it did not. `/flag-patterns` records the number as `occurrence_count` for that reason.

### Write rule

Queue entries are never written by hand. Changing one goes through
`scripts/queue.js update`, and creating one goes through `scripts/queue.js
create`, which re-checks the `dedup_key` inside the same lock it writes under.
`/flag-issue` composes the entry to a scratch file and hands it over.

This used to say that creating was the one case not needing care, because there
was no existing file to lose. That was true about half-written files and missed
the other half: the dedup check and the write were separate tool calls, so two
sessions capturing the same correction both saw an empty queue and both wrote.

`pattern-flags.json` is not a queue entry and still uses the `.tmp` plus node
parse-check plus `mv` sequence.

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-23 | Initial queue entry schema. |
| v2 | 2026-04-23 | Added `type` and `parent_id`. Added `"dep-review-auto"` to the source enum. Readers default a missing `type` to `"primary"`. |
| v3 | 2026-04-23 | Added `fix applied, watching` and `fix attempted / unresolved` to the status enum. Notes now carry commit hashes. |
| v4 | 2026-04-24 | Added the pattern-flags.json schema. Queue entry schema unchanged. |
| v5 | 2026-07-27 | The queue covers anything you build, not only skills. `skill` becomes `target`, `skill_path` becomes `target_path`, and `target_kind` is added. The roots config gains a `kind`, plus two default roots for hooks and commands. Readers map the old field names at read time, so no migration runs and pre-v5 entries keep working. pattern-flags.json goes to v2 for the same rename. |
| v5, no bump | 2026-07-28 | `fix attempted / unresolved` retired from the writers. Added in v3 and never reachable by any `/list-bugs` filter, so rejecting a fix removed the entry from the only view that lists open work. A rejected diff or a failed write now leaves the entry `Open` with the attempt in `notes`. **No version bump:** readers still accept the old value, and a pre-0.3.1 reader handles `Open` because `Open` is v1. Compatible in both directions, so bumping would signal a migration that does not exist. |
| v5, no bump | 2026-08-11 | `session_id` becomes a resolved field rather than an optional one, and `/whats-breaking` counts occurrences instead of unique sessions. **pattern-flags.json goes to v3** for the `session_count` to `occurrence_count` rename, on the same rule and the same precedent as the v2 bump in the v5 row above. Step 3 maps the old name at read time, so a v2 file keeps its counts and no migration runs. **No queue entry bump:** no queue entry field was added, renamed or removed. `session_id` and `source` both already existed and are v1 and v2 fields; what changed is that they are now filled in and read, which is a change to the writers and not to the shape. |
