# To-build List Schema

## Purpose

This document is the single source of truth for the to-build list format. `/to-build` writes it and `/built-check` closes items in it.

The bug queue is a separate store with its own schema. See `SCHEMA.md`. The two are deliberately not merged: a bug entry has to say what happened and what was expected, and a thing you have not built yet has neither.

---

## File Location Convention

One JSON file per item, stored at:

```
~/.claude/build-loop/to-build/{timestamp}-{title-slug}.json
```

- Filename stem MUST equal the `id` field exactly.
- Timestamp format: `YYYY-MM-DDTHH-MM-SS`, colons replaced by dashes.
- Example: `2026-07-27T15-02-11-git-hygiene-plugin.json`

---

## Example entry

```json
{
  "$schema_version": 1,
  "id": "2026-07-27T15-02-11-git-hygiene-plugin",
  "created_at": "2026-07-27T15:02:11.000Z",
  "status": "Open",
  "title": "git-hygiene plugin",
  "kind": "plugin",
  "what": "Warn about stale branches at the start of a session and offer to clean them up.",
  "why": "22 stale branches have built up and nothing surfaces them until they cause a conflict.",
  "where": "smadds marketplace",
  "blocked_by": "",
  "session_id": "00dc3f8e-941c-...",
  "session_cwd": "~/projects/example",
  "dedup_key": "to-build::git-hygiene-plugin",
  "notes": [],
  "built": null
}
```

## Example of a closed item

The `built` object is written by `/built-check` when the item is confirmed done. Everything else is left exactly as it was.

```json
{
  "status": "Built",
  "built": {
    "ts": "2026-08-02T11:20:04.000Z",
    "evidence": "plugins/git-hygiene/ exists with 3 skills and a plugin.json",
    "commit": "a1b2c3d",
    "confirmed_by": "user"
  }
}
```

---

## Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `$schema_version` | int | yes | Version number for this format. Currently 1. |
| `id` | string | yes | Unique identifier. Must equal the filename stem. Format `YYYY-MM-DDTHH-MM-SS-{title-slug}`. |
| `created_at` | string | yes | ISO-8601 timestamp with timezone. |
| `status` | string | yes | One of four values, see Status Enum below. |
| `title` | string | yes | Short name for the thing. This is what shows in the list. Keep it under about 60 characters. |
| `kind` | string | yes | What sort of thing this will be. Same vocabulary as the bug queue: `skill`, `hook`, `command`, `plugin`, `script`, `other`. |
| `what` | string | yes | Plain language, one or two sentences on what it should do. |
| `why` | string | no | The problem it solves. Empty string when not given. This is the field that decides whether the item is still worth building in three months, so it is worth filling in. |
| `where` | string | no | Intended home: a marketplace, a repository, a root name. Empty string when not known yet. |
| `blocked_by` | string | no | Free text describing what has to happen first. Empty string when nothing blocks it. Not a structured reference to another item, because most blockers are not other to-build items. |
| `session_id` | string | yes | Claude Code session ID. Empty string if unavailable. |
| `session_cwd` | string | yes | Working directory when captured. Empty string if unavailable. |
| `dedup_key` | string | yes | See Dedup Key Rule below. |
| `notes` | array | no | Append-only array of `{ts, text}` objects. |
| `built` | object or null | no | Null until closed. See the Built Object below. |

---

## Status Enum

| Status | Meaning |
|--------|---------|
| `Open` | Written down, not started. The default for every new item. |
| `In Progress` | Being built now. Set by hand or by `/built-check` when the evidence shows a start but not a finish. |
| `Built` | Done, and the user confirmed it. Only `/built-check` sets this, and only after an explicit yes. |
| `Dropped` | Decided against. The item stays on disk as a record of the decision. |

Items are never deleted. `Dropped` exists so that deciding not to build something is itself recorded, which stops the same idea coming back around every few months.

---

## Built Object

Written only when an item moves to `Built`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | string | yes | ISO-8601 timestamp when the item was closed. |
| `evidence` | string | yes | Plain language description of what was found on disk or in the git log that showed it was built. |
| `commit` | string | no | Commit hash, when the evidence came from a git log. Empty string otherwise. |
| `confirmed_by` | string | yes | Always `"user"`. The field exists to make it obvious in the file that nothing closed itself. |

---

## Dedup Key Rule

```
dedup_key = "to-build::{slug(title)}"
```

Slugify means: lowercase, replace every non-alphanumeric character with `-`, trim leading and trailing dashes, truncate to 60 characters.

Before writing, scan `~/.claude/build-loop/to-build/` for an existing entry with the same `dedup_key` in ANY status. If one is found, show it and ask whether to add a note to the existing item instead of creating a second one.

**The key alone is not enough, and must never be the only check.** Two titles for the same piece of work rarely produce the same slug. "git-hygiene plugin" gives `to-build::git-hygiene-plugin` and "git-hygiene plugin for stale branches" gives `to-build::git-hygiene-plugin-for-stale-branches`, which do not match, and the second is plainly the same item. So a reader also compares the new `title` and `what` against every existing item's `title` and `what` and judges whether one piece of work would satisfy both. When that judgment fires and the keys do not match, say which item and why, and ask, rather than asserting a duplicate.

Unlike the bug queue, this dedup is NOT time-windowed. Writing down the same idea twice six weeks apart is the normal failure mode of a wish list, and it is exactly what this check is for. A duplicate found in `Dropped` status is worth surfacing loudly, since it means the idea was already considered and rejected.

---

## Atomic write rule

Creating a brand-new item does not need the atomic sequence, because there is no existing file to lose. This matches `/flag-issue`.

Any write that REPLACES an existing item, which means every status change made by `/built-check`, uses the `.tmp` plus node parse-check plus `mv` sequence.

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-07-27 | Initial schema. |
