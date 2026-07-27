# Skill Loop Queue Entry Schema

## Purpose

This document is the single source of truth for the queue entry format. Every skill and hook in the skill-loop system reads from and writes to this schema. When adding fields, bump `$schema_version` and update this document in the same commit.

---

## File Location Convention

One JSON file per queue entry, stored at:

```
~/.claude/skill-loop/queue/{timestamp}-{skill-slug}.json
```

- Filename stem MUST equal the `id` field exactly.
- Timestamp format: `YYYY-MM-DDTHH-MM-SS` (colons replaced with dashes — safe on every filesystem).
- Example: `2026-04-23T14-30-00-daily-brief.json`

---

## Example Entry (v2 primary)

```json
{
  "$schema_version": 2,
  "id": "2026-04-23T14-30-00-daily-brief",
  "created_at": "2026-04-23T14:30:00.000Z",
  "status": "Open",
  "type": "primary",
  "parent_id": null,
  "skill": "daily-brief",
  "skill_path": "~/.claude/skills/daily-brief/SKILL.md",
  "repo": "personal",
  "session_id": "00dc3f8e-941c-...",
  "session_cwd": "~/projects/example",
  "what_happened": "Daily brief listed 22 accounts in Revenue section one by one instead of synthesizing themes.",
  "what_expected": "Revenue section should group by insight/theme (e.g. 'Late-stage: X, Y / Early pipe: Z'), never per-account lists.",
  "correct_example": "Late-stage: Omaha, New Era moving to proposal. Early pipe: Sephora, Scotts. Key dynamic: Adam at Scotts still dismissive, team aligning to keep him looped in.",
  "source": "stop-hook",
  "urgency_hint": "normal",
  "dedup_key": "daily-brief::per-account-lists-in-revenue",
  "notes": [],
  "resolution": null
}
```

---

## Example: dep-review entry (v2)

```json
{
  "$schema_version": 2,
  "id": "2026-04-23T14-30-00-dep-review-wrap",
  "created_at": "2026-04-23T14:30:00.000Z",
  "status": "Open",
  "type": "dep-review",
  "parent_id": "2026-04-23T14-30-00-capture",
  "skill": "wrap",
  "skill_path": "~/.claude/skills/wrap/SKILL.md",
  "repo": "personal",
  "session_id": "00dc3f8e-941c-...",
  "session_cwd": "~/projects/example",
  "what_happened": "Review: wrap may be affected by fix to capture. Reason: wrap invokes /capture when pausing work.",
  "what_expected": "(not applicable — this is a dependency review)",
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
| `$schema_version` | int | ✓ | Schema version number. Bump when any field is added, renamed, or removed. | Start at 1; increment by 1. Phases 3 and 4 read this before parsing. |
| `id` | string | ✓ | Unique identifier for this entry. Must match the filename stem exactly. | Format: `YYYY-MM-DDTHH-MM-SS-{skill-slug}` |
| `created_at` | string | ✓ | ISO-8601 timestamp with timezone. | Example: `2026-04-23T14:30:00.000Z` |
| `status` | string | ✓ | Lifecycle state of this correction. One of six values — see Status Enum below. | Changes in place; never delete entries, change their status instead. |
| `type` | string | ✓ in v2 | Which kind of queue entry this is. Optional for backward compatibility. | `"primary"` \| `"dep-review"`. When a reader encounters an entry without this field (v1 entries written before 2026-04-23), treat the entry as if `type: "primary"`. Do NOT rewrite existing entries. |
| `parent_id` | string\|null | ✓ in v2 | For dep-review entries, the id of the primary entry that triggered this review. Null for primary entries. | Allows Phase 3 to resolve/close dep-reviews when the primary is resolved. |
| `skill` | string | ✓ | The skill name being corrected (no path, no extension). | Example: `daily-brief` |
| `skill_path` | string | ✓ | Absolute path to the skill's SKILL.md file. Used by Phase 3 to route commits to the right repo. | Example: `~/.claude/skills/daily-brief/SKILL.md` |
| `repo` | string | ✓ | Which GitHub repo owns this skill. Inferred from `skill_path` — see Repo Attribution Rule below. | `"personal"` or `"<root name>"` or `"unknown"` |
| `session_id` | string | ✓ | Claude Code session ID from hook stdin. Used to reproduce the failure context. | Provided by the Stop hook; fill `""` if captured manually. |
| `session_cwd` | string | ✓ | Working directory of the session when the correction was captured. | Provided by the Stop hook; fill `""` if captured manually. |
| `what_happened` | string | ✓ | Plain-language description of the wrong behavior. | Write as: "It did X." |
| `what_expected` | string | ✓ | Plain-language description of the correct behavior. | Write as: "It should do Y." |
| `correct_example` | string | ✓ | A concrete example of what the correct output would look like. | Quote the user's words when available. A rough example is fine. |
| `source` | string | ✓ | Which entry point created this record. | `"stop-hook"` \| `"slash-capture"` \| `"manual"` \| `"dep-review-auto"`. Note: `"dep-review-auto"` marks entries written automatically by /capture Step 4b (see SCHEMA-DEPS.md). |
| `urgency_hint` | string | ✓ | Urgency signal for queue sorting. Claude's discretion on assignment. | `"normal"` \| `"high"` \| `"low"` — default is `"normal"` |
| `dedup_key` | string | ✓ | Deduplication key. See Dedup Key Rule below. | Format: `"{skill}::{slug(what_happened[:40])}"` |
| `notes` | array | - | Optional. Array of `{ts, text}` objects. Append-only; do not edit existing notes. Phase 3 updater appends a note with commit hash after every successful commit: `{ts, text: 'Committed: {hash} to {repo}'}` | Used for follow-up observations after initial capture. |
| `resolution` | string\|null | - | Null until Phase 3 verifier confirms the fix. Set to a plain-language description of what was changed. | Never set this manually — Phase 3 verifier owns this field. |

---

## Status Enum

| Status | Meaning |
|--------|---------|
| `Open` | Newly captured, not yet attempted. This is the default for all new entries. |
| `In Progress` | Phase 3 updater is actively working on this correction. |
| `Resolved` | Fix has been applied AND verified by the Phase 3 verifier. |
| `Won't Fix` | the user explicitly deferred or declined this correction. |
| `fix applied, watching` | the user approved the diff and the fix was committed. Fix is live but not yet confirmed in a real session. the user must manually close this to "Resolved" after using the skill. |
| `fix attempted / unresolved` | the user rejected the diff (said "no" or "retry" without resolving), or the Write tool failed mid-fix. The skill file is unchanged. |

---

## Type Enum

| Type | Meaning |
|------|---------|
| `primary` | A directly-captured correction. the user invoked /capture or the Stop hook fired. |
| `dep-review` | Auto-generated review prompt for a skill that may be affected by a primary correction's fix. Written by /capture Step 4b; see SCHEMA-DEPS.md for the dependency source. |

When reading an entry, if `type` is missing, treat it as `primary`. This enables v1 entries to round-trip through v2 readers without migration.

---

## Repo Attribution Rule

Infer `repo` from `skill_path` at capture time:

- If `skill_path` starts with `~/.claude/skills/` → `repo: "personal"`
- If `skill_path` starts with `<second configured root>/` → `repo: "<root name>"`
- Otherwise → `repo: "unknown"` AND add a note in `notes` flagging the unknown path.

Phase 3 will NOT route commits for entries with `repo: "unknown"` — they must be resolved manually before Phase 3 can apply the fix.

---

## Dedup Key Rule

Before writing a new queue entry, compute:

```
dedup_key = "{skill}::{slug(first 40 chars of what_happened)}"
```

Slugify means: lowercase, replace all non-alphanumeric characters with `-`, trim leading and trailing dashes, truncate to 40 characters.

Then scan `~/.claude/skill-loop/queue/` for any existing entry with the same `dedup_key` created in the last 10 minutes. If one is found, skip the write and report the duplicate to the user instead of creating a second entry. This prevents the same correction being logged twice when both the Stop hook and `/capture` detect the same event.

---

## Dep-review Dedup Key Rule

Dep-review entries use a different dedup format:

```
dedup_key = "dep-review::{dependent_skill}::{parent_id}"
```

Example: `dep-review::wrap::2026-04-23T14-30-00-capture`

This prevents the same dependent skill being re-flagged when the same primary entry already exists. Unlike primary dedup (which uses a 10-minute window), dep-review dedup is NOT time-limited — the same `parent_id` + dependent skill pair is deduped forever, because Phase 3 will close the dep-review entry when the primary is resolved.

---

## Pattern Flags File (pattern-flags.json)

**File location:** `~/.claude/skill-loop/pattern-flags.json`

**Purpose:** Records skills that have accumulated enough closed corrections to indicate a structural pattern requiring co-development review (PATT-01 / PATT-02 / PATT-03). Written by `/skill-summary` during the weekly summary flow. Never written by `/capture` or `/apply-fixes`.

### File-level schema

```json
{
  "$schema_version": 1,
  "last_updated": "2026-04-24T00:00:00.000Z",
  "flags": [ /* one entry per flagged skill — see below */ ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema_version` | int | ✓ | Schema version for this file. Starts at 1. Bump if flag entry fields are added, renamed, or removed. |
| `last_updated` | string | ✓ | ISO-8601 timestamp of the most recent write to this file. |
| `flags` | array | ✓ | One entry per flagged skill. Max one entry per skill — updates in place, never a second entry for the same skill. |

### Per-flag entry schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skill` | string | ✓ | Skill directory name. Matches `skill` field in queue entries. |
| `repo` | string | ✓ | `"personal"` \| `"<root name>"`. Copied from DEPS.json or inferred from `skill_path`. |
| `skill_path` | string | ✓ | Absolute path to the skill's SKILL.md. Copied from queue entry or DEPS.json. |
| `flagged_at` | string | ✓ | ISO-8601 timestamp when this skill first crossed the threshold. Never updated after initial flag. |
| `correction_count` | int | ✓ | Total closed primary corrections for this skill. Updated on each summary run. |
| `session_count` | int | ✓ | Unique sessions in which corrections were captured. Updated on each summary run. |
| `status` | string | ✓ | One of three values — see Flag Status Enum below. |
| `diagnosis` | string | ✓ | Claude-generated plain-language description of the recurring issue. Regenerated on each summary run if `correction_count` has increased. 500 chars max, 3-5 sentences. Names problem + structural cause hypothesis. NOT a fix prescription. |
| `example_entries` | array | ✓ | Up to 5 queue entry IDs that evidence the pattern. Updated on each summary run (newest replace oldest if over 5). |
| `notes` | array | - | Append-only `{ts, text}` objects. Used by the maintainer and the user for co-development notes. Never cleared. |

### Flag Status Enum

| Status | Meaning |
|--------|---------|
| `pending-review` | Flagged, waiting for the maintainer co-development review. Default on creation. |
| `in-review` | Actively being discussed with the maintainer for structural fix design. Set manually. |
| `resolved` | Structural fix applied and verified. Set manually after fix is in place. |

### Detection rule (summary of 04-DESIGN.md Section 2)

Skill-level grouping: 3+ closed primary corrections for the same skill name, across 3+ unique sessions. A correction is "closed primary" if `type == "primary"` (or field missing) AND `status IN ("Resolved", "fix applied, watching")`. Dedup by `session_id || id` when counting unique sessions.

### Atomic write rule

`pattern-flags.json` writes use the same `.tmp` + node parse-check + `mv` pattern as all other JSON writes in this project (established in Phase 2, applies without exception).

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-23 | Initial schema: queue entry v1 for Phase 1 capture foundation |
| v2 | 2026-04-23 | Added `type` (primary \| dep-review) and `parent_id` fields. Added `"dep-review-auto"` to source enum. Readers MUST default missing `type` to `"primary"` to preserve v1 compatibility. |
| v3 | 2026-04-23 | Added "fix applied, watching" and "fix attempted / unresolved" to Status Enum. Notes field extended: updater now appends commit hash after successful commits. |
| v4 | 2026-04-24 | Added pattern-flags.json schema (Phase 4 Intelligence Layer). pattern-flags.json lives at `~/.claude/skill-loop/pattern-flags.json`. Flag status enum: `pending-review` \| `in-review` \| `resolved`. Queue entry schema unchanged — pattern detection works from existing fields without modification. |
