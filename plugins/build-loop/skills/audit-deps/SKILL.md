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

**Check the roots before scanning, and relay what it says.** The check is a
script rather than a paragraph, because the same rule has to hold in every skill
that reads this config, and six paragraphs drift where one script cannot:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" check
```

- Exit 0, every root exists. Nothing to relay, carry on.
- Exit 3, a root someone configured is gone. Print what it said, then scan the
  roots that remain.
- Exit 5, only default locations are absent. Nobody configured those paths, so
  do not lead with it and do not stop. Carry on, and mention it only if the
  scan then turns up orphans, where it is the explanation.
- Exit 4, there is nothing to scan. Print what it said and stop, because a scan
  of nothing looks identical to a scan that found nothing.
- Exit 1, the config itself could not be read. Print what it said and stop.

Every one of those messages arrives on stdout, including exit 1.

On exit 3, do not offer to remove the orphans a dead root produced. Step 3 will
bucket everything the map held under that root as ORPHANED, which reads as "these
files were deleted" when the path is what moved. Those entries are almost
certainly fine, and approving that draft throws away the map instead of fixing
the path.

What you list depends on the root's `kind`:

```bash
# kind: skill
ls -1 <root.path>/*/SKILL.md 2>/dev/null
ls -1 <root.path>/*/*/SKILL.md 2>/dev/null

# kind: hook
ls -1 <root.path>/* 2>/dev/null

# kind: command
ls -1 <root.path>/*.md 2>/dev/null

# kind: plugin-repo, a checkout of a marketplace repository.
# The listings are generated, not written here. Run this and use what it prints:
node "${CLAUDE_PLUGIN_ROOT}/scripts/roots.js" layout --root <root.path>
```

Each line it prints carries the `kind` to record for whatever that line finds.
Use those rather than deriving a kind from the path yourself.

**The list is generated because it used to be written out twice.**
`/built-check` needs the same set to search for one name, so the two skills each
carried a copy in prose. `bin/` was added to the repository on 2026-08-14 and to
neither copy, and `bin/hook-node` is the file every hook in every plugin starts
through, so the map recorded nothing depending on the most depended-on file in
the repository. The two listings that get forgotten are still the last two, and
still for opposite reasons: `statusline/` is another place a plugin keeps
executable code and a search written from the plugin template will not know it
exists, and `tests/` is at the **root of the repository and not inside any
plugin**, so every glob anchored at `plugins/*/` walks straight past it. Neither
is your problem now. Add a directory to `PLUGIN_LAYOUT` in `roots.js` and both
skills have it.

A test is a dependent like any other, and usually the most useful one in the
map: the answer to "what does this fix put at risk" is very often a file that
pins the exact sentence being edited. Give a test `kind: script`, since that is
the vocabulary the schema and the queue's `target_kind` share, and a bare key
with no plugin segment, because it sits in no plugin. Strip only the final
extension, so `built-check.test.js` gives the target `built-check.test` and
cannot collide with a plugin's own `built-check`.

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
  `tool-renewal` and never `skill`. For kind `hook`, `command` and `script` it is
  the filename with its extension stripped, so `style-lint.js` gives
  `style-lint`.
- **Under a `plugin-repo` root, the key's name portion is `{plugin}/{target}`,**
  per the Composite Key Rule in SCHEMA-DEPS.md. The `target` field itself stays
  the bare name; only the key carries the plugin. A root holding four plugins
  otherwise produced `plugins:cli` for three separate files, and `plugins:config`,
  `plugins:hook-io` and `plugins:patterns` for two each. Later entries overwrote
  earlier ones, so the map silently described the wrong file. The plugin's own
  entry keeps a bare key, `plugins:guardrails`, and cannot collide with anything
  inside it because everything inside carries a `/`.
- **`path` for a `kind: plugin` entry is the plugin's
  `.claude-plugin/plugin.json`, not the directory the glob returned.** Every
  other kind stores the file the scan found, so it is easy to store the
  directory here too and never notice. The map already held manifests, so a run
  that stores directories reports all five plugins as MISSING and the same five
  as ORPHANED in one pass: the same rows, twice, under two names. Nothing errors,
  and approving that draft doubles every plugin row. A directory is also not
  something `/apply-fix` can open, so the entry has to name a file to be worth
  anything.
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

Classify everything into one of four buckets:

**MISSING** — on disk but not in `existing`. These need entries added.
**ORPHANED** — in `existing` but not on disk. These may have been renamed or deleted.
**EXISTING** — in both. Check whether the file mtime from Step 1 is newer than the entry's `last_updated` field. Parse both as timestamps and compare. If newer, the entry is STALE and may need `depends_on` re-inferred.
**ONE-SIDED** — a `dependents` row on entry T naming A, where **A has no `depends_on` path to T at all**, neither directly nor through other entries. This one is about the map's internal consistency rather than about disk, so it is computed from `existing` alone and needs no file to have changed.

**A missing direct edge is not the test, and using it as the test is wrong.** SCHEMA-DEPS.md tracks transitive dependencies on purpose: if A depends on B and B depends on C, A appears in C's `dependents`. A's `depends_on` correctly names B and not C, so every transitive back-edge in a healthy map looks unmatched if you only compare direct edges. Counting those inflates the bucket with rows that are already right, and `add-missing` would then write a direct A → C edge the schema does not intend, turning a correct indirect relationship into a fabricated direct one.

So follow the forward edges. Take the entry named in the `dependents` row, walk its `depends_on` transitively, and if T is reachable the row is explained and belongs in no bucket. Only a row with no path at all is one-sided.

Measured against the live map on 2026-08-11: 249 `dependents` rows, 147 matched by a direct edge, 3 explained only transitively, 99 genuinely unexplained. Three is small here, and it is three rows this skill would otherwise have reported as broken and offered to "repair" by inventing an edge.

Work ONE-SIDED out here, not later. Step 6 is where the decision is applied, but it is the last approval gate in the skill and Step 5 is the only one, so a bucket discovered after Step 5 would mean asking the user a second question about a write they already approved. Anything the user has to decide is decided in one place.

A few will resolve themselves: if Step 4 infers a `depends_on` that happens to mirror a one-sided row, the pair is whole and it leaves the bucket. Recheck against the final map in Step 6 and say how many resolved rather than carrying the Step 3 number through.

**Compare against `last_updated`, never `last_auto_checked`.** The second is written by the `deps-watch` hook after an ordinary edit, and it means only that every reference the file mechanically makes was already recorded. It cannot see a semantic edge, one thing reading a file another writes, which is the kind this map exists to catch. Treating it as a review date would empty this bucket of exactly the entries that most need looking at. Carry the field through unchanged on write; it is not yours to set.

If `$ARGUMENTS` is non-empty, filter **all four buckets** to entries whose name or composite key matches, so `/audit-deps daily-brief` reviews one thing without scanning every change.

ONE-SIDED needs saying explicitly, because it is the one bucket that does not come from the disk scan. It is computed across every entry in the map, so left unfiltered it flows into the draft and the apply regardless of the argument, and a user who scoped the audit to one target is shown, and can approve, removals on entries they never named. Filter it on the entry the row sits on and on the entry it names: a row is in scope if either end matches.

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
- `target, kind, repo, path` from the scan, plus **`plugin` when the root is a
  `plugin-repo`**. `target` stays bare and `plugin` sits beside it, matching the
  edge format. Storing the plugin only inside the composite key is not enough:
  Step 6 builds back-edges by reading fields off an entry, and a field that only
  exists in the key reads as nothing.
- `depends_on`, inferred, may be empty. **Each edge carries a bare `target` plus
  a separate `plugin` field when the root is a `plugin-repo`**, per the
  Dependency Edge Format in SCHEMA-DEPS.md. Write `{"target": "hook-io",
  "plugin": "guardrails", ...}` and never `{"target": "guardrails/hook-io"}`.
  Both halves are needed and they are needed by different readers: the key wants
  the plugin, and `/flag-issue` copies `target` straight into a queue entry,
  where it has to be a name that resolves to a file on disk. Nothing on disk is
  called `guardrails/hook-io`.
- `dependents: []`, recomputed in Step 6
- `confidence`, default `medium`, `high` on strong signals, `low` when uncertain
- `last_updated`, current UTC ISO-8601
- `notes`, only when the name on disk differs from the frontmatter name

## Step 5 — Show the draft to the user

Present the draft in this format (mirror /flag-issue Step 2 — same tone):

```
Changes I'd make to DEPS.json:

Missing (N):
  + personal:{target} - {one-line reason or "standalone"}
    depends_on: [{brief list}]  (confidence: {level})

Orphaned (M):
  - {composite_key} - in map but no file found at {path}
    (renamed? deleted? moved? Tell me to remove or leave.)

Stale (K):
  ~ {composite_key} - the file mtime is newer than last_updated
    Current depends_on: [{list}]
    Re-read the file to check for new deps? (y/no)
    Declining leaves them exactly as they are. Nothing is stamped as reviewed.

One-sided (J of {total} dependents rows, {percent}%):
  ! {composite_key} <- {dependent}
    recorded as a dependent, but {dependent} has no depends_on pointing back

  Only half of each relationship is written down. Removing them deletes the
  only record; adding the missing depends_on keeps it.
  keep / add-missing / remove?   Default: keep.

Write these changes to DEPS.json? (y / edit / skip)
```

Show the percentage whenever One-sided is more than a tenth of all `dependents` rows. A step that removes a large share of the map has to say so, in the place the user is deciding.

On the user's response:
- `y`, `yes`, `sure`, `go` — proceed to Step 6
- `edit` or specific change requests — update the draft and re-ask
- `skip`, `no` — respond "Skipped, nothing written." and stop

**Never silent writes.** Ever.

For orphaned entries specifically, ask explicitly: "Remove {composite_key} from DEPS.json, or leave it?" Default is LEAVE — do not remove unless the user confirms.

For stale entries, only re-infer if the user confirms. **If they decline, leave `last_updated` alone.**

This used to say to bump it anyway, to acknowledge the file was inspected. Nothing inspected it. SCHEMA-DEPS.md defines `last_updated` as the date the edges were judged correct by a person or by this skill, and v4 added `last_auto_checked` precisely so an unattended check would stop writing into that field. Stamping it after a version bump records a review that did not happen, and since it is also what this skill compares against the file mtime, the entry then never comes up for review again.

It is the same fault v4 was written to fix, reappearing in the skill instead of the hook. On 2026-08-11 following it would have marked 64 entries reviewed because a rename changed a URL string in them.

Say what was skipped instead:

```
Stale (64): left alone. Re-inferring these means reading 64 files, so say
which ones you want. Nothing was stamped as reviewed.
```

## Step 6 — Recompute dependents across the whole map

After applying the approved additions/removals/changes:

1. For every entry in the updated `targets` object, collect its `depends_on` edges.
2. For each edge A → T, ensure `targets[T].dependents` includes `{ target: A.target, plugin: A.plugin, kind: A.kind, repo: A.repo, reason: edge.reason, confidence?: edge.confidence }`.

   `A.plugin` is a field on the entry, written in Step 4. It is not derived here and it is not parsed out of A's key. If an older entry has no `plugin` but its key carries one, take the plugin from the key rather than dropping it, because a dependent with no plugin is ambiguous the moment two plugins share a name. Omit the field entirely, never `null`, when A genuinely is not inside a plugin.

   Resolve T to its entry using the ordered lookup in SCHEMA-DEPS.md rather than string-matching the key, so an edge written before v3 still finds its target.
3. **Collect, do not delete, every `dependents` entry with no matching `depends_on` edge.** Adding a back-edge is safe and needs no permission. Removing one destroys the only copy of a relationship somebody wrote down, so it goes through the user like every other removal in this skill.

   This step used to say "prune" and nothing else. Measured against the live map on 2026-08-11, following it removed **99 of 249** back-edges in one pass, 40 percent, and almost all of them were test coverage links of the shape `guardrails/bash-guard <- bash-guard.test`. Those are the rows that answer "what does this fix put at risk", which is the question the map exists for. Nothing errored. The file came back smaller, `/apply-fix` reported fewer dependents than it should, and everything looked healthy.

   It would also have taken 3 more that are not one-sided at all, being explained by a transitive chain. Those are the rows the definition in Step 3 now excludes.

   A one-sided edge is usually a **missing `depends_on`, not a stale dependent.** `run-all` lists every test as a dependent while its own `depends_on` is empty, and the relationship is real either way. Deleting the only record of it is the one option that loses information.

   **Do not ask here.** The ONE-SIDED bucket was worked out in Step 3 and put to the user in Step 5, along with everything else they approved. Apply the answer they already gave:

   - `keep`, and the default on no answer: leave them exactly as they are.
   - `add-missing`: write the mirroring `depends_on` onto the source entry so the pair is whole, carrying the reason across.
   - `remove`: prune, having been told to.

   Recheck the bucket against the final map before acting. A `depends_on` inferred in Step 4 can mirror a one-sided row and make it whole on its own, so a row that resolved that way is no longer anybody's decision. Carry the count that survives, not the Step 3 count, and report both in Step 8.

   **Never prune without an explicit `remove`.** There is no path through this skill where back-edges disappear without the user having read a count and chosen.

4. Alphabetize the top-level `targets` keys so diffs stay clean.

## Step 7 — Atomic write (prevents corruption)

This is the critical discipline — if Claude is killed during a Write, DEPS.json must NOT be left half-written.

0. Set `$schema_version` to the version SCHEMA-DEPS.md declares as current, and set the top-level `last_updated` to now.

   This skill is the only thing that rewrites the whole map, so it is the only place the version can be stamped. Without this step the field was documentation-only: the schema said 4 while every map on disk said 3, and the schema's own rule to bump it in `DEPS.json` in the same commit could not be satisfied by any shipped code path. Readers here are version-agnostic, so this is not urgent, but a version field nothing maintains is worse than none: it looks like a migration signal and never moves.

   Never write `last_auto_checked` here. That one belongs to the hook.

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

Report what the run did, and only that. Every clause here is a claim somebody will act on, so a line describing work that did not happen is the same false reassurance this skill exists to remove from the map.

> "DEPS.json updated. Added {N} missing, removed {M} orphans, re-inferred {K} stale entries. Total entries: {count}."

**`{K}` counts entries whose `depends_on` was actually re-read, not entries considered.** The summary used to say "reviewed {K} stale entries" while Step 5 was leaving declined ones untouched, so a run that read nothing still reported K reviews. Where the user declined, say so instead and give the number:

> "{S} stale entries left alone. Nothing was stamped as reviewed."

Report the one-sided bucket too, whichever way it went. Silence there reads as "there were none", which is a different fact:

> "One-sided dependents: {J} kept." / "{J} repaired by adding the missing depends_on." / "{J} removed, as asked."

If any resolved on their own because Step 4 inferred the mirroring edge, say that separately rather than folding it into the kept count:

> "{R} resolved on their own once the new edges were added."

If any low-confidence edges were added in this update, list them:

> "New low-confidence edges for your review: {list}"

Nothing in this summary is optional because the number is zero. "0 removed" and no line at all look identical in a transcript and mean different things.

## Failure handling

- If the scan in Step 1 returns nothing from a root that previously had entries, flag it. It usually means the path changed. Do NOT assume everything under it was deleted.
- If the atomic write fails (Step 7), the original DEPS.json is untouched. Report the failure and let the user retry.
- If the user declines to clarify an orphaned entry, LEAVE it in the map (safer — the Phase 3 updater will error loudly rather than silently) and add a note flagging the orphan for later review.
- Never rewrite existing v1 entries' `last_updated` unless their content actually changed — this keeps diffs meaningful.
