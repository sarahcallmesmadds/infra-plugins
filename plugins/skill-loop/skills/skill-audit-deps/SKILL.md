---
name: skill-audit-deps
type: human
description: Scans both skill repos, compares to DEPS.json at ~/.claude/skill-loop/, and surfaces missing (on disk but not in map), orphaned (in map but not on disk), or changed (SKILL.md newer than its DEPS.json entry's last_updated) skills. Use when you've added a skill, renamed one, or when the SessionStart brief flags DEPS.json as stale. Shows a draft of proposed changes and asks y/edit/skip before writing — never silent writes.
argument-hint: "[optional: specific skill name to review]"
allowed-tools: Read, Write, Bash(ls:*), Bash(cat:*), Bash(date:*), Bash(stat:*), Bash(mv:*), Bash(rm:*), Bash(node:*)
---

You are maintaining the skill dependency map at `~/.claude/skill-loop/DEPS.json`. The schema is documented at `reference/SCHEMA-DEPS.md` in this plugin's directory — read it if you haven't already in this session. Never silent-write; always show a draft and confirm first.


> **Paths in this file are written with `~` for readability.** The Write tool and
> Node's `fs` both take it literally, so expand it to the absolute home path
> before using it. A literal `~` creates a directory called `~` next to wherever
> you happen to be, and every check that follows then reads the wrong place.

## Step 1 — Scan every configured root for skills on disk

Skills can live in more than one place: the ones installed for daily use, and a
separate repository they are developed in. Read the roots from
`~/.claude/skill-loop.config.json`. If that file does not exist, use the single
default root:

```json
{ "skillRoots": [ { "name": "personal", "path": "~/.claude/skills" } ] }
```

For each configured root, run both listings and collect the paths:

```bash
ls -1 <root.path>/*/SKILL.md 2>/dev/null
ls -1 <root.path>/*/*/SKILL.md 2>/dev/null
```

The second listing catches repositories that nest the definition one level
deeper, as `<root>/<skill>/skill/SKILL.md`.

For each path, derive the composite key:
- `repo` = the `name` of the root the path sits under
- `skill` = the FIRST directory segment below that root, so
  `<root>/tool-renewal/skill/SKILL.md` yields skill = `tool-renewal`, not `skill`
- A path under none of the configured roots is `repo: "unknown"`. Do not guess.

Record the SKILL.md file's modification time in Unix epoch seconds. The two
`stat` implementations disagree, and using the wrong one silently returns
filesystem information rather than a timestamp:

```bash
stat -f %m <path> 2>/dev/null || stat -c %Y <path>   # BSD/macOS, then GNU/Linux
```

## Step 2 — Load the current DEPS.json

Read `~/.claude/skill-loop/DEPS.json` with the Read tool. Parse the JSON.

If the file doesn't exist or fails to parse:
> "DEPS.json doesn't exist yet (or is corrupt). I'll author the initial map covering all skills I just scanned."

Continue to Step 3 with an empty `existing_skills` object.

If it parses, extract `existing_skills = deps.skills`.

## Step 3 — Diff the disk scan against the map

Classify every skill into one of three buckets:

**MISSING** — on disk but not in `existing_skills`. These need entries added.
**ORPHANED** — in `existing_skills` but not on disk. These may have been renamed or deleted.
**EXISTING** — in both. For these, check whether the SKILL.md mtime (from Step 1 `stat`) is newer than the entry's `last_updated` field (parse both as timestamps; compare). If newer, the entry is STALE and may need re-inference of `depends_on`.

If `$ARGUMENTS` is non-empty, filter all three buckets to only skills whose name or composite key matches the argument. This lets the user say `/skill-audit-deps daily-brief` to review one skill without scanning every change.

## Step 4 — For each MISSING skill, infer its depends_on

Read the SKILL.md with the Read tool. Apply the same inference rules used during initial DEPS.json authoring (documented in SCHEMA-DEPS.md):

- Explicit slash-command invocations to other skills
- Named skill references in prose
- Shared hardcoded values (Notion DB IDs, file paths, Slack channel IDs)
- Shared semantic patterns (shared lens, shared output format) — mark `confidence: low`

Build the candidate entry with:
- `skill, repo, path` (from the scan)
- `depends_on` (inferred — may be empty)
- `dependents: []` (will be recomputed in Step 6)
- `confidence` — default `medium` unless the file gave strong signals (`high`) or you're uncertain (`low`)
- `last_updated` — current UTC ISO-8601
- `notes` — include only if directory name ≠ frontmatter `name`

## Step 5 — Show the draft to the user

Present the draft in this format (mirror /skill-flag-issue Step 2 — same tone):

```
Changes I'd make to DEPS.json:

Missing (N):
  + personal:{skill} — {one-line reason or "standalone"}
    depends_on: [{brief list}]  (confidence: {level})

Orphaned (M):
  - {composite_key} — in map but no SKILL.md found at {path}
    (renamed? deleted? moved? Tell me to remove or leave.)

Stale (K):
  ~ {composite_key} — SKILL.md mtime is newer than last_updated
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

1. For every entry in the updated `skills` object, collect its `depends_on` edges.
2. For each edge A → T, ensure `skills[T].dependents` includes `{ skill: A.skill, repo: A.repo, reason: edge.reason, confidence?: edge.confidence }`.
3. Prune `dependents` entries that no longer have a matching `depends_on` edge in the source.
4. Alphabetize the top-level `skills` keys so diffs stay clean.

## Step 7 — Atomic write (prevents corruption)

This is the critical discipline — if Claude is killed during a Write, DEPS.json must NOT be left half-written.

1. Build the final JSON string (2-space indent).
2. Write to `~/.claude/skill-loop/DEPS.json.tmp` using the Write tool.
3. Parse-check the tempfile:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync(require('os').homedir() + '/.claude/skill-loop/DEPS.json.tmp','utf8')); console.log('OK')"
   ```
   If this errors, delete the tempfile (`rm ~/.claude/skill-loop/DEPS.json.tmp`) and report failure to the user. Do NOT proceed.
4. Atomic rename (POSIX rename is atomic on the same filesystem):
   ```bash
   mv ~/.claude/skill-loop/DEPS.json.tmp ~/.claude/skill-loop/DEPS.json
   ```
5. Re-read DEPS.json and verify the entry count matches expectation.

## Step 8 — Summary message

Report to the user what changed:

> "DEPS.json updated. Added {N} missing, removed {M} orphans, reviewed {K} stale entries. Total entries: {count}."

If any low-confidence edges were added in this update, list them:

> "New low-confidence edges for your review: {list}"

## Failure handling

- If the scan (Step 1) returns zero skills from a repo, flag it — it may mean the directory path changed. Do NOT assume all those skills were deleted.
- If the atomic write fails (Step 7), the original DEPS.json is untouched. Report the failure and let the user retry.
- If the user declines to clarify an orphaned entry, LEAVE it in the map (safer — the Phase 3 updater will error loudly rather than silently) and add a note flagging the orphan for later review.
- Never rewrite existing v1 entries' `last_updated` unless their content actually changed — this keeps diffs meaningful.
