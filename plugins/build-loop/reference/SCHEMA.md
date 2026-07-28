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

### If none of the default roots exist

The three defaults are the standard locations, and on a machine where
everything is installed from marketplaces rather than written by hand, none of
them will exist. That is not an error, but it does mean nothing resolves
automatically and every capture will stop to ask for a path.

When a command notices that no configured root exists on disk, it says so once
and points at the config, rather than asking for a path every single time:

> "None of the configured roots exist on this machine. If you develop plugins in
> a checkout, add it to `~/.claude/build-loop.config.json` as a root of kind
> `plugin-repo` and everything will resolve automatically."

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
  "session_id": "",
  "session_cwd": "",
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
| `session_id` | string | yes | Claude Code session ID. Used to reproduce the failure context. | Fill `""` if not available. |
| `session_cwd` | string | yes | Working directory when the correction was captured. | Fill `""` if not available. |
| `what_happened` | string | yes | Plain-language description of the wrong behaviour. | Write as: "It did X." |
| `what_expected` | string | yes | Plain-language description of the correct behaviour. | Write as: "It should do Y." |
| `correct_example` | string | yes | A concrete example of what correct output would look like. | Quote the user's words when available. A rough example is fine. |
| `source` | string | yes | Which entry point created this record. | `"stop-hook"`, `"slash-capture"`, `"manual"`, `"dep-review-auto"` |
| `urgency_hint` | string | yes | Urgency signal for queue sorting. | `"normal"`, `"high"`, `"low"`. Default is `"normal"`. |
| `dedup_key` | string | yes | Deduplication key. See Dedup Key Rule below. | Format: `"{target}::{slug(what_happened[:40])}"` |
| `notes` | array | no | Array of `{ts, text}` objects. Append-only. `/apply-fix` appends a note holding the commit hash after every successful commit. | Used for follow-up observations after capture. |
| `resolution` | string or null | no | Null until a fix is verified. Then a plain-language description of what changed. | Owned by `/verify-fix`. Never set by hand. |

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

## Status Enum

| Status | Meaning |
|--------|---------|
| `Open` | Newly captured, not yet attempted. The default for all new entries. |
| `In Progress` | `/apply-fix` is actively working on this correction. |
| `Resolved` | Fix applied AND verified. |
| `Won't Fix` | The user explicitly deferred or declined this correction. |
| `fix applied, watching` | The user approved the diff and the fix was committed. Live but not yet confirmed in a real session. The user closes this to `Resolved` after using the thing. |
| `fix attempted / unresolved` | **Retired in 0.3.1. Do not write this.** Readers still accept it, because entries written earlier carry it. A rejected diff or a failed write now leaves the entry `Open` and records the attempt in `notes`. The status was removed rather than added to `/list-bugs`, because it described a bug that was still open while making it invisible to every filter that lists open work. |

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

**Purpose:** Records targets that have accumulated enough closed corrections to indicate a structural problem rather than a one-off. Written by `/whats-breaking`. Never written by `/flag-issue` or `/apply-fix`.

### File-level schema

```json
{
  "$schema_version": 2,
  "last_updated": "2026-04-24T00:00:00.000Z",
  "flags": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema_version` | int | yes | Version for this file. Currently 2. |
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
| `session_count` | int | yes | Unique sessions in which corrections were captured. Updated each run. |
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

The file is not rewritten on read. `/whats-breaking` writes every flag back under the v2 names on its next normal run, which converts the file as a side effect, so no migration is ever run separately and none can half-finish.

### Flag Status Enum

| Status | Meaning |
|--------|---------|
| `pending-review` | Flagged, waiting for a structural review. Default on creation. |
| `in-review` | Actively being worked on. Set by hand. |
| `resolved` | Structural fix applied and verified. Set by hand. |

### Detection rule

Group by `target`. Three or more closed primary corrections for the same target, across three or more unique sessions. A correction is "closed primary" if `type == "primary"` (or the field is missing) AND `status` is `Resolved` or `fix applied, watching`. Dedup by `session_id || id` when counting unique sessions.

### Atomic write rule

`pattern-flags.json` writes use the `.tmp` plus node parse-check plus `mv` sequence, like every other JSON write that REPLACES an existing file. Creating a brand-new queue entry is the one case that does not need it, because there is no existing file to lose. `/flag-issue` documents that in its own header.

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-23 | Initial queue entry schema. |
| v2 | 2026-04-23 | Added `type` and `parent_id`. Added `"dep-review-auto"` to the source enum. Readers default a missing `type` to `"primary"`. |
| v3 | 2026-04-23 | Added `fix applied, watching` and `fix attempted / unresolved` to the status enum. Notes now carry commit hashes. |
| v4 | 2026-04-24 | Added the pattern-flags.json schema. Queue entry schema unchanged. |
| v5 | 2026-07-27 | The queue covers anything you build, not only skills. `skill` becomes `target`, `skill_path` becomes `target_path`, and `target_kind` is added. The roots config gains a `kind`, plus two default roots for hooks and commands. Readers map the old field names at read time, so no migration runs and pre-v5 entries keep working. pattern-flags.json goes to v2 for the same rename. |
| v5 | 2026-07-28 | `fix attempted / unresolved` retired from the writers. Added in v3 and never reachable by any `/list-bugs` filter, so rejecting a fix removed the entry from the only view that lists open work. A rejected diff or a failed write now leaves the entry `Open` with the attempt in `notes`. **No version bump:** readers still accept the old value, and a pre-0.3.1 reader handles `Open` because `Open` is v1. Compatible in both directions, so bumping would signal a migration that does not exist. |
