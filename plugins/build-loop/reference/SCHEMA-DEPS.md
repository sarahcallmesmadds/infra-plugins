# DEPS.json Schema

## Purpose

This document is the single source of truth for the `DEPS.json` file format. Every skill in the build loop that reads or writes `DEPS.json`, which means `/flag-issue`, `/audit-deps`, and `/apply-fix`, consults this schema. When adding a field, bump `$schema_version` in `DEPS.json` and update this document in the same commit.

The map covers everything the build loop covers: skills, hooks, commands, plugins, and loose scripts. A hook that reads a file another skill writes is a dependency, and it is exactly the kind that gets forgotten.

---

## File Location

There is exactly ONE `DEPS.json` for the whole build loop, not one per repository.

```
~/.claude/build-loop/DEPS.json
```

---

## Top-Level Shape

```json
{
  "$schema_version": 2,
  "last_updated": "2026-07-27T14:30:00.000Z",
  "targets": {
    "personal:capture": {  },
    "hooks:style-lint": {  }
  }
}
```

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `$schema_version` | int | Currently 2. Increment whenever a field is added, renamed, or removed. |
| `last_updated` | string | ISO-8601 UTC timestamp of the last write to this file. |
| `targets` | object | Keyed by composite key, see below. One entry per thing found in any configured root. Called `skills` before v2. |

**Reading a v1 file.** A file with `skills` at the top level and no `targets` is read as if the key were `targets`, and each entry's `skill` field is read as `target` with `kind` defaulting to `"skill"`. Do not rewrite the file on read. `/audit-deps` converts it on its next approved write.

---

## Composite Key Rule

Keys in the `targets` object use the format `"{repo}:{name}"`.

- The `repo` portion is a configured root's `name`: lowercase, no spaces.
- The name portion is the **name on disk**, not the frontmatter `name` field. For a skill that means the directory name. For a hook, a command, or a script it means the filename without its extension.

Example keys:

```
personal:capture
personal:log-plugin
hooks:style-lint
commands:standup
work:action-pipeline-standup-prep
```

**Why composite keys?** The same name can exist in more than one root. A `log-plugin` skill in a personal root and a `log-plugin` skill in a work root are two different things with two different fix destinations, and a bare name cannot tell them apart.

Where a skill's definition is nested one level deeper, at `<root>/tool-renewal/skill/SKILL.md`, the key still uses the first directory below the root, so `tool-renewal` and never `skill`.

---

## Entry Shape

```json
{
  "target": "daily-brief",
  "kind": "skill",
  "repo": "personal",
  "path": "~/.claude/skills/daily-brief/SKILL.md",
  "depends_on": [
    {
      "target": "customer-context",
      "kind": "skill",
      "repo": "personal",
      "reason": "daily-brief reads customer-context for Revenue section lookups"
    }
  ],
  "dependents": [],
  "confidence": "high",
  "last_updated": "2026-07-27T14:30:00.000Z",
  "notes": "Optional free-text authoring quirks. Use only when the name on disk differs from the frontmatter name."
}
```

---

## Field Reference

| Field | Type | Required | Description | Notes |
|-------|------|----------|-------------|-------|
| `target` | string | yes | Name on disk. Matches the name portion of the composite key. | Called `skill` before v2. |
| `kind` | string | yes | `skill`, `hook`, `command`, `plugin`, `script`, or `other`. | Same vocabulary as the queue's `target_kind`. Defaults to `"skill"` when absent, for v1 files. |
| `repo` | string | yes | Which root owns this. | Matches the repo portion of the composite key. |
| `path` | string | yes | Absolute path to the file a fix would edit. | Example: `~/.claude/hooks/style-lint.js`. Not always a `SKILL.md`. |
| `depends_on` | array | yes | Things this one depends on. Empty array if none. | See Dependency Edge Format below. |
| `dependents` | array | yes | Things that depend on this one. Empty array if none. | See Dependency Edge Format below. |
| `confidence` | string | yes | Overall confidence in the accuracy of this entry's map. | `high`, `medium`, or `low`. See Confidence Levels below. |
| `last_updated` | string | yes | ISO-8601 UTC timestamp of the last time this entry was reviewed or updated. | |
| `notes` | string | no | Free-text authoring quirks. | Use when the disk name differs from the frontmatter name, or when a dependency was uncertain. Not a structured field. |

---

## Dependency Edge Format

Each item in `depends_on` and `dependents`:

```json
{
  "target": "customer-context",
  "kind": "skill",
  "repo": "personal",
  "reason": "daily-brief reads customer-context for Revenue section lookups",
  "confidence": "low"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | yes | Name of the related thing. Called `skill` before v2. |
| `kind` | string | yes | What sort of thing it is. Defaults to `"skill"` when absent. |
| `repo` | string | yes | Root that owns it. |
| `reason` | string | yes | One sentence, plain language, on what the relationship is. |
| `confidence` | string | no | Include only when flagging an uncertain relationship. Value: `"low"`. |

**Edge-level `confidence` is optional** and marks one uncertain relationship. The entry-level `confidence` is required and describes overall map accuracy for that entry. Two different fields, related purposes, do not conflate them.

---

## What Counts as a Dependency

A dependency exists between A and B when any of these is true:

- A **explicitly calls or invokes** B. A's definition says "run /b to get data".
- A **reads output that B produces**. A consumes a file B writes, or reads B's queue entries.
- They **share significant data**, such as the same database IDs, file paths, or schema, where changing it in one forces a change in the other.

Crossing kinds is normal and is the case most often missed. A hook that writes a file a skill later reads is a real edge in both directions, and nothing about either file mentions the other.

**Transitive dependencies ARE tracked.** If A depends on B and B depends on C, then A appears in C's `dependents`. Do not stop at direct relationships.

---

## What Does NOT Go in depends_on

`depends_on` entries MUST reference something that exists as another entry in `DEPS.json`. Do not add edges to infrastructure.

These are NOT valid `depends_on` entries:

- `SCHEMA.md`, a format document
- `~/.claude/build-loop/queue/`, a directory
- A database, a data source
- An MCP server, infrastructure
- `~/.claude/settings.json`, configuration

When something depends on infrastructure, record it in `notes` as free text. Never encode it as an edge. The test is whether the thing on the other end could itself be fixed from the bug queue. A hook can. A settings file cannot.

---

## Confidence Levels

| Level | Meaning |
|-------|---------|
| `high` | Explicit call, or a verified shared hardcoded value such as a database ID or absolute path, confirmed by reading the file. |
| `medium` | Probable but not literal. Shared semantics, similar outputs, or overlapping documentation, with no verified shared value. |
| `low` | Uncertain. Plausible but not confirmed by reading. Flagged for review before anything acts on it. |

---

## Coverage Rule

Everything found in a configured root gets an entry, including standalone things with no dependencies. An entry with empty `depends_on` and empty `dependents` is valid and meaningful: it records that the thing was reviewed and found to have no relationships, which is different from never having been examined.

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-23 | Initial schema. One map across all repositories, composite keys. |
| v2 | 2026-07-27 | The map covers anything you build, not only skills. Top-level `skills` becomes `targets`, entry and edge field `skill` becomes `target`, and `kind` is added to both. Readers map the v1 names at read time, so a v1 file keeps working until `/audit-deps` next writes. |
