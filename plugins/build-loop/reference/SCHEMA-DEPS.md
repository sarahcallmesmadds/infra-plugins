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
  "$schema_version": 5,
  "last_updated": "2026-07-27T14:30:00.000Z",
  "targets": {
    "personal:capture": {  },
    "hooks:style-lint": {  },
    "plugins:guardrails/hook-io": {  }
  }
}
```

Top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `$schema_version` | int | Currently 5. Increment whenever a field is added, renamed, or removed. |
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

### Under a `plugin-repo` root, the plugin name is part of the key

A `plugin-repo` root holds many plugins, so the root name does not disambiguate anything inside it. The name portion is `{plugin}/{name}`:

```
plugins:guardrails/hook-io          scripts/hook-io.js inside the guardrails plugin
plugins:slop-check/hook-io          a different file, and now a different key
plugins:build-loop/flag-issue       skills/flag-issue/SKILL.md
plugins:guardrails                  the plugin itself
```

Without this, one root named `plugins` holding four plugins produced `plugins:cli` for three separate files, and `plugins:config`, `plugins:hook-io` and `plugins:patterns` for two each. Later entries overwrote earlier ones, so the map silently described the wrong file and a fix to one plugin flagged dependents of another.

The plugin itself keeps a bare key, `plugins:guardrails`. There is no collision between a plugin and something inside it, because everything inside carries a `/`.

### Looking a key up

Derive the key from the entry's `repo` and its `target_path`, not from the target name alone. The path says which plugin the file is in and the name does not.

Then try these **in order**, and stop at the first that resolves. A map can be older or newer than the reader, so both directions have to work.

**1. The exact key.** `{repo}:{plugin}/{target}` under a `plugin-repo` root, `{repo}:{target}` otherwise. This is the normal case and usually the only one that runs.

**2. The bare key, `{repo}:{target}`.** A map written before v3 stored plugin-repo entries under a plain name, so `plugins:hook-io` and never `plugins:guardrails/hook-io`. A qualified lookup misses it, and step 3 cannot rescue it, because `hook-io` does not end with `/hook-io`.

When this step is what matched, say so, and say what it costs:

> `Note: DEPS.json predates v3, so this matched on name alone. If more than one plugin has a {target}, the entry may describe a different one. Run /audit-deps to rebuild the keys.`

That warning is not decoration. A pre-v3 map is exactly the file where `plugins:cli` meant three different things, so the entry it returns may well belong to another plugin. Using it beats going silent, and pretending it is precise does not.

**3. A suffix match on `/{target}`.** The mirror of step 2: a bare lookup, made without a path, against a map that is already qualified.

- Exactly one match: use it.
- More than one: do not pick. Say which keys matched and that the target name is ambiguous. Guessing here sends a fix to the wrong plugin, which is the failure this key format exists to prevent.

**4. Nothing matched.** There is genuinely no entry, and reporting that is correct.

A lookup that quietly finds nothing looks exactly like a target with no dependents. Those two need to stay distinguishable, so say which one happened, and say which step got you there whenever it was not step 1.

---

## Entry Shape

An entry inside a `plugin-repo` root carries `plugin` beside `target`, for the
same reason an edge does: the plugin has to be readable as a field, not only
recoverable by parsing the key. Anything building an edge out of this entry
reads `entry.plugin`, and if that only lives in the key it reads nothing.

```json
{
  "target": "hook-io",
  "plugin": "guardrails",
  "kind": "script",
  "repo": "plugins",
  "path": "~/Projects/plugins/plugins/guardrails/scripts/hook-io.js",
  "depends_on": [],
  "dependents": []
}
```

The general shape, outside a `plugin-repo` root:

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
| `target` | string | yes | Name on disk. Bare, matching the name portion of the composite key after any plugin segment. | Called `skill` before v2. |
| `plugin` | string | no | Which plugin inside a `plugin-repo` root holds this. Required when `repo` names a `plugin-repo` root, absent otherwise. | Added in v3. Without it the plugin exists only inside the key, so anything building an edge from this entry has nothing to read. |
| `kind` | string | yes | `skill`, `hook`, `command`, `plugin`, `script`, or `other`. | Same vocabulary as the queue's `target_kind`. Defaults to `"skill"` when absent, for v1 files. |
| `repo` | string | yes | Which root owns this. | Matches the repo portion of the composite key. |
| `path` | string | yes | Absolute path to the file a fix would edit. | Example: `~/.claude/hooks/style-lint.js`. Not always a `SKILL.md`. |
| `depends_on` | array | yes | Things this one depends on. Empty array if none. | See Dependency Edge Format below. |
| `dependents` | array | yes | Things that depend on this one. Empty array if none. | See Dependency Edge Format below. |
| `confidence` | string | yes | Overall confidence in the accuracy of this entry's map. | `high`, `medium`, or `low`. See Confidence Levels below. |
| `last_updated` | string | yes | ISO-8601 UTC timestamp of the last time this entry was **reviewed by a person or by `/audit-deps`**. | Never written by an automatic check. The only date an entry carries. |
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

Inside a `plugin-repo` root, an edge also carries `plugin`:

```json
{
  "target": "hook-io",
  "plugin": "guardrails",
  "kind": "script",
  "repo": "plugins",
  "reason": "bash-guard requires readEvent and block from scripts/hook-io.js"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `target` | string | yes | Name of the related thing. **Bare, never `plugin/name`.** Called `skill` before v2. |
| `plugin` | string | no | Which plugin inside a `plugin-repo` root holds it. Required when `repo` names a `plugin-repo` root, absent otherwise. |
| `kind` | string | yes | What sort of thing it is. Defaults to `"skill"` when absent. |
| `repo` | string | yes | Root that owns it. |
| `reason` | string | yes | One sentence, plain language, on what the relationship is. |
| `confidence` | string | no | Include only when flagging an uncertain relationship. Value: `"low"`. |

**`plugin` is a separate field and `target` stays bare.** The composite key an edge points at is rebuilt as `{repo}:{plugin}/{target}`, or `{repo}:{target}` where there is no `plugin`.

Folding the plugin into `target` looks equivalent and is not. `/flag-issue` copies an edge's `target` verbatim into the `target` field of the dep-review entry it writes, and a queue entry's `target` is a bare name on disk that later has to resolve to a file. An edge saying `"target": "guardrails/hook-io"` produces a queue entry for something called `guardrails/hook-io`, which no search will ever find.

Leaving `plugin` out entirely is equally wrong in the other direction. `cli`, `config`, `hook-io` and `patterns` each exist in more than one plugin, so a bare edge naming `cli` cannot say which one it means, and that ambiguity is the exact thing the composite key was introduced to remove. The edge needs both halves because it feeds two different consumers: the key, which wants the plugin, and the queue entry, which must not have it.

**Edge-level `confidence` is optional** and marks one uncertain relationship. The entry-level `confidence` is required and describes overall map accuracy for that entry. Two different fields, related purposes, do not conflate them.

**Reading an edge with no `plugin` under a `plugin-repo` root.** That is a map written before v3, or one written by hand. Resolve it with the same ordered lookup used for keys: exact, then bare, then a unique `/{target}` suffix match, and report an ambiguous name rather than choosing.

---

## What Counts as a Dependency

A dependency exists between A and B when any of these is true:

- A **explicitly calls or invokes** B. A's definition says "run /b to get data".
- A **reads output that B produces**. A consumes a file B writes, or reads B's queue entries.
- They **share significant data**, such as the same database IDs, file paths, or schema, where changing it in one forces a change in the other.

Crossing kinds is normal and is the case most often missed. A hook that writes a file a skill later reads is a real edge in both directions, and nothing about either file mentions the other.

**`dependents` is generated from direct edges only.** If A depends on B, A appears in B's `dependents`. If A depends on B and B depends on C, A does **not** get written into C's `dependents`. Reachability through a chain is derived when somebody needs it, not stored.

This used to say the opposite, that transitive dependents are tracked and not to stop at direct relationships. Nothing ever implemented it, so it was a rule the map did not honour for as long as it existed. Settled on 2026-08-15 in favour of direct-only, per queue entry `2026-08-11T18-28-39-audit-deps`, on cost: `/flag-issue` writes one dep-review per dependent, so storing the closure would fan reviews across most of a repository every time a shared module was corrected. Six near-identical dep-reviews had already been called too many.

**A `dependents` row that is explained only by a chain is still valid, and is never one-sided.** The two rules are separate and it matters. Generation is direct-only; acceptance is not. Somebody may write a chain-explained row by hand, and treating it as broken would invite `/audit-deps` to "repair" it by inventing a direct edge that the map does not intend. `/audit-deps` Step 3 walks forward edges transitively before calling anything one-sided, and that is deliberate.

Measured against the live map on 2026-08-15: 271 `dependents` rows, all 271 explained by a direct edge, none transitive-only and none one-sided. So the change reclassifies nothing today. An earlier count on 2026-08-11 found 3 transitive-only and 99 one-sided; those were resolved by the audit run on 2026-08-15, not by this change.

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

## One Date, and the Second One That Was Removed

`last_updated` is a review date, and it is the only date an entry carries. It
means a person or `/audit-deps` judged these edges correct. `/audit-deps` reads
it, comparing against the file's modification time to decide an entry is STALE
and may need `depends_on` re-inferred.

**Nothing automatic may write it.** An unattended check reads what a file
mechanically calls. That cannot see a semantic edge, one thing reading a file
another writes, so an edit that added one would leave the entry looking freshly
reviewed and it would never come up for review again. This is not hypothetical:
`deps-watch` stamped `last_updated` until v4 and emptied the stale bucket
silently.

**There used to be a second date, `last_auto_checked`, and it was removed in
v5.** v4 added it so that an unattended check had somewhere to write that was
not the review date, which fixed the problem above. Its only reader was the
session brief's drift warning, and session 0.8.7 removed that warning: it was
reporting 82 of 127 entries as changed with nothing actually missing, because
`last_updated` is never bumped by machine, so a reviewed-and-since-edited entry
counted as drifted forever. That left the field written by one hook and read by
nothing.

Removed rather than kept, on 2026-08-15, per queue entry
`2026-08-15T19-17-34-deps-watch`. The field, its writer, and the second lock
implementation that existed only to guard that one write all came out together.
`deps-watch` is now read-only and warns in the conversation instead.

**A map written before v5 may still carry the field.** It is ignored. The next
`/audit-deps` run drops it, and nothing reads it in the meantime.

The distinction is not stylistic. `deps-watch` can only see mechanical
references: a `require()`, a fenced `scripts/<name>.js`, a `hooks.json`
command. A semantic edge, one thing reading a file another writes, is invisible
to it and is exactly the kind the Coverage Rule says gets missed most often.

So an automatic check saying "nothing new appeared" is a much weaker statement
than a review saying "these edges are right". Writing the weaker one into the
stronger one's field means an edit that adds a semantic edge leaves the entry
looking freshly reviewed, it never enters the STALE bucket, and the edge is
never recorded. Nothing surfaces that, because the field says the entry is
current and the field is what gets asked.

**An automatic check never writes the top-level `last_updated` either.** That
field records the last write to the map, and readers that present it as "when
the map was last audited" would otherwise be reading a machine stamp.

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
| v5 | 2026-08-15 | `last_auto_checked` removed: field, writer and the second lock implementation that guarded its one write. Its only reader, the session brief's drift line, was removed in session 0.8.7, leaving it written by `deps-watch` and read by nothing. `deps-watch` is now read-only. In the same change, `dependents` became direct-only by definition rather than by accident, after the transitive rule sat unimplemented since v1. A pre-v5 map needs no migration: the extra field is ignored and dropped on the next `/audit-deps` write, and no `dependents` row changes meaning, since a chain-explained row is still valid. |
| v1 | 2026-04-23 | Initial schema. One map across all repositories, composite keys. |
| v2 | 2026-07-27 | The map covers anything you build, not only skills. Top-level `skills` becomes `targets`, entry and edge field `skill` becomes `target`, and `kind` is added to both. Readers map the v1 names at read time, so a v1 file keeps working until `/audit-deps` next writes. |
| v4 | 2026-08-08 | `last_auto_checked` added, so an unattended check stops overwriting a review date. `deps-watch` was stamping `last_updated` after any edit that added no new dependency, and that is the field `/audit-deps` compares against the file mtime to decide an entry is STALE. Since extraction cannot see a semantic edge, an edit that added one left the entry looking freshly reviewed and it never came up for review again. Readers of older maps need no change: the field is simply absent. |
| v3 | 2026-07-27 | Under a `plugin-repo` root the name portion of the key becomes `{plugin}/{name}`. One root holding four plugins was producing `plugins:cli` for three different files, so later entries silently overwrote earlier ones and a fix flagged the wrong plugin's dependents. Lookups fall back to a unique `/{target}` suffix match, so a pre-v3 map keeps resolving, and report an ambiguous match instead of choosing. |
