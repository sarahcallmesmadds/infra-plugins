---
name: audit-deps
type: human
description: Scans every configured root (skills, hooks, commands), compares what is on disk to DEPS.json at ~/.claude/build-loop/, and surfaces missing (on disk but not in the map), orphaned (in the map but not on disk), or changed (the file is newer than its DEPS.json entry's last_updated) entries. Use when you've added or renamed a skill, hook, or command, or when DEPS.json is flagged as stale. Shows a draft of proposed changes and asks y/edit/skip before writing — never silent writes.
argument-hint: "[optional: a specific name to review]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(stat:*), Bash(mv:*), Bash(rm:*), Bash(node:*)
---

You are maintaining the dependency map at `~/.claude/build-loop/DEPS.json`. The schema is documented at `${CLAUDE_PLUGIN_ROOT}/reference/SCHEMA-DEPS.md` — read it if you haven't already in this session. Never silent-write; always show a draft and confirm first.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

## Step 1 — Scan every configured root

The things you build live in more than one place: skills installed for daily
use, hooks the harness fires, slash commands, and any separate repository you
develop them in. Read the roots from `~/.claude/build-loop.config.json`. If that
file does not exist, use the three defaults:

```json
{ "roots": [
  { "name": "personal", "path": "~/.claude/skills",   "kind": "skill" },
  { "name": "hooks",    "path": "~/.claude/hooks",    "kind": "hook" },
  { "name": "commands", "path": "~/.claude/commands", "kind": "command" }
] }
```

A config holding `skillRoots` and no `roots` is read as roots of kind `skill`.
Do not rewrite that file. It predates schema v2 and still works.

**If none of the configured roots exist on disk**, stop before scanning and say
so, because a scan of nothing looks identical to a scan that found nothing:

> "None of the configured roots exist on this machine, so there is nothing to
> scan. If you develop plugins in a checkout, add it to
> `~/.claude/build-loop.config.json` as a root of kind `plugin-repo`."

What you list depends on the root's `kind`:

```bash
# kind: skill
ls -1 <root.path>/*/SKILL.md 2>/dev/null
ls -1 <root.path>/*/*/SKILL.md 2>/dev/null

# kind: hook
ls -1 <root.path>/* 2>/dev/null

# kind: command
ls -1 <root.path>/*.md 2>/dev/null

# kind: plugin-repo — a checkout of a marketplace repository
ls -1  <root.path>/plugins/*/skills/*/SKILL.md 2>/dev/null   # kind: skill
ls -1  <root.path>/plugins/*/hooks/*           2>/dev/null   # kind: hook
ls -1  <root.path>/plugins/*/commands/*.md     2>/dev/null   # kind: command
ls -1d <root.path>/plugins/*/                  2>/dev/null   # kind: plugin
```

The second skill listing catches repositories that nest the definition one level
deeper, as `<root>/<name>/skill/SKILL.md`.

**Never scan `~/.claude/plugins/marketplaces/`**, even if a root points there.
That tree is the plugin manager's cache, it is overwritten on every update, and
mapping it produces entries whose fixes silently disappear. Scan the checkout
the user edits.

For each path found, derive:
- `repo` = the `name` of the root the path sits under
- `kind` = the `kind` of that root. For a `plugin-repo` root, the kind comes
  from the subdirectory the file was found in, per the comments above, and never
  from the root itself.
- `target` = the name on disk. For kind `skill` that is the FIRST directory
  segment below the root, so `<root>/tool-renewal/skill/SKILL.md` gives
  `tool-renewal` and never `skill`. For kind `hook` and kind `command` it is the
  filename with its extension stripped, so `style-lint.js` gives `style-lint`.
- A path under none of the configured roots is `repo: "unknown"`. Do not guess.

**Skip these when listing a hook root**, or the map fills with things that are
not targets: anything whose name starts with a dot, `node_modules`, and any
directory that is not itself an executable hook.

Record each file's modification time in Unix epoch seconds. The two `stat`
implementations disagree, and using the wrong one silently returns filesystem
information rather than a timestamp:

```bash
stat -f %m <path> 2>/dev/null || stat -c %Y <path>   # BSD/macOS, then GNU/Linux
```

## Step 2 — Load the current DEPS.json

Read `~/.claude/build-loop/DEPS.json` with the Read tool. Parse the JSON.

If the file doesn't exist or fails to parse:
> "DEPS.json doesn't exist yet (or is corrupt). I'll author the initial map covering everything I just scanned."

Continue to Step 3 with an empty `existing` object.

If it parses, extract `existing = deps.targets`. If the file has `skills` and no
`targets`, read that instead and treat every entry's `skill` field as `target`
with `kind` defaulting to `"skill"`. That is a v1 map, and this run is what
converts it.

## Step 3 — Diff the disk scan against the map

Classify everything into one of three buckets:

**MISSING** — on disk but not in `existing`. These need entries added.
**ORPHANED** — in `existing` but not on disk. These may have been renamed or deleted.
**EXISTING** — in both. Check whether the file mtime from Step 1 is newer than the entry's `last_updated` field. Parse both as timestamps and compare. If newer, the entry is STALE and may need `depends_on` re-inferred.

If `$ARGUMENTS` is non-empty, filter all three buckets to entries whose name or composite key matches, so `/audit-deps daily-brief` reviews one thing without scanning every change.

## Step 4 — For each MISSING entry, infer its depends_on

Read the file with the Read tool. Apply the inference rules from SCHEMA-DEPS.md:

- Explicit slash-command invocations
- Named references in prose or in comments
- Shared hardcoded values: database IDs, file paths, channel IDs
- Shared semantic patterns, such as a shared lens or output format. Mark these `confidence: low`.

**Look across kinds, not only within one.** The edge most often missed is a hook
that writes a file a skill later reads, because neither file mentions the other
by name. A shared path is the signal. When a hook and a skill both name
`~/.claude/hot-cache.md`, that is an edge, and it is exactly the kind that breaks
quietly weeks later.

Build the candidate entry with:
- `target, kind, repo, path` from the scan
- `depends_on`, inferred, may be empty
- `dependents: []`, recomputed in Step 6
- `confidence`, default `medium`, `high` on strong signals, `low` when uncertain
- `last_updated`, current UTC ISO-8601
- `notes`, only when the name on disk differs from the frontmatter name

## Step 5 — Show the draft to the user

Present the draft in this format (mirror /flag-issue Step 2 — same tone):

```
Changes I'd make to DEPS.json:

Missing (N):
  + personal:{target} — {one-line reason or "standalone"}
    depends_on: [{brief list}]  (confidence: {level})

Orphaned (M):
  - {composite_key} — in map but no file found at {path}
    (renamed? deleted? moved? Tell me to remove or leave.)

Stale (K):
  ~ {composite_key} — the file mtime is newer than last_updated
    Current depends_on: [{list}]
    Re-read the file to check for new deps? (y/no)

Write these changes to DEPS.json? (y / edit / skip)
```

On the user's response:
- `y`, `yes`, `sure`, `go` — proceed to Step 6
- `edit` or specific change requests — update the draft and re-ask
- `skip`, `no` — respond "Skipped — nothing written." and stop

**Never silent writes.** Ever.

For orphaned entries specifically, ask explicitly: "Remove {composite_key} from DEPS.json, or leave it?" Default is LEAVE — do not remove unless the user confirms.

For stale entries, only re-infer if the user confirms. Otherwise just bump the entry's `last_updated` without changing `depends_on` — this acknowledges the file was inspected.

## Step 6 — Recompute dependents across the whole map

After applying the approved additions/removals/changes:

1. For every entry in the updated `targets` object, collect its `depends_on` edges.
2. For each edge A → T, ensure `targets[T].dependents` includes `{ target: A.target, kind: A.kind, repo: A.repo, reason: edge.reason, confidence?: edge.confidence }`.
3. Prune `dependents` entries that no longer have a matching `depends_on` edge in the source.
4. Alphabetize the top-level `targets` keys so diffs stay clean.

## Step 7 — Atomic write (prevents corruption)

This is the critical discipline — if Claude is killed during a Write, DEPS.json must NOT be left half-written.

1. Build the final JSON string (2-space indent).
2. Write to `~/.claude/build-loop/DEPS.json.tmp` using the Write tool.
3. Parse-check the tempfile:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/build-loop/DEPS.json.tmp','utf8')); console.log('OK')"
   ```
   If this errors, delete the tempfile (`rm ~/.claude/build-loop/DEPS.json.tmp`) and report failure to the user. Do NOT proceed.
4. Atomic rename (POSIX rename is atomic on the same filesystem):
   ```bash
   mv ~/.claude/build-loop/DEPS.json.tmp ~/.claude/build-loop/DEPS.json
   ```
5. Re-read DEPS.json and verify the entry count matches expectation.

## Step 8 — Summary message

Report to the user what changed:

> "DEPS.json updated. Added {N} missing, removed {M} orphans, reviewed {K} stale entries. Total entries: {count}."

If any low-confidence edges were added in this update, list them:

> "New low-confidence edges for your review: {list}"

## Failure handling

- If the scan in Step 1 returns nothing from a root that previously had entries, flag it. It usually means the path changed. Do NOT assume everything under it was deleted.
- If the atomic write fails (Step 7), the original DEPS.json is untouched. Report the failure and let the user retry.
- If the user declines to clarify an orphaned entry, LEAVE it in the map (safer — the Phase 3 updater will error loudly rather than silently) and add a note flagging the orphan for later review.
- Never rewrite existing v1 entries' `last_updated` unless their content actually changed — this keeps diffs meaningful.
