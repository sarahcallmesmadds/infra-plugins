# DEPS.json Schema

## Purpose

This document is the single source of truth for the `DEPS.json` file format. Every component in the skill loop that reads or writes `DEPS.json` — including `/capture`, `/update-deps`, and Phase 3's `/apply-fixes` — consults this schema. When adding a field, bump `$schema_version` in `DEPS.json` and update this document in the same commit.

---

## File Location

There is exactly ONE `DEPS.json` for the entire skill loop — not one per repo.

```
~/.claude/skill-loop/DEPS.json
```

---

## Top-Level Shape

```json
{
  "$schema_version": 1,
  "last_updated": "2026-04-23T14:30:00.000Z",
  "skills": {
    "personal:capture": { "...entry..." },
    "<root name>:action-pipeline-standup-prep": { "...entry..." }
  }
}
```

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `$schema_version` | int | Starts at 1. Increment by 1 whenever a field is added, renamed, or removed. |
| `last_updated` | string | ISO-8601 UTC timestamp of the last write to this file. |
| `skills` | object | Object keyed by composite key (see below). One entry per skill in both repos. |

---

## Composite Key Rule

Keys in the `skills` object use the format `"{repo}:{skill-directory-name}"`.

- The `repo` portion is always `personal` or `<root name>` — lowercase, no spaces.
- The skill portion is the **directory name on disk**, not the frontmatter `name` field.

Example keys:

```
personal:capture
personal:log-plugin
<root name>:log-plugin
<root name>:action-pipeline-standup-prep
```

**Why composite keys?** Five skill names exist in both repos. Using skill name alone would cause collisions:

| Skill | Exists in personal? | Exists in <root name>? |
|-------|---------------------|-----------------------|
| `log-plugin` | Yes | Yes |
| `new-project` | Yes | Yes |
| `revops-release` | Yes | Yes |
| `tool-eval` | Yes | Yes |
| `tool-renewal` | Yes | Yes |

For `tool-renewal`: even though its SKILL.md is at `tool-renewal/skill/SKILL.md`, the composite key uses the directory name `tool-renewal`, not the subdirectory path.

---

## Entry Shape

A full example of one skill entry:

```json
{
  "skill": "daily-brief",
  "repo": "personal",
  "path": "~/.claude/skills/daily-brief/SKILL.md",
  "depends_on": [
    {
      "skill": "customer-context",
      "repo": "personal",
      "reason": "daily-brief references customer-context for Revenue section lookups"
    }
  ],
  "dependents": [],
  "confidence": "high",
  "last_updated": "2026-04-23T14:30:00.000Z",
  "notes": "Optional free-text authoring quirks — use only when the directory name differs from the frontmatter name."
}
```

---

## Field Reference

| Field | Type | Required | Description | Notes |
|-------|------|----------|-------------|-------|
| `skill` | string | ✓ | Directory name of this skill on disk. | Matches the directory-name portion of the composite key. |
| `repo` | string | ✓ | Which repo owns this skill. | `"personal"` or `"<root name>"` — matches the repo portion of the composite key. |
| `path` | string | ✓ | Absolute path to this skill's SKILL.md file. | Example: `~/.claude/skills/daily-brief/SKILL.md` |
| `depends_on` | array | ✓ | Skills that this skill depends on. Empty array `[]` if none. | See Dependency Edge Format below. |
| `dependents` | array | ✓ | Skills that depend on this skill. Empty array `[]` if none. | See Dependency Edge Format below. |
| `confidence` | string | ✓ | Overall confidence in the accuracy of this skill's dependency map. | `"high"` \| `"medium"` \| `"low"` — see Confidence Levels below. |
| `last_updated` | string | ✓ | ISO-8601 UTC timestamp of the last time this entry was reviewed or updated. | |
| `notes` | string | - | Optional. Free-text authoring quirks for this skill. | Use when the directory name differs from the frontmatter `name`, or when a dependency was uncertain. Do not use as a structured field. |

---

## Dependency Edge Format

Each item in `depends_on` and `dependents` is an object with this shape:

```json
{
  "skill": "customer-context",
  "repo": "personal",
  "reason": "daily-brief references customer-context for Revenue section lookups",
  "confidence": "low"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skill` | string | ✓ | Directory name of the related skill. |
| `repo` | string | ✓ | Repo that owns the related skill. `"personal"` or `"<root name>"`. |
| `reason` | string | ✓ | One-sentence plain-language explanation of the relationship. |
| `confidence` | string | - | Optional. Include only when flagging an uncertain relationship. Value: `"low"`. |

**Edge-level `confidence` is optional** — only present when the relationship is uncertain. The entry-level `confidence` on the parent entry is REQUIRED and represents overall map accuracy for that skill. These are two different fields with related but distinct purposes.

---

## What Counts as a Dependency

A dependency relationship exists between skill A and skill B when any of the following is true:

- Skill A **explicitly calls or invokes** skill B (e.g., A's SKILL.md says "run /b to get data")
- Skill A **reads output that skill B produces** (e.g., A consumes a file B writes, or reads B's queue entries)
- They **share significant data** — such as the same Notion DB IDs, the same file paths, or the same schema — where a change to that data in one skill requires a corresponding change in the other. Judgment is applied case by case.

**Transitive dependencies ARE tracked.** If A depends on B and B depends on C, then A should appear in C's `dependents` list. Do not stop at direct relationships.

---

## What Does NOT Go in depends_on

`depends_on` entries MUST reference a skill that exists as another entry in `DEPS.json`. Do not add edges to infrastructure.

The following are **NOT** valid `depends_on` entries:

- `SCHEMA.md` — this is a format document, not a skill
- `~/.claude/skill-loop/queue/` — this is the queue directory, not a skill
- Notion DBs — data sources, not skills
- MCP servers — infrastructure, not skills
- `~/.claude/settings.json` — hook configuration, not a skill

When a skill depends on infrastructure (e.g., it reads from a specific Notion DB), capture that in the `notes` field as free text. Never encode it as a structured edge.

---

## Confidence Levels

| Level | Meaning |
|-------|---------|
| `high` | Explicit call or verified shared hardcoded value (Notion DB ID, absolute file path) confirmed in SKILL.md content. |
| `medium` | Probable dependency but not literal — skills share semantics, similar outputs, or overlapping documentation, but no verified shared value. |
| `low` | Uncertain. The relationship looks plausible but could not be confirmed by reading the skills. Flagged for the user to review manually before Phase 3 acts on it. |

---

## Coverage Rule

Every skill in both repos gets an entry in `DEPS.json`, even standalone skills with no dependencies. An entry with empty `depends_on: []` and `dependents: []` is valid and meaningful — it confirms the skill was reviewed and found to have no relationships, rather than simply never being examined.

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| v1 | 2026-04-23 | Initial schema: DEPS.json covers both repos with composite keys. |
